import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import {
  CLIENT_SHUTDOWN_RPC_REASON,
  DEFAULT_CLIENT_RESTART_RPC_REASON,
} from "../lifecycle-reasons.js";

export const DEFAULT_AUTO_RESUME_PROMPT = "Resume - there was a power cut";
export const AUTO_RESUME_PENDING_FILE = "pending-auto-resume.json";

const PendingAutoResumeSchema = z.object({
  agentIds: z.array(z.string()),
  capturedAt: z.string(),
  reason: z.string().optional(),
});

export type PendingAutoResumeRecord = z.infer<typeof PendingAutoResumeSchema>;

export function getPendingAutoResumePath(paseoHome: string): string {
  return path.join(paseoHome, AUTO_RESUME_PENDING_FILE);
}

export async function writePendingAutoResume(
  paseoHome: string,
  agentIds: string[],
  logger?: Pick<Logger, "warn" | "info">,
  reason = "daemon_shutdown",
): Promise<void> {
  const filePath = getPendingAutoResumePath(paseoHome);
  if (agentIds.length === 0) {
    await clearPendingAutoResume(paseoHome, logger);
    return;
  }
  const record: PendingAutoResumeRecord = {
    agentIds: Array.from(new Set(agentIds)),
    capturedAt: new Date().toISOString(),
    reason,
  };
  try {
    await writeJsonFileAtomic(filePath, record);
    logger?.info?.(
      { agentIds: record.agentIds, filePath },
      "Captured pending auto-resume agents before shutdown",
    );
  } catch (error) {
    logger?.warn?.({ err: error, filePath }, "Failed to write pending auto-resume file");
  }
}

export async function readPendingAutoResume(
  paseoHome: string,
  logger?: Pick<Logger, "warn">,
): Promise<string[] | null> {
  const record = await readPendingAutoResumeRecord(paseoHome, logger);
  return record?.agentIds ?? null;
}

export async function readPendingAutoResumeRecord(
  paseoHome: string,
  logger?: Pick<Logger, "warn">,
): Promise<PendingAutoResumeRecord | null> {
  const filePath = getPendingAutoResumePath(paseoHome);
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    const result = PendingAutoResumeSchema.safeParse(parsed);
    if (!result.success) {
      logger?.warn?.({ err: result.error, filePath }, "Invalid pending auto-resume file, ignoring");
      return null;
    }
    return result.data;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    logger?.warn?.({ err: error, filePath }, "Failed to read pending auto-resume file");
    return null;
  }
}

function isIntentionalShutdownReason(reason: string | undefined): boolean {
  return reason === CLIENT_SHUTDOWN_RPC_REASON || reason === DEFAULT_CLIENT_RESTART_RPC_REASON;
}

export async function clearPendingAutoResume(
  paseoHome: string,
  logger?: Pick<Logger, "warn">,
): Promise<void> {
  const filePath = getPendingAutoResumePath(paseoHome);
  try {
    await fs.rm(filePath, { force: true });
  } catch (error) {
    logger?.warn?.({ err: error, filePath }, "Failed to clear pending auto-resume file");
  }
}

const RESUMABLE_PERSISTED_STATUSES: ReadonlySet<StoredAgentRecord["lastStatus"]> = new Set([
  "running",
  "initializing",
]);

function isResumablePersistedRecord(record: StoredAgentRecord): boolean {
  if (record.archivedAt) return false;
  if (record.internal) return false;
  if (!RESUMABLE_PERSISTED_STATUSES.has(record.lastStatus)) return false;
  return true;
}

export async function captureRunningAgentsForShutdown(
  paseoHome: string,
  agentManager: Pick<AgentManager, "listAgents">,
  logger: Logger,
  reason = "daemon_shutdown",
): Promise<void> {
  // Intentional daemon stop/restart via `paseo daemon stop|restart` (client_shutdown_rpc)
  // must not resume on next boot – user explicitly stopped the daemon.
  // Only unexpected shutdowns (SIGTERM/SIGINT from OS/UPS/powercut) should resume.
  if (isIntentionalShutdownReason(reason)) {
    await clearPendingAutoResume(paseoHome, logger);
    logger.info({ reason }, "Skipping auto-resume capture for intentional daemon shutdown");
    return;
  }

  const runningAgents = agentManager
    .listAgents()
    .filter((agent) =>
      RESUMABLE_PERSISTED_STATUSES.has(agent.lifecycle as StoredAgentRecord["lastStatus"]),
    )
    .filter((agent) => !agent.internal)
    .map((agent) => agent.id);

  await writePendingAutoResume(paseoHome, runningAgents, logger, reason);
}

export interface AutoResumeOptions {
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  enabled?: boolean;
  prompt?: string;
  maxConcurrency?: number;
  sendPrompt?: typeof sendPromptToAgent;
}

export interface AutoResumeResult {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

// eslint-disable-next-line complexity
export async function autoResumeRunningAgents(
  options: AutoResumeOptions,
): Promise<AutoResumeResult> {
  const { paseoHome, agentManager, agentStorage, logger, sendPrompt } = options;
  const send = sendPrompt ?? sendPromptToAgent;
  const enabled = options.enabled ?? true;
  const prompt = options.prompt?.trim() ? options.prompt.trim() : DEFAULT_AUTO_RESUME_PROMPT;
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 5);

  if (!enabled) {
    logger.info("Auto-resume for running agents is disabled; clearing pending file");
    await clearPendingAutoResume(paseoHome, logger);
    return { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  const pendingRecord = await readPendingAutoResumeRecord(paseoHome, logger);
  if (pendingRecord && isIntentionalShutdownReason(pendingRecord.reason)) {
    logger.info(
      { reason: pendingRecord.reason },
      "Skipping auto-resume: last shutdown was intentional (daemon stop/restart)",
    );
    await clearPendingAutoResume(paseoHome, logger);
    return { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  }
  const pendingIds = pendingRecord?.agentIds ?? [];
  let persistedRecords: StoredAgentRecord[] = [];
  try {
    persistedRecords = await agentStorage.list();
  } catch (error) {
    logger.warn({ err: error }, "Failed to list persisted agents for auto-resume");
  }

  const resumableFromStorage = persistedRecords.filter(isResumablePersistedRecord).map((r) => r.id);

  const allIdsSet = new Set<string>([...pendingIds, ...resumableFromStorage]);
  // Filter to those where record actually exists and is not archived/internal
  const candidateIds: string[] = [];
  let skipped = 0;
  for (const id of allIdsSet) {
    const record = persistedRecords.find((r) => r.id === id) ?? (await agentStorage.get(id));
    // If record not found in list but exists via get (in case list was stale due to pending ids closed status),
    // we need to check that case. Prefer reading directly if not in list.
    let rec = record ?? null;
    if (!record) {
      try {
        rec = await agentStorage.get(id);
      } catch {
        rec = null;
      }
    }
    if (!rec) {
      skipped++;
      logger.warn({ agentId: id }, "Skipping auto-resume for missing agent record");
      continue;
    }
    if (rec.archivedAt) {
      skipped++;
      continue;
    }
    if (rec.internal) {
      skipped++;
      continue;
    }
    // For pending ids, allow even if lastStatus is now closed (graceful shutdown case).
    // For storage ids, we already filtered to resumable. For pending ids that are not resumable,
    // verify they were actually resumable before shutdown OR still resumable now.
    // If pending id has lastStatus not resumable and not in resumable set, it still came from live running capture,
    // so we should allow it. Only skip if we know it wasn't supposed to be resumed and it's not running now.
    // Simpler: if id came from pending list, allow it regardless of lastStatus (as long as not archived/internal).
    // If id came only from storage, it is already resumable.
    candidateIds.push(id);
  }

  if (candidateIds.length === 0) {
    logger.info("No running agents require auto-resume after restart");
    await clearPendingAutoResume(paseoHome, logger);
    return { attempted: 0, succeeded: 0, failed: 0, skipped };
  }

  logger.info({ agentIds: candidateIds, prompt }, "Auto-resuming running agents after restart");

  let succeeded = 0;
  let failed = 0;

  // Process in batches to limit concurrency without extra deps
  for (let i = 0; i < candidateIds.length; i += maxConcurrency) {
    const batch = candidateIds.slice(i, i + maxConcurrency);
    const results = await Promise.allSettled(
      batch.map(async (agentId) => {
        try {
          await send({
            agentManager,
            agentStorage,
            agentId,
            prompt,
            logger,
            unarchive: false,
          });
          logger.info({ agentId }, "Auto-resume prompt sent");
          return true;
        } catch (error) {
          logger.warn({ err: error, agentId }, "Failed to auto-resume agent");
          throw error;
        }
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") succeeded++;
      else failed++;
    }
  }

  await clearPendingAutoResume(paseoHome, logger);

  logger.info(
    { attempted: candidateIds.length, succeeded, failed, skipped },
    "Auto-resume for running agents completed",
  );

  return { attempted: candidateIds.length, succeeded, failed, skipped };
}
