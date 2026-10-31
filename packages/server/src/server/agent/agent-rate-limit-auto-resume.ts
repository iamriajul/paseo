import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { formatSystemNotificationPrompt } from "./agent-messages/index.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { isRateLimitAutoResumeDisabled } from "@getpaseo/protocol/agent-labels";
import type { AgentRateLimitCooldownPayload } from "@getpaseo/protocol/messages";

export const DEFAULT_RATE_LIMIT_AUTO_RESUME_PROMPT = "Resume - rate limit cooldown has ended";
export const RATE_LIMIT_AUTO_RESUME_PENDING_FILE = "pending-rate-limit-auto-resumes.json";
export const MAX_CONSECUTIVE_AUTO_RESUMES = 10;

export const RATE_LIMIT_ERROR_HEURISTIC =
  /(?:429|rate[_\s-]?limit|cooldown|cooling down|quota|too many requests)/i;

export type RateLimitResumeTriggerResult = { resumed: true } | { resumed: false; reason: string };

// Matches RETRY_AFTER:YYYY-MM-DDTHH:MM:SSZ or with fractional seconds (.123Z)
// Allows preceding whitespace/brackets/quotes/start, optional space after colon, and trailing boundaries.
export const RETRY_AFTER_PATTERN =
  /(?:^|[\s"'([<{])RETRY_AFTER:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?=[^\w]|$)/i;

export function extractRetryAfterTimestamp(text: string | null | undefined): Date | null {
  if (!text) return null;
  const match = text.match(RETRY_AFTER_PATTERN);
  if (!match) return null;
  const parsed = new Date(match[1]);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

const PendingRateLimitRecordSchema = z.object({
  agentId: z.string(),
  scheduledFor: z.string(),
  retryAfter: z.string(),
  createdAt: z.string(),
});

export type PendingRateLimitRecord = z.infer<typeof PendingRateLimitRecordSchema>;

const PendingRateLimitFileSchema = z.array(PendingRateLimitRecordSchema);

export function getPendingRateLimitPath(paseoHome: string): string {
  return path.join(paseoHome, RATE_LIMIT_AUTO_RESUME_PENDING_FILE);
}

export async function readPendingRateLimitRecords(
  paseoHome: string,
  logger?: Pick<Logger, "warn">,
): Promise<PendingRateLimitRecord[]> {
  const filePath = getPendingRateLimitPath(paseoHome);
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    const result = PendingRateLimitFileSchema.safeParse(parsed);
    if (!result.success) {
      logger?.warn?.(
        { err: result.error, filePath },
        "Invalid pending rate limit auto-resume file, ignoring",
      );
      return [];
    }
    return result.data;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    logger?.warn?.({ err: error, filePath }, "Failed to read pending rate limit auto-resume file");
    return [];
  }
}

export async function writePendingRateLimitRecords(
  paseoHome: string,
  records: PendingRateLimitRecord[],
  logger?: Pick<Logger, "warn" | "info">,
): Promise<void> {
  const filePath = getPendingRateLimitPath(paseoHome);
  if (records.length === 0) {
    try {
      await fs.rm(filePath, { force: true });
    } catch (error) {
      logger?.warn?.(
        { err: error, filePath },
        "Failed to clear pending rate limit auto-resume file",
      );
    }
    return;
  }
  try {
    await writeJsonFileAtomic(filePath, records);
  } catch (error) {
    logger?.warn?.({ err: error, filePath }, "Failed to write pending rate limit auto-resume file");
  }
}

interface ActiveTimerEntry {
  timeout: NodeJS.Timeout;
  scheduledFor: Date;
  retryAfter: string;
}

export interface AgentRateLimitAutoResumeManagerDependencies {
  paseoHome: string;
  agentManager: Pick<AgentManager, "appendTimelineItem" | "getAgent"> & {
    hasInFlightRun?: (agentId: string) => boolean;
    setRateLimitCooldown?: (
      agentId: string,
      cooldown: AgentRateLimitCooldownPayload | null,
    ) => void;
  };
  agentStorage: AgentStorage;
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  logger: Logger;
  sendPrompt?: typeof sendPromptToAgent;
}

export class AgentRateLimitAutoResumeManager {
  private readonly paseoHome: string;
  private readonly agentManager: AgentRateLimitAutoResumeManagerDependencies["agentManager"];
  private readonly agentStorage: AgentStorage;
  private readonly daemonConfigStore: Pick<DaemonConfigStore, "get">;
  private readonly logger: Logger;
  private readonly send: typeof sendPromptToAgent;
  private readonly activeTimers = new Map<string, ActiveTimerEntry>();
  private readonly agentEpochs = new Map<string, number>();
  private readonly consecutiveResumes = new Map<string, number>();
  private persistenceChain = Promise.resolve();

  constructor(dependencies: AgentRateLimitAutoResumeManagerDependencies) {
    this.paseoHome = dependencies.paseoHome;
    this.agentManager = dependencies.agentManager;
    this.agentStorage = dependencies.agentStorage;
    this.daemonConfigStore = dependencies.daemonConfigStore;
    this.logger = dependencies.logger;
    this.send = dependencies.sendPrompt ?? sendPromptToAgent;
  }

  private nextEpoch(agentId: string): number {
    const next = (this.agentEpochs.get(agentId) ?? 0) + 1;
    this.agentEpochs.set(agentId, next);
    return next;
  }

  resetConsecutiveResumes(agentId: string): void {
    this.consecutiveResumes.delete(agentId);
  }

  getConsecutiveResumes(agentId: string): number {
    return this.consecutiveResumes.get(agentId) ?? 0;
  }

  hasPending(agentId: string): boolean {
    return this.activeTimers.has(agentId);
  }

  getPending(agentId: string): { scheduledFor: Date; retryAfter: string } | null {
    const entry = this.activeTimers.get(agentId);
    if (!entry) return null;
    return { scheduledFor: entry.scheduledFor, retryAfter: entry.retryAfter };
  }

  isEnabledForAgent(agentId: string): boolean {
    const globalConfig = this.daemonConfigStore.get();
    if (globalConfig.autoResumeOnRateLimit === false) {
      return false;
    }
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || agent.lifecycle === "closed") {
      return false;
    }
    if (isRateLimitAutoResumeDisabled(agent.labels)) {
      return false;
    }
    return true;
  }

  scheduleIfNeeded(agentId: string, text: string | null | undefined): boolean {
    if (!text || !RATE_LIMIT_ERROR_HEURISTIC.test(text)) {
      return false;
    }
    const retryDate = extractRetryAfterTimestamp(text);
    if (!retryDate) {
      return false;
    }
    if (!this.isEnabledForAgent(agentId)) {
      this.logger.debug(
        { agentId },
        "Skipping rate limit auto-resume: disabled globally or for agent",
      );
      return false;
    }

    const iso = retryDate.toISOString();
    const now = Date.now();
    if (retryDate.getTime() <= now) {
      this.logger.debug(
        { agentId, scheduledFor: iso },
        "Skipping rate limit auto-resume: timestamp is not in the future",
      );
      return false;
    }

    this.cancelTimerOnly(agentId);
    const scheduledEpoch = this.nextEpoch(agentId);
    const delayMs = retryDate.getTime() - now;
    this.logger.info(
      { agentId, scheduledFor: iso, delayMs },
      "Scheduling auto-resume after rate limit cooldown",
    );

    const timeout = setTimeout(() => {
      void this.triggerResume(agentId, scheduledEpoch);
    }, delayMs);
    timeout.unref?.();

    this.activeTimers.set(agentId, {
      timeout,
      scheduledFor: retryDate,
      retryAfter: iso,
    });

    this.agentManager.setRateLimitCooldown?.(agentId, {
      scheduledFor: iso,
      retryAfter: iso,
      consecutiveResumes: this.consecutiveResumes.get(agentId) ?? 0,
    });

    void this.persistActiveTimers();
    return true;
  }

  cancel(agentId: string): void {
    this.nextEpoch(agentId);
    this.agentManager.setRateLimitCooldown?.(agentId, null);
    if (!this.activeTimers.has(agentId)) return;
    this.cancelTimerOnly(agentId);
    void this.persistActiveTimers();
    this.logger.debug({ agentId }, "Canceled pending rate limit auto-resume");
  }

  cancelAll(): void {
    for (const [agentId, entry] of this.activeTimers.entries()) {
      clearTimeout(entry.timeout);
      this.agentManager.setRateLimitCooldown?.(agentId, null);
    }
    this.activeTimers.clear();
    for (const agentId of this.agentEpochs.keys()) {
      this.nextEpoch(agentId);
    }
    void this.persistActiveTimers();
  }

  private cancelTimerOnly(agentId: string): void {
    const existing = this.activeTimers.get(agentId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.activeTimers.delete(agentId);
    }
  }

  waitForPersistence(): Promise<void> {
    return this.persistenceChain;
  }

  private async persistActiveTimers(): Promise<void> {
    const records: PendingRateLimitRecord[] = [];
    for (const [agentId, entry] of this.activeTimers.entries()) {
      records.push({
        agentId,
        scheduledFor: entry.scheduledFor.toISOString(),
        retryAfter: entry.retryAfter,
        createdAt: new Date().toISOString(),
      });
    }
    this.persistenceChain = this.persistenceChain
      .then(async () => {
        await writePendingRateLimitRecords(this.paseoHome, records, this.logger);
        return undefined;
      })
      .catch((err) => {
        this.logger.warn({ err }, "Failed in persistenceChain");
        return undefined;
      });
    await this.persistenceChain;
  }

  async triggerResume(
    agentId: string,
    expectedEpoch?: number,
  ): Promise<RateLimitResumeTriggerResult> {
    this.cancelTimerOnly(agentId);
    this.agentManager.setRateLimitCooldown?.(agentId, null);
    void this.persistActiveTimers();

    if (expectedEpoch !== undefined && this.agentEpochs.get(agentId) !== expectedEpoch) {
      this.logger.debug(
        { agentId },
        "Rate limit auto-resume aborted: epoch moved before execution",
      );
      return { resumed: false, reason: "Resume superseded by another turn" };
    }

    if (!this.isEnabledForAgent(agentId)) {
      this.logger.info(
        { agentId },
        "Rate limit auto-resume aborted: no longer enabled or agent archived",
      );
      return { resumed: false, reason: "Rate limit auto-resume is disabled or agent is archived" };
    }

    const agent = this.agentManager.getAgent(agentId);
    if (!agent || agent.lifecycle === "closed") {
      return { resumed: false, reason: "Agent is closed" };
    }
    const stored = await this.agentStorage.get(agentId);
    if (stored?.archivedAt) {
      return { resumed: false, reason: "Agent is archived" };
    }

    const consecutiveCount = (this.consecutiveResumes.get(agentId) ?? 0) + 1;
    this.consecutiveResumes.set(agentId, consecutiveCount);
    if (consecutiveCount > MAX_CONSECUTIVE_AUTO_RESUMES) {
      this.logger.warn(
        { agentId, consecutiveCount },
        "Rate limit auto-resume aborted: exceeded maximum consecutive auto-resumes",
      );
      return {
        resumed: false,
        reason: `Maximum consecutive auto-resumes (${MAX_CONSECUTIVE_AUTO_RESUMES}) exceeded`,
      };
    }

    this.logger.info({ agentId }, "Executing auto-resume after rate limit cooldown");
    try {
      await ensureAgentLoaded(agentId, {
        agentManager: this.agentManager as unknown as AgentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      });

      if (expectedEpoch !== undefined && this.agentEpochs.get(agentId) !== expectedEpoch) {
        this.logger.debug(
          { agentId },
          "Rate limit auto-resume aborted: epoch moved during loading",
        );
        return { resumed: false, reason: "Resume superseded by another turn" };
      }

      if (this.agentManager.hasInFlightRun?.(agentId)) {
        this.logger.info(
          { agentId },
          "Rate limit auto-resume aborted: agent already has an in-flight run",
        );
        return { resumed: false, reason: "Agent already has an active in-flight run" };
      }

      await this.agentManager.appendTimelineItem(agentId, {
        type: "resume",
        reason: "rate_limit_retry",
      });

      await this.send({
        agentManager: this.agentManager as unknown as AgentManager,
        agentStorage: this.agentStorage,
        agentId,
        prompt: formatSystemNotificationPrompt(DEFAULT_RATE_LIMIT_AUTO_RESUME_PROMPT),
        logger: this.logger,
        unarchive: false,
      });

      this.logger.info({ agentId }, "Rate limit auto-resume continuation dispatched successfully");
      return { resumed: true };
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to execute rate limit auto-resume");
      return {
        resumed: false,
        reason: (error as Error).message || "Failed to execute resume prompt",
      };
    }
  }

  async restorePendingTimers(): Promise<void> {
    const records = await readPendingRateLimitRecords(this.paseoHome, this.logger);
    if (records.length === 0) return;

    const globalConfig = this.daemonConfigStore.get();
    if (globalConfig.autoResumeOnRateLimit === false) {
      return;
    }

    const now = Date.now();
    for (const record of records) {
      const stored = await this.agentStorage.get(record.agentId);
      if (!stored || stored.archivedAt) {
        continue;
      }
      if (isRateLimitAutoResumeDisabled(stored.labels)) {
        continue;
      }
      const targetDate = new Date(record.scheduledFor);
      if (Number.isNaN(targetDate.getTime())) {
        continue;
      }

      if (targetDate.getTime() > now && !this.activeTimers.has(record.agentId)) {
        const delayMs = targetDate.getTime() - now;
        this.logger.info(
          { agentId: record.agentId, scheduledFor: record.scheduledFor, delayMs },
          "Restoring rate limit auto-resume timer",
        );
        const scheduledEpoch = this.nextEpoch(record.agentId);
        const timeout = setTimeout(() => {
          void this.triggerResume(record.agentId, scheduledEpoch);
        }, delayMs);
        timeout.unref?.();

        this.activeTimers.set(record.agentId, {
          timeout,
          scheduledFor: targetDate,
          retryAfter: record.retryAfter,
        });

        this.agentManager.setRateLimitCooldown?.(record.agentId, {
          scheduledFor: targetDate.toISOString(),
          retryAfter: record.retryAfter,
        });
      }
    }
  }

  async bootstrap(): Promise<void> {
    const records = await readPendingRateLimitRecords(this.paseoHome, this.logger);
    if (records.length === 0) return;

    this.logger.info(
      { count: records.length },
      "Processing pending rate limit auto-resume timers after restart",
    );

    const now = Date.now();
    const globalConfig = this.daemonConfigStore.get();
    if (globalConfig.autoResumeOnRateLimit === false) {
      return;
    }

    for (const record of records) {
      const stored = await this.agentStorage.get(record.agentId);
      if (!stored || stored.archivedAt) {
        continue;
      }
      if (isRateLimitAutoResumeDisabled(stored.labels)) {
        continue;
      }
      const targetDate = new Date(record.scheduledFor);
      if (Number.isNaN(targetDate.getTime())) {
        continue;
      }

      if (targetDate.getTime() <= now) {
        // Cooldown expired while daemon was down -> trigger immediately
        this.logger.info(
          { agentId: record.agentId, scheduledFor: record.scheduledFor },
          "Rate limit cooldown expired during downtime, triggering immediate resume",
        );
        await this.triggerResume(record.agentId);
      } else if (!this.activeTimers.has(record.agentId)) {
        const delayMs = targetDate.getTime() - now;
        this.logger.info(
          { agentId: record.agentId, scheduledFor: record.scheduledFor, delayMs },
          "Rescheduling rate limit auto-resume timer after restart",
        );
        const scheduledEpoch = this.nextEpoch(record.agentId);
        const timeout = setTimeout(() => {
          void this.triggerResume(record.agentId, scheduledEpoch);
        }, delayMs);
        timeout.unref?.();

        this.activeTimers.set(record.agentId, {
          timeout,
          scheduledFor: targetDate,
          retryAfter: record.retryAfter,
        });

        this.agentManager.setRateLimitCooldown?.(record.agentId, {
          scheduledFor: targetDate.toISOString(),
          retryAfter: record.retryAfter,
        });
      }
    }

    void this.persistActiveTimers();
  }
}
