/**
 * Safe subprocess boundary for the council Orca host adapter.
 *
 * Every child process is spawned with `shell: false` and an executable/argv
 * array — no command string ever reaches a shell. Timeouts and output caps are
 * mandatory. Children inherit the caller environment verbatim (Orca's CLI
 * needs its injected identity/auth variables); credential-shaped values are
 * redacted from all error/output strings the boundary produces instead.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;
export const DEFAULT_KILL_GRACE_MS = 2_000;

/** A fully formed spawn plan: executable plus literal argv entries. */
export interface SpawnPlan {
  /** Executable: an absolute path, or a bare name resolved via PATH. */
  file: string;
  /** Literal argv entries. These are never joined into shell text. */
  args: readonly string[];
}

export interface RunProcessOptions {
  cwd?: string;
  /** Extra env entries merged over the sanitized base environment. */
  env?: Readonly<Record<string, string>>;
  /** Data written to stdin, then stdin is closed. */
  input?: string;
  /** Hard wall-clock bound in ms; the child is killed past it. Required. */
  timeoutMs: number;
  /** Recording caps; output beyond the cap is drained but not retained. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Grace period after the first kill signal before SIGKILL. */
  killGraceMs?: number;
}

export type ProcessExitReason = 'exited' | 'timed_out' | 'spawn_failed';

export interface ProcessResult {
  reason: ProcessExitReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export class ExecutableNotFoundError extends Error {
  readonly code = 'executable_not_found' as const;
  constructor(command: string, detail: string) {
    super(`Executable not found: ${command} (${detail})`);
    this.name = 'ExecutableNotFoundError';
  }
}

export class SpawnFailedError extends Error {
  readonly code = 'spawn_failed' as const;
  constructor(file: string, detail: string) {
    super(`Failed to spawn ${file}: ${detail}`);
    this.name = 'SpawnFailedError';
  }
}

/**
 * Child environment: the caller's environment INHERITED VERBATIM (minus only
 * undefined values). Orca's CLI depends on injected control/identity
 * variables — ORCA_PANE_KEY, ORCA_TERMINAL_HANDLE, ORCA_RUNTIME_SOURCE*,
 * session auth — to act with the caller's identity; stripping them breaks
 * authorization. Secret hygiene is enforced on OUTPUT (see redact, applied to
 * all error strings), never by mutating the trusted child's environment.
 */
export function inheritEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Credential-shaped values masked out of any string this boundary emits. */
const SECRET_VALUE_RE =
  /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,})/g;
const SECRET_ASSIGNMENT_RE =
  /([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*[=:]\s*)[^\s"']+/gi;

/** Mask credential-shaped values so they can never appear in our errors/logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_VALUE_RE, '[redacted]')
    .replace(SECRET_ASSIGNMENT_RE, '$1[redacted]');
}

function pathExts(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
  return raw.split(';').filter(Boolean);
}

function isExecutableFile(path: string, windows: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (windows) {
      // CreateProcess can run it; we additionally refuse shell scripts that
      // cannot run without shell:true (see resolveExecutable).
      return true;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const WINDOWS_ONLY_EXTENSIONS = new Set(['.cmd', '.bat', '.com', '.ps1']);

/**
 * Resolve an executable for `shell: false` spawning.
 *
 * - `explicitPath` wins and must be an existing file.
 * - A `command` containing a path separator is treated as a path.
 * - Otherwise every PATH directory is searched; on Windows the PATHEXT list
 *   is tried in order with `.exe` preferred, since `.cmd`/`.bat`/`.ps1`
 *   wrappers cannot run under `shell: false` anyway.
 */
export function resolveExecutable(
  command: string,
  opts: { explicitPath?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const windows = process.platform === 'win32';
  const env = opts.env ?? process.env;

  if (opts.explicitPath !== undefined) {
    if (isAbsolute(opts.explicitPath) && existsSync(opts.explicitPath)) {
      return opts.explicitPath;
    }
    throw new ExecutableNotFoundError(
      command,
      `explicitPath ${opts.explicitPath} is not an existing absolute path`,
    );
  }

  const looksLikePath =
    isAbsolute(command) || command.includes('/') || command.includes('\\');
  if (looksLikePath) {
    if (existsSync(command)) return command;
    throw new ExecutableNotFoundError(command, 'path does not exist');
  }

  const pathEnv = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const candidates = windows
    ? [
        // Prefer a real binary; shell wrappers cannot spawn with shell:false.
        ...['.exe', ''].flatMap((e) => [command + e]),
        ...pathExts(env)
          .filter((e) => !WINDOWS_ONLY_EXTENSIONS.has(e.toLowerCase()))
          .map((e) => command + e),
      ]
    : [command];

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (isExecutableFile(full, windows)) return full;
    }
  }
  throw new ExecutableNotFoundError(command, `not found on PATH (${dirs.length} dirs)`);
}

/**
 * Spawn `plan` and wait for exit, enforcing timeout and output caps.
 * Output beyond the caps keeps being drained (so the child cannot deadlock on
 * a full pipe) but is not retained; the truncated flags say when that happened.
 */
export function runProcess(
  plan: SpawnPlan,
  opts: RunProcessOptions,
): Promise<ProcessResult> {
  const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderr = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const killGrace = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const env = { ...inheritEnv(), ...opts.env };

  return new Promise<ProcessResult>((resolvePromise) => {
    const started = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    let child;
    try {
      child = spawn(plan.file, [...plan.args], {
        shell: false,
        cwd: opts.cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolvePromise({
        reason: 'spawn_failed',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: redactSecrets(err instanceof Error ? err.message : String(err)),
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: Date.now() - started,
      });
      return;
    }

    const finish = (partial: Omit<ProcessResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({ ...partial, durationMs: Date.now() - started });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, killGrace);
      killTimer.unref?.();
    }, opts.timeoutMs);
    timeoutTimer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < maxStdout) {
        const room = maxStdout - stdoutBytes;
        stdoutChunks.push(chunk.subarray(0, room));
        stdoutBytes += Math.min(chunk.length, room);
        if (chunk.length > room) stdoutTruncated = true;
      } else {
        stdoutTruncated = true;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < maxStderr) {
        const room = maxStderr - stderrBytes;
        stderrChunks.push(chunk.subarray(0, room));
        stderrBytes += Math.min(chunk.length, room);
        if (chunk.length > room) stderrTruncated = true;
      } else {
        stderrTruncated = true;
      }
    });

    child.on('error', (err) => {
      finish({
        reason: 'spawn_failed',
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: redactSecrets(err.message),
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on('close', (exitCode, signal) => {
      finish({
        reason: timedOut ? 'timed_out' : 'exited',
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: redactSecrets(Buffer.concat(stderrChunks).toString('utf8')),
        stdoutTruncated,
        stderrTruncated,
      });
    });

    if (opts.input !== undefined && child.stdin.writable) {
      child.stdin.on('error', () => {
        /* EPIPE when the child exits early; output/close carries the truth. */
      });
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/** Convenience: resolve `command`, then run it. */
export async function runCommand(
  command: string,
  args: readonly string[],
  opts: RunProcessOptions & { explicitPath?: string },
): Promise<ProcessResult> {
  const file = resolveExecutable(command, { explicitPath: opts.explicitPath });
  return runProcess({ file, args }, opts);
}
