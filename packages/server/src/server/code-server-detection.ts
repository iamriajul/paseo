import { execFileSync } from "node:child_process";

const CODE_SERVER_DETECTION_TIMEOUT_MS = 500;

export interface CodeServerUrlOpeners {
  localhostUrl?: string;
  externalUrl?: string;
}

interface ExecFileSyncLike {
  (
    file: string,
    args?: readonly string[],
    options?: { timeout?: number; encoding?: "utf8" },
  ): string | Buffer;
}

interface CodeServerProcessEntry {
  pid: number | null;
  command: string;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCodeServerExternalUrl(value: string | undefined): string | null {
  const trimmed = trimNonEmpty(value);
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function parsePort(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function parsePortFromBindAddress(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const bracketed = value.match(/^\[[^\]]+]:(\d+)$/);
  if (bracketed) {
    return parsePort(bracketed[1]);
  }
  const match = value.match(/:(\d+)$/);
  return parsePort(match?.[1]);
}

function addUniquePort(ports: number[], seen: Set<number>, port: number | null) {
  if (port && !seen.has(port)) {
    seen.add(port);
    ports.push(port);
  }
}

function parseCodeServerProcessLine(line: string): CodeServerProcessEntry | null {
  const trimmed = line.trim();
  if (!trimmed.includes("code-server")) {
    return null;
  }

  const pidMatch = trimmed.match(/^(\d+)\s+(.+)$/);
  if (!pidMatch) {
    return { pid: null, command: trimmed };
  }

  const pid = Number(pidMatch[1]);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    command: pidMatch[2],
  };
}

function extractCodeServerProcessEntries(output: string): CodeServerProcessEntry[] {
  return output
    .split(/\r?\n/)
    .map(parseCodeServerProcessLine)
    .filter((entry): entry is CodeServerProcessEntry => entry !== null);
}

function extractCodeServerPortsFromProcessEntries(
  entries: readonly CodeServerProcessEntry[],
): number[] {
  const ports: number[] = [];
  const seen = new Set<number>();

  for (const entry of entries) {
    const portMatch = entry.command.match(/(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/);
    addUniquePort(ports, seen, parsePort(portMatch?.[1]));
    const bindMatch = entry.command.match(/(?:^|\s)--bind-addr(?:=|\s+)(\S+)(?:\s|$)/);
    addUniquePort(ports, seen, parsePortFromBindAddress(bindMatch?.[1]));
  }

  return ports;
}

export function extractCodeServerPortsFromProcessList(output: string): number[] {
  return extractCodeServerPortsFromProcessEntries(extractCodeServerProcessEntries(output));
}

function listenerOutputContainsLoopbackPort(output: string, port: number): boolean {
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const loopbackListener = new RegExp(
    `(?:127(?:\\.\\d{1,3}){3}|localhost|\\[::1]|::1|0\\.0\\.0\\.0|\\*)[:.]${escapedPort}\\b`,
  );
  return output
    .split(/\r?\n/)
    .some((line) => line.includes("LISTEN") && loopbackListener.test(line));
}

function extractLoopbackListenerPort(line: string): number | null {
  const match = line.match(/(?:127(?:\.\d{1,3}){3}|localhost|\[::1]|::1|0\.0\.0\.0|\*)[:.](\d+)\b/);
  return parsePort(match?.[1]);
}

function listenerLineReferencesPid(line: string, pid: number): boolean {
  if (new RegExp(`\\bpid=${pid}\\b`).test(line)) {
    return true;
  }
  return new RegExp(`^\\S+\\s+${pid}\\s`).test(line.trim());
}

function extractListeningPortsForPids(output: string, pids: readonly number[]): number[] {
  if (pids.length === 0) {
    return [];
  }

  const ports: number[] = [];
  const seen = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("LISTEN")) {
      continue;
    }
    if (!pids.some((pid) => listenerLineReferencesPid(line, pid))) {
      continue;
    }
    addUniquePort(ports, seen, extractLoopbackListenerPort(line));
  }
  return ports;
}

function runTextCommand(
  execFile: ExecFileSyncLike,
  file: string,
  args: readonly string[],
): string | null {
  try {
    return String(
      execFile(file, args, {
        timeout: CODE_SERVER_DETECTION_TIMEOUT_MS,
        encoding: "utf8",
      }),
    );
  } catch {
    return null;
  }
}

function readCodeServerProcessList(execFile: ExecFileSyncLike): string | null {
  const psOutput = runTextCommand(execFile, "ps", ["-axo", "pid=,command="]);
  if (psOutput !== null) {
    return psOutput;
  }
  return runTextCommand(execFile, "pgrep", ["-af", "[c]ode-server"]);
}

function readListeningTcpOutput(execFile: ExecFileSyncLike): string | undefined {
  const ssOutput = runTextCommand(execFile, "ss", ["-ltnp"]);
  if (ssOutput !== null) {
    return ssOutput;
  }

  const lsofOutput = runTextCommand(execFile, "lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  if (lsofOutput !== null) {
    return lsofOutput;
  }

  return undefined;
}

function findConfirmedListeningPortFromOutput(
  listenerOutput: string,
  candidatePorts: readonly number[],
): number | null {
  return (
    candidatePorts.find((port) => listenerOutputContainsLoopbackPort(listenerOutput, port)) ?? null
  );
}

function findConfirmedListeningPort(
  execFile: ExecFileSyncLike,
  candidatePorts: readonly number[],
): number | null | undefined {
  const listenerOutput = readListeningTcpOutput(execFile);
  return listenerOutput === undefined
    ? undefined
    : findConfirmedListeningPortFromOutput(listenerOutput, candidatePorts);
}

export function detectCodeServerLocalhostUrl(
  execFile: ExecFileSyncLike = execFileSync,
): string | null {
  const processOutput = readCodeServerProcessList(execFile);
  if (!processOutput) {
    return null;
  }

  const processEntries = extractCodeServerProcessEntries(processOutput);
  const candidatePorts = extractCodeServerPortsFromProcessEntries(processEntries);

  if (candidatePorts.length > 0) {
    const confirmedPort = findConfirmedListeningPort(execFile, candidatePorts);
    if (confirmedPort === null) {
      return null;
    }

    const port = confirmedPort ?? candidatePorts[0];
    return port ? `http://127.0.0.1:${port}` : null;
  }

  const pids = processEntries
    .map((entry) => entry.pid)
    .filter((pid): pid is number => pid !== null);
  const listenerOutput = readListeningTcpOutput(execFile);
  const port =
    listenerOutput === undefined ? null : extractListeningPortsForPids(listenerOutput, pids)[0];
  return port ? `http://127.0.0.1:${port}` : null;
}

export function buildCodeServerUrlOpeners(input: {
  env: NodeJS.ProcessEnv;
  execFile?: ExecFileSyncLike;
}): CodeServerUrlOpeners | null {
  const localhostUrl = detectCodeServerLocalhostUrl(input.execFile);
  const externalUrl = normalizeCodeServerExternalUrl(input.env.CODE_SERVER_URL);
  if (!localhostUrl && !externalUrl) {
    return null;
  }
  return {
    ...(localhostUrl ? { localhostUrl } : {}),
    ...(externalUrl ? { externalUrl } : {}),
  };
}
