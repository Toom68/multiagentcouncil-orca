/**
 * Host memory headroom probe for `council doctor`.
 *
 * Each council seat is a full agent session that stays open (idle) until the
 * run's terminal cleanup closes it. Measured on this project's Windows
 * validation host, one short-lived Devin worker plus its MCP helper
 * processes held ~3.4 GB of committed memory (CLI ~2.4 GB, MCP ~1.0 GB) and
 * ~0.4 GB of RAM — a long-running session grows further, and leftover
 * sessions once exhausted the host's commit limit (0.3 GB free). This
 * module measures free RAM and free commit (virtual memory) and turns them
 * into a rough count of additional agent sessions that fit.
 *
 * Everything here is informational for `doctor`: probe failures degrade to
 * `unverified` with a reason, nothing ever throws into the command, and the
 * result never gates `ready`.
 */

import { promises as fsp } from 'node:fs';
import { freemem, platform as osPlatform, totalmem } from 'node:os';

import { resolveExecutable, runProcess } from './host/process.js';

const BYTES_PER_MB = 1024 * 1024;
const KB_PER_MB = 1024;

/**
 * Per-session footprint estimate in MB — a Devin worker plus its MCP helper
 * processes measured on one Windows host (~3.4 GiB commit, ~0.4 GiB RAM).
 * Overridable per host/agent with COUNCIL_SESSION_COMMIT_MB /
 * COUNCIL_SESSION_RAM_MB (positive numbers only; anything else defaults).
 */
export const DEFAULT_SESSION_COMMIT_MB = 3482;
export const DEFAULT_SESSION_RAM_MB = 410;

export interface SessionFootprintMb {
  commitMb: number;
  ramMb: number;
}

export interface HostMemoryProbe {
  /** Free physical RAM via os.freemem() — a conservative floor on Linux. */
  ramFreeMb: number;
  ramTotalMb: number;
  /** Linux only: MemAvailable from /proc/meminfo (usable RAM incl. reclaimable cache). */
  memAvailableMb?: number;
  /** Free commit (virtual memory), where the platform can measure it. */
  commitFreeMb?: number;
  commitTotalMb?: number;
  commitSource?: 'windows-cim' | 'linux-proc';
  /** True when this platform has a commit probe (win32/linux). */
  commitProbed: boolean;
  /** Why commit is unverified, when it is. */
  commitUnverifiedReason?: string;
}

export interface SessionFitEstimate {
  /** Additional agent sessions that fit given current headroom. */
  additionalSessions: number;
  /** Which measurement bounds the estimate. */
  limitedBy: 'commit' | 'ram';
}

function positiveMb(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function sessionFootprintFromEnv(env: NodeJS.ProcessEnv = process.env): SessionFootprintMb {
  return {
    commitMb: positiveMb(env.COUNCIL_SESSION_COMMIT_MB) ?? DEFAULT_SESSION_COMMIT_MB,
    ramMb: positiveMb(env.COUNCIL_SESSION_RAM_MB) ?? DEFAULT_SESSION_RAM_MB,
  };
}

/**
 * Peak retained agent sessions for a council: participants + scribe +
 * supervisor. The organiser's terminal closes before reviewers launch, and
 * `concurrency` bounds how many seats do active work at once — it does NOT
 * shrink how many idle sessions stay open holding memory.
 */
export function peakCouncilSessions(config: { participants: number }): number {
  return config.participants + 2;
}

/**
 * Parse `Get-CimInstance Win32_OperatingSystem | Select-Object
 * FreeVirtualMemory,TotalVirtualMemorySize | ConvertTo-Json` output (values
 * in KB). A single-object response is the norm; a wrapped array is accepted.
 */
export function parseWindowsCommitOutput(stdout: string): { freeKb: number; totalKb: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const row: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (row === null || typeof row !== 'object') return null;
  const free = (row as Record<string, unknown>).FreeVirtualMemory;
  const total = (row as Record<string, unknown>).TotalVirtualMemorySize;
  if (typeof free !== 'number' || !Number.isFinite(free) || free < 0) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  return { freeKb: free, totalKb: total };
}

/** Parse /proc/meminfo (all values KB). Null when no known key is present. */
export function parseProcMeminfo(text: string): {
  memAvailableKb?: number;
  commitLimitKb?: number;
  committedASKb?: number;
} | null {
  const found: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m !== null) found[m[1]!] = Number(m[2]);
  }
  const out: {
    memAvailableKb?: number;
    commitLimitKb?: number;
    committedASKb?: number;
  } = {};
  if (found.MemAvailable !== undefined) out.memAvailableKb = found.MemAvailable;
  if (found.CommitLimit !== undefined) out.commitLimitKb = found.CommitLimit;
  if (found.Committed_AS !== undefined) out.committedASKb = found.Committed_AS;
  return Object.keys(out).length > 0 ? out : null;
}

/** Fixed CIM query — spawned as literal argv, never through a shell. */
const WINDOWS_COMMIT_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_OperatingSystem | Select-Object -Property FreeVirtualMemory,TotalVirtualMemorySize | ConvertTo-Json -Compress',
] as const;

/** Injectable seams keep the probes unit-testable without a real spawn/fs. */
export interface HostMemoryDeps {
  platform?: NodeJS.Platform;
  ramFreeBytes?: number;
  ramTotalBytes?: number;
  spawn?: typeof runProcess;
  resolvePath?: (command: string) => string;
  readMeminfo?: () => Promise<string>;
  timeoutMs?: number;
}

type CommitProbeResult =
  | { ok: true; freeMb: number; totalMb: number; source: 'windows-cim' | 'linux-proc' }
  | { ok: false; reason: string };

async function windowsCommitProbe(deps: HostMemoryDeps, timeoutMs: number): Promise<CommitProbeResult> {
  const spawn = deps.spawn ?? runProcess;
  const resolvePath = deps.resolvePath ?? resolveExecutable;
  let file: string;
  try {
    file = resolvePath('powershell');
  } catch (e) {
    return {
      ok: false,
      reason: `powershell not resolvable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const proc = await spawn({ file, args: WINDOWS_COMMIT_ARGS }, { timeoutMs });
  if (proc.reason !== 'exited' || proc.exitCode !== 0) {
    const tail = (proc.stderr || proc.stdout).replace(/\s+/g, ' ').trim().slice(-160);
    return {
      ok: false,
      reason:
        `powershell CIM query ${proc.reason}` +
        `${proc.exitCode !== null ? ` exit ${proc.exitCode}` : ''}` +
        `${tail.length > 0 ? `: ${tail}` : ''}`,
    };
  }
  const parsed = parseWindowsCommitOutput(proc.stdout);
  if (parsed === null) return { ok: false, reason: 'unparseable Win32_OperatingSystem CIM output' };
  return {
    ok: true,
    freeMb: Math.floor(parsed.freeKb / KB_PER_MB),
    totalMb: Math.floor(parsed.totalKb / KB_PER_MB),
    source: 'windows-cim',
  };
}

/** Single /proc/meminfo read feeding both commit headroom and MemAvailable. */
async function linuxMeminfoProbe(
  deps: HostMemoryDeps,
): Promise<{ commit: CommitProbeResult; memAvailableMb?: number }> {
  const readMeminfo = deps.readMeminfo ?? (() => fsp.readFile('/proc/meminfo', 'utf8'));
  let text: string;
  try {
    text = await readMeminfo();
  } catch (e) {
    return {
      commit: {
        ok: false,
        reason: `cannot read /proc/meminfo: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  const info = parseProcMeminfo(text);
  const memAvailableMb =
    info?.memAvailableKb !== undefined ? Math.floor(info.memAvailableKb / KB_PER_MB) : undefined;
  if (info === null || info.commitLimitKb === undefined || info.committedASKb === undefined) {
    return {
      commit: { ok: false, reason: '/proc/meminfo lacks CommitLimit/Committed_AS' },
      memAvailableMb,
    };
  }
  return {
    commit: {
      ok: true,
      freeMb: Math.floor(Math.max(0, info.commitLimitKb - info.committedASKb) / KB_PER_MB),
      totalMb: Math.floor(info.commitLimitKb / KB_PER_MB),
      source: 'linux-proc',
    },
    memAvailableMb,
  };
}

/**
 * Measure free RAM (always) and free commit (Windows CIM / Linux
 * /proc/meminfo). Never throws: a failed probe lands in
 * `commitUnverifiedReason` and the caller reports `unverified`.
 */
export async function probeHostMemory(deps: HostMemoryDeps = {}): Promise<HostMemoryProbe> {
  const probe: HostMemoryProbe = {
    ramFreeMb: Math.floor((deps.ramFreeBytes ?? freemem()) / BYTES_PER_MB),
    ramTotalMb: Math.floor((deps.ramTotalBytes ?? totalmem()) / BYTES_PER_MB),
    commitProbed: false,
  };
  const platform = deps.platform ?? osPlatform();
  let result: CommitProbeResult;
  if (platform === 'win32') {
    probe.commitProbed = true;
    result = await windowsCommitProbe(deps, deps.timeoutMs ?? 10_000);
  } else if (platform === 'linux') {
    probe.commitProbed = true;
    const linux = await linuxMeminfoProbe(deps);
    result = linux.commit;
    if (linux.memAvailableMb !== undefined) probe.memAvailableMb = linux.memAvailableMb;
  } else {
    result = { ok: false, reason: `no commit probe for platform ${platform} — RAM only` };
  }
  if (result.ok) {
    probe.commitFreeMb = result.freeMb;
    probe.commitTotalMb = result.totalMb;
    probe.commitSource = result.source;
  } else {
    probe.commitUnverifiedReason = result.reason;
  }
  return probe;
}

/**
 * Sessions-that-fit estimate: the smaller of commit-headroom/footprint and
 * RAM-headroom/footprint. Linux prefers MemAvailable over freemem for the
 * RAM side (freemem there excludes reclaimable cache and reads near-zero on
 * healthy hosts); when commit cannot be measured the estimate is RAM-only.
 */
export function estimateAdditionalSessions(
  mem: Pick<HostMemoryProbe, 'commitFreeMb' | 'ramFreeMb' | 'memAvailableMb'>,
  footprint: SessionFootprintMb,
): SessionFitEstimate {
  const candidates: { additionalSessions: number; limitedBy: 'commit' | 'ram' }[] = [];
  if (mem.commitFreeMb !== undefined) {
    candidates.push({
      additionalSessions: Math.floor(mem.commitFreeMb / footprint.commitMb),
      limitedBy: 'commit',
    });
  }
  candidates.push({
    additionalSessions: Math.floor((mem.memAvailableMb ?? mem.ramFreeMb) / footprint.ramMb),
    limitedBy: 'ram',
  });
  const best = candidates.reduce((a, b) => (b.additionalSessions < a.additionalSessions ? b : a));
  return {
    additionalSessions: Math.max(0, best.additionalSessions),
    limitedBy: best.limitedBy,
  };
}
