/**
 * Tests for the host layer: src/host/process.ts (subprocess boundary) and
 * src/host/orca.ts (Orca CLI adapter + contracts HostAdapter).
 *
 * Two seams are exercised:
 * - real child processes via process.execPath (node) + test/fixtures/orca-* —
 *   proves argv arrays, timeouts, caps, exit codes, and redaction end-to-end;
 * - a recording spawnFn injection — proves exact orca argv, envelope handling,
 *   validation refusals, and that no call ever runs `check`.
 *
 * No test ever starts a real Orca agent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ExecutableNotFoundError,
  resolveExecutable,
  runProcess,
  type ProcessResult,
  type SpawnPlan,
} from '../src/host/process.js';
import {
  buildAgentCommandText,
  mapLiveness,
  OrcaAdapter,
  OrcaHost,
  parseMailTarget,
  parseOrcaEnvelope,
  type AgentLaunchPolicy,
  type OrcaAdapterOptions,
} from '../src/host/orca.js';
import type { WorkerLaunchSpec } from '../src/contracts.js';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const fixture = (name: string) => join(FIXTURES, name);

function proc(partial: Partial<ProcessResult>): ProcessResult {
  return {
    reason: 'exited',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...partial,
  };
}

const okEnv = (result: unknown) => proc({ stdout: JSON.stringify({ ok: true, result }) });
/** Ready `terminal show` receipt (shape observed on 1.4.261): connected
 *  terminal, recognized agent, no pending prompt/menu decision. */
const readyTerm = (handle: string, agent = 'devin') => ({
  terminal: { handle, connected: true, agentIdentity: agent, agentWait: null },
});
/** readyTerm with field overrides — for not-ready variants. */
const readyTermWith = (handle: string, over: Record<string, unknown>) => ({
  terminal: { handle, connected: true, agentIdentity: 'devin', agentWait: null, ...over },
});
/** `orca terminal` success receipt shape verified on 1.4.261: the top-level
 *  envelope `id` is the only request evidence — there is no result.mutation
 *  and no --full flag on terminal commands. */
const okTerm = (result: unknown, id = 'term-rcpt-1') =>
  proc({ stdout: JSON.stringify({ id, ok: true, result }) });
/** Success mutation receipt shape verified on 1.4.261 (--full): top-level receipt
 *  id + result.mutation.{requestId,replayed}. */
const okMut = (result: unknown, requestId = 'req-uuid-1') =>
  proc({
    stdout: JSON.stringify({
      id: 'receipt-uuid-9',
      ok: true,
      result: {
        ...(typeof result === 'object' && result !== null ? result : { value: result }),
        mutation: { requestId, replayed: false },
      },
      _meta: { runtimeId: 'rt-1' },
    }),
  });
const failEnv = (code: string, message = 'm', data?: unknown) =>
  proc({
    exitCode: 1,
    stdout: JSON.stringify({ ok: false, error: { code, message, ...(data === undefined ? {} : { data }) } }),
  });
/** Failure receipt carrying the Orca request id (verified field location). */
const failMut = (code: string, requestId = 'req-uuid-err', extra?: unknown) =>
  proc({
    exitCode: 1,
    stdout: JSON.stringify({
      ok: false,
      error: {
        code,
        message: `${code} happened`,
        data: { orchestrationRequestId: requestId, ...(extra as object) },
      },
    }),
  });

/** Recording spawnFn: captures every argv array, replies via handler. */
function recorder(handler: (args: readonly string[]) => ProcessResult) {
  const calls: string[][] = [];
  const spawnFn = async (plan: SpawnPlan) => {
    calls.push([...plan.args]);
    return handler(plan.args);
  };
  return { calls, spawnFn };
}

function makeAdapter(
  handler: (args: readonly string[]) => ProcessResult,
  opts: OrcaAdapterOptions = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'council fake orca ')); // space in dir name on purpose
  const exe = join(dir, 'fake orca.exe');
  writeFileSync(exe, '');
  const { calls, spawnFn } = recorder(handler);
  const adapter = new OrcaAdapter(new OrcaHost({ executablePath: exe, spawnFn, ...opts }), opts);
  return { adapter, calls };
}

function launchSpec(overrides: Partial<WorkerLaunchSpec> = {}): WorkerLaunchSpec {
  return {
    participantId: 'p1',
    phase: 'independent_review',
    round: null,
    runId: 'run_c1',
    taskId: 'task_aaa',
    specFilePath: 'specs/reviewer-1.md',
    taskTitle: 'council reviewer 1',
    worktree: 'current',
    agent: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
    retainTerminal: false,
    ...overrides,
  };
}

// ─── process boundary ───────────────────────────────────────────────────────

describe('resolveExecutable', () => {
  it('accepts an existing absolute path containing spaces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dir with spaces '));
    const exe = join(dir, 'my fake tool.exe');
    writeFileSync(exe, '');
    assert.equal(resolveExecutable('anything', { explicitPath: exe }), exe);
  });

  it('rejects a missing explicit path', () => {
    assert.throws(
      () => resolveExecutable('nope', { explicitPath: 'C:\\definitely\\missing.exe' }),
      ExecutableNotFoundError,
    );
  });

  it('rejects a bare name that is not on PATH', () => {
    assert.throws(
      () => resolveExecutable('definitely-not-a-real-command-xyz', { env: { PATH: '' } }),
      ExecutableNotFoundError,
    );
  });
});

describe('runProcess', () => {
  const node = process.execPath;

  it('passes argv literally — spaces and quotes preserved per-arg', async () => {
    const res = await runProcess(
      { file: node, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b', 'x"y', 'c\\d'] },
      { timeoutMs: 10_000 },
    );
    assert.equal(res.reason, 'exited');
    assert.deepEqual(JSON.parse(res.stdout), ['a b', 'x"y', 'c\\d']);
  });

  it('kills a hung child and reports timed_out', async () => {
    const res = await runProcess(
      { file: node, args: [fixture('orca-slow.js')] },
      { timeoutMs: 300, killGraceMs: 100 },
    );
    assert.equal(res.reason, 'timed_out');
    assert.ok(res.durationMs < 10_000, `took ${res.durationMs}ms`);
  });

  it('propagates nonzero exit codes', async () => {
    const res = await runProcess(
      { file: node, args: [fixture('orca-crash.js')] },
      { timeoutMs: 10_000 },
    );
    assert.equal(res.reason, 'exited');
    assert.equal(res.exitCode, 3);
    assert.match(res.stdout, /partial garbage/);
  });

  it('caps retained output without deadlocking the child', async () => {
    const res = await runProcess(
      { file: node, args: [fixture('orca-flood.js')] },
      { timeoutMs: 20_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 8 * 1024 },
    );
    assert.equal(res.reason, 'exited');
    assert.ok(res.stdoutTruncated);
    assert.ok(res.stderrTruncated);
    assert.ok(Buffer.byteLength(res.stdout) <= 64 * 1024);
    assert.ok(Buffer.byteLength(res.stderr) <= 8 * 1024);
  });

  it('redacts credential-shaped values from captured stderr', async () => {
    const res = await runProcess(
      { file: node, args: [fixture('orca-secret.js')] },
      { timeoutMs: 10_000 },
    );
    assert.doesNotMatch(res.stderr, /sk-abcdef/);
    assert.match(res.stderr, /\[redacted\]/);
  });

  it('reports spawn_failed for a missing executable', async () => {
    const res = await runProcess(
      { file: join(tmpdir(), 'no such orca binary.exe'), args: [] },
      { timeoutMs: 5_000 },
    );
    assert.equal(res.reason, 'spawn_failed');
  });
});

// ─── envelope parsing ───────────────────────────────────────────────────────

describe('parseOrcaEnvelope', () => {
  it('parses a JSON envelope', () => {
    const p = parseOrcaEnvelope(proc({ stdout: '{"ok":true,"result":{"a":1}}' }));
    assert.equal(p.kind, 'json');
    if (p.kind === 'json') assert.equal(p.envelope.ok, true);
  });

  it('parses the flat "error: code: message" stderr form', () => {
    const p = parseOrcaEnvelope(
      proc({ exitCode: 1, stderr: 'error: invalid_argument: Unknown flag --from\n' }),
    );
    assert.equal(p.kind, 'error_line');
    if (p.kind === 'error_line') {
      assert.equal(p.error.code, 'invalid_argument');
      assert.match(p.error.message, /Unknown flag/);
    }
  });

  it('reports unparsed for garbage output', () => {
    assert.equal(parseOrcaEnvelope(proc({ stdout: 'noise' })).kind, 'unparsed');
  });
});

// ─── validation primitives ──────────────────────────────────────────────────

describe('token validation', () => {
  it('rejects shell metacharacters in command tokens', () => {
    for (const bad of ['swe-2-max; rm -rf', 'a|b', 'x>y', 'a&&b', '$(id)', '`id`', 'a b', '--model=x', 'x\ny']) {
      assert.throws(() => buildAgentCommandText(['devin', bad]), /Refusing|unsafe/);
    }
  });

  it('builds a clean command from allowlisted tokens', () => {
    assert.equal(
      buildAgentCommandText(['devin', '--model', 'swe-2-max', '--permission-mode', 'dangerous']),
      'devin --model swe-2-max --permission-mode dangerous',
    );
  });

  it('rejects unsafe mail targets', () => {
    assert.throws(() => parseMailTarget('evil target'), /mail target/);
    assert.throws(() => parseMailTarget('bogus:ctx_1'), /mailbox kind/);
    assert.deepEqual(parseMailTarget('dispatch:ctx_1'), { kind: 'dispatch', id: 'ctx_1' });
    assert.deepEqual(parseMailTarget('run:run_9'), { kind: 'run', id: 'run_9' });
    assert.deepEqual(parseMailTarget('term_abc-def'), { kind: 'terminal', id: 'term_abc-def' });
  });
});

// ─── adapter: HostAdapter contract ─────────────────────────────────────────

describe('OrcaAdapter.createRun/createTask', () => {
  it('creates a run with NO caller key on argv; captures Orca request id from the receipt', async () => {
    const { adapter, calls } = makeAdapter(() => okMut({ run: { id: 'run_c1' } }, 'req-run-1'));
    const res = await adapter.createRun({ objective: 'review the thing' });
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.value.runId, 'run_c1');
    const argv = calls[0];
    assert.deepEqual(argv.slice(0, 2), ['orchestration', 'run-create']);
    // The host receives the bounded descriptive label, not the raw brief.
    assert.ok(argv.includes('--objective=Council review — review the thing'));
    assert.ok(argv.includes('--json'));
    // Verified 1.4.261 semantics: --retry-request takes an ORCA-issued id only.
    // A caller-chosen council-* key must never appear on first-attempt argv.
    assert.ok(!argv.includes('--retry-request'), 'first attempt must not carry --retry-request');
    assert.ok(argv.includes('--full'), 'mutations request --full so the requestId is visible');
  });

  it('sends a bounded Run label for a multi-kilobyte brief, preserving UTF-8', async () => {
    const { adapter, calls } = makeAdapter(() => okMut({ run: { id: 'run_big' } }, 'req-run-2'));
    // >1024 bytes including multi-byte chars — the full brief must still be
    // accepted locally; only the Run metadata label is bounded.
    const brief = `。${'é🙂'.repeat(400)}`;
    assert.ok(Buffer.byteLength(brief, 'utf8') > 1024);
    const res = await adapter.createRun({ objective: brief });
    assert.ok(res.ok);
    const argv = calls[0];
    const obj = argv.find((a) => a.startsWith('--objective='))!;
    const label = obj.slice('--objective='.length);
    assert.ok(Buffer.byteLength(label, 'utf8') <= 1024, `label ${Buffer.byteLength(label)}B exceeds cap`);
    assert.ok(label.startsWith('Council review — '), 'descriptive prefix kept');
    assert.ok(label.endsWith('…'), 'truncation marked');
    // The emitted label is valid UTF-8 — replacement chars prove a mid-codepoint cut.
    assert.ok(!label.includes('\uFFFD'), 'must not cut inside a code point');
    // The adapter's returned input is untouched — the caller's objective stays verbatim.
    if (res.ok) assert.equal(res.value.runId, 'run_big');
  });

  it('keeps short objectives verbatim in the Run label', async () => {
    const { adapter, calls } = makeAdapter(() => okMut({ run: { id: 'run_s' } }));
    const res = await adapter.createRun({ objective: 'short brief' });
    assert.ok(res.ok);
    const obj = calls[0].find((a) => a.startsWith('--objective='))!;
    assert.equal(obj, '--objective=Council review — short brief');
  });

  it('rejects an empty objective at the adapter boundary — no spawn', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv({}));
    for (const bad of ['', '   ', '\n\t ']) {
      const res = await adapter.createRun({ objective: bad });
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.error.message, /bad_objective|objective/i);
    }
    assert.equal(calls.length, 0);
  });

  it('creates a task under the explicit run with a spec file', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv({ task: { id: 'task_t1' } }));
    const res = await adapter.createTask({
      runId: 'run_c1',
      specFilePath: 'specs dir/reviewer one.md',
      title: 'reviewer one',
    });
    assert.ok(res.ok);
    const argv = calls[0];
    assert.deepEqual(argv.slice(0, 2), ['orchestration', 'task-create']);
    assert.ok(argv.includes('--run') && argv.includes('run_c1'));
    assert.ok(argv.includes('--spec-file') && argv.includes('specs dir/reviewer one.md'));
    assert.ok(argv.includes('--task-title=reviewer one'));
  });

  it('refuses traversal and option-confusion spec paths without spawning', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv({}));
    for (const bad of ['../outside.md', 'a/../../b.md', '-evil.md']) {
      const res = await adapter.createTask({ runId: 'run_c1', specFilePath: bad, title: 't' });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.error.code, 'adapter_error');
    }
    assert.equal(calls.length, 0);
  });
});

describe('OrcaAdapter.launchWorker', () => {
  const devinLaunchHandler = (agent = 'devin'): ((args: readonly string[]) => ProcessResult) => (args) => {
    const cmd = args[1];
    if (cmd === 'create') return okTerm({ terminal: { handle: 'term_new1' } }, 'rcpt-tc-1');
    if (cmd === 'wait') return okEnv({ idle: true });
    if (cmd === 'show') return okTerm(readyTerm('term_new1', agent), 'rcpt-ts-1');
    if (cmd === 'worker-start') return okMut({ dispatchId: 'ctx_d1', terminal: 'term_new1' }, 'req-ws-1');
    if (cmd === 'worker-keep-open') return okMut({ kept: true }, 'req-ko-1');
    return failEnv('unexpected_command', String(cmd));
  };

  it('launches devin via the pinned argv lane (terminal create → wait → worker-start)', async () => {
    const { adapter, calls } = makeAdapter(devinLaunchHandler());
    const res = await adapter.launchWorker(launchSpec());
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'started');
    assert.equal(res.value.dispatchId, 'ctx_d1');
    assert.equal(res.value.terminalHandle, 'term_new1');
    assert.equal(calls.length, 4);

    const create = calls[0];
    assert.deepEqual(create.slice(0, 2), ['terminal', 'create']);
    // `orca terminal` commands have no --full (verified: invalid_argument:
    // "Unknown flag --full") and no retry semantics — the argv must be bare.
    for (const bad of ['--full', '--retry-request']) {
      assert.ok(!create.includes(bad), `terminal create must not carry ${bad}`);
    }
    const cmdArg = create.find((a) => a.startsWith('--command='));
    // Devin CLI --permission-mode accepts only auto|accept-edits|smart|dangerous
    // (verified on this host). "bypass" is user-facing config vocabulary and
    // must be mapped to "dangerous" — never emitted to the CLI.
    assert.equal(cmdArg, '--command=devin --model swe-2-max --permission-mode dangerous');
    assert.doesNotMatch(cmdArg ?? '', /bypass/);

    const wait = calls[1];
    assert.deepEqual(wait.slice(0, 2), ['terminal', 'wait']);
    for (const bad of ['--full', '--retry-request']) {
      assert.ok(!wait.includes(bad), `terminal wait must not carry ${bad}`);
    }

    // Readiness proof: documented `terminal show` runs after the idle wait —
    // idle alone cannot distinguish a trust screen from a real prompt.
    const show = calls[2];
    assert.deepEqual(show.slice(0, 2), ['terminal', 'show']);
    assert.ok(show.includes('--terminal') && show.includes('term_new1'));

    const start = calls[3];
    assert.deepEqual(start.slice(0, 2), ['orchestration', 'worker-start']);
    for (const flag of ['--task', '--run', '--terminal', '--worktree', '--json']) {
      assert.ok(start.includes(flag), `missing ${flag}`);
    }
    assert.ok(!start.includes('--retry-request'), 'first-attempt worker-start must not carry --retry-request');
    assert.ok(start.includes('--full'), 'orchestration mutations keep --full for requestId capture');
    assert.ok(start.includes('task_aaa'));
    assert.ok(start.includes('term_new1'));
    // LaunchResult.requestId carries the ORCA-issued request id (recovery handle).
    assert.equal(res.value.requestId, 'req-ws-1');
  });

  it('marks the dispatch for retention when retainTerminal is set', async () => {
    const { adapter, calls } = makeAdapter(devinLaunchHandler());
    const res = await adapter.launchWorker(launchSpec({ retainTerminal: true }));
    assert.ok(res.ok);
    assert.equal(calls.length, 5);
    assert.deepEqual(calls[4].slice(0, 2), ['orchestration', 'worker-keep-open']);
    assert.ok(calls[4].includes('ctx_d1'));
  });

  it('rejects a malicious model string before any spawn', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv({}));
    for (const model of ['swe-2-max; rm -rf /', 'a|b', 'x>out', '$(whoami)', 'a b']) {
      const res = await adapter.launchWorker(
        launchSpec({ agent: { agent: 'devin', model, permissionMode: 'bypass' } }),
      );
      assert.equal(res.ok, false, model);
    }
    assert.equal(calls.length, 0);
  });

  it('catalog lane: explicit models pass through; postures/selectors outside the map refuse', async () => {
    // Model selection is caller-explicit — any SAFE token is emitted verbatim
    // (an unavailable model fails at launch visibly, never substituted). This
    // includes provider/model:level selector syntax and unverified ids.
    for (const model of ['swe-2-lightning', 'provider/model:level', 'gpt-x+y']) {
      const { adapter, calls } = makeAdapter(devinLaunchHandler());
      const res = await adapter.launchWorker(
        launchSpec({ agent: { agent: 'devin', model, permissionMode: 'bypass' } }),
      );
      assert.ok(res.ok, model);
      const cmdArg = calls[0].find((a) => a.startsWith('--command=')) ?? '';
      assert.equal(cmdArg, `--command=devin --model ${model} --permission-mode dangerous`);
    }

    // Postures outside the shipped map refuse — never an ambient default.
    for (const pm of ['yolo', 'default', 'plan', 'read-only']) {
      const { adapter, calls } = makeAdapter(() => okEnv({}));
      const badPerm = await adapter.launchWorker(
        launchSpec({ agent: { agent: 'devin', model: 'swe-2-max', permissionMode: pm } }),
      );
      assert.equal(badPerm.ok, false, pm);
      if (!badPerm.ok) assert.equal(badPerm.error.code, 'unsupported');
      assert.equal(calls.length, 0, pm);
    }

    // Documented devin postures other than bypass map to their fixed argv.
    for (const pm of ['auto', 'smart', 'accept-edits', 'dangerous']) {
      const { adapter, calls } = makeAdapter(devinLaunchHandler());
      const res = await adapter.launchWorker(
        launchSpec({ agent: { agent: 'devin', model: 'swe-2-max', permissionMode: pm } }),
      );
      assert.ok(res.ok, pm);
      const cmdArg = calls[0].find((a) => a.startsWith('--command=')) ?? '';
      assert.equal(cmdArg, `--command=devin --model swe-2-max --permission-mode ${pm}`);
    }
  });

  it('catalog lane: unsupported effort/profile selectors refuse rather than being ignored', async () => {
    // devin has no verified effort selector and no named-profile selector.
    for (const choice of [
      { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass', effort: 'high' },
      { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass', profile: 'work' },
      { agent: 'claude', model: 'sonnet-1', permissionMode: 'accept-edits', profile: 'work' },
      { agent: 'codex', model: 'gpt-x', permissionMode: 'bypass', effort: 'high' },
      { agent: 'claude', model: 'sonnet-1', permissionMode: 'accept-edits', effort: 'extreme' },
    ]) {
      const { adapter, calls } = makeAdapter(() => okEnv({}));
      const res = await adapter.launchWorker(launchSpec({ agent: choice }));
      assert.equal(res.ok, false, JSON.stringify(choice));
      if (!res.ok) assert.equal(res.error.code, 'unsupported');
      assert.equal(calls.length, 0, JSON.stringify(choice));
    }
  });

  it('catalog lane: claude effort and codex named profile reach the exact argv', async () => {
    // Claude --effort is a documented selector.
    {
      const handler = devinLaunchHandler('claude');
      const { adapter, calls } = makeAdapter(handler);
      const res = await adapter.launchWorker(
        launchSpec({
          agent: { agent: 'claude', model: 'sonnet-1', effort: 'high', permissionMode: 'accept-edits' },
        }),
      );
      assert.ok(res.ok);
      const cmdArg = calls[0].find((a) => a.startsWith('--command=')) ?? '';
      assert.equal(cmdArg, '--command=claude --model sonnet-1 --permission-mode acceptEdits --effort high');
      // Readiness expects the SELECTED cli's identity, not devin.
      assert.ok(res.value.outcome === 'started');
    }
    // Codex posture is a fixed --sandbox + --ask-for-approval pair; --profile
    // is the only named-profile selector in the catalog.
    {
      const handler = devinLaunchHandler('codex');
      const { adapter, calls } = makeAdapter(handler);
      const res = await adapter.launchWorker(
        launchSpec({
          agent: { agent: 'codex', model: 'gpt-x', permissionMode: 'bypass', profile: 'work' },
        }),
      );
      assert.ok(res.ok);
      const cmdArg = calls[0].find((a) => a.startsWith('--command=')) ?? '';
      assert.equal(
        cmdArg,
        '--command=codex --model gpt-x --sandbox danger-full-access --ask-for-approval never --profile work',
      );
      assert.ok(res.value.outcome === 'started');
    }
  });

  it('catalog lane: a terminal reporting the WRONG agent identity is not ready', async () => {
    // Launched as claude but the terminal reports devin — refuse, never start.
    const { adapter, calls } = makeAdapter((args) => {
      const cmd = args[1];
      if (cmd === 'create') return okTerm({ terminal: { handle: 'term_w' } }, 'rcpt-tc-1');
      if (cmd === 'wait') return okEnv({ idle: true });
      if (cmd === 'show') return okTerm(readyTerm('term_w', 'devin'));
      return failEnv('unexpected_command', String(cmd));
    });
    const res = await adapter.launchWorker(
      launchSpec({ agent: { agent: 'claude', model: 'sonnet-1', permissionMode: 'accept-edits' } }),
    );
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'unknown');
    assert.match(res.value.detail ?? '', /recognized|agent/i);
    assert.ok(calls.every((a) => a[1] !== 'worker-start'));
  });

  it('maps user-facing "bypass" to CLI "dangerous", and accepts "dangerous" directly', async () => {
    for (const pm of ['bypass', 'dangerous'] as const) {
      const { adapter, calls } = makeAdapter(devinLaunchHandler());
      const res = await adapter.launchWorker(
        launchSpec({ agent: { agent: 'devin', model: 'swe-2-max', permissionMode: pm } }),
      );
      assert.ok(res.ok, pm);
      const cmdArg = calls[0].find((a) => a.startsWith('--command=')) ?? '';
      assert.equal(cmdArg, '--command=devin --model swe-2-max --permission-mode dangerous');
      assert.doesNotMatch(cmdArg, /bypass/);
    }
  });

  it('refuses agents with no configured launch policy', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv({}));
    const res = await adapter.launchWorker(
      launchSpec({ agent: { agent: 'mystery', model: 'm1', permissionMode: 'bypass' } }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'unsupported');
    assert.equal(calls.length, 0);
  });

  it('supports a configured generic agent via worker-start --agent/--model', async () => {
    const policies: Record<string, AgentLaunchPolicy> = {
      claude: {
        lane: 'agent',
        models: ['sonnet-1'],
        permissionModes: ['managed'],
        effortValues: ['high'],
      },
    };
    const { adapter, calls } = makeAdapter(
      (args) => (args[1] === 'worker-start' ? okEnv({ dispatchId: 'ctx_c9' }) : failEnv('unexpected')),
      { agents: policies },
    );
    const res = await adapter.launchWorker(
      launchSpec({ agent: { agent: 'claude', model: 'sonnet-1', effort: 'high', permissionMode: 'managed' } }),
    );
    assert.ok(res.ok);
    const start = calls[0];
    assert.ok(start.includes('--agent') && start.includes('claude'));
    assert.ok(start.includes('--model') && start.includes('sonnet-1'));
    assert.ok(start.includes('--effort') && start.includes('high'));
    assert.ok(!start.includes('--terminal'), 'agent lane must not invent terminals');
  });

  it('reports unknown outcome for an uncertain worker-start reply and surfaces the Orca request id', async () => {
    const { adapter } = makeAdapter((args) =>
      args[1] === 'worker-start'
        ? failMut('outcome_unknown', 'req-orca-77')
        : args[1] === 'worker-list'
          ? okEnv({ workers: [] })
          : args[1] === 'show'
            ? okTerm(readyTerm('term_x'))
            : okTerm({ terminal: { handle: 'term_x' }, idle: true }, 'rcpt-tc-1'),
    );
    const res = await adapter.launchWorker(launchSpec());
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'unknown');
    // Recovery handle = the ORCA id from error.data.orchestrationRequestId,
    // never a caller-chosen key.
    assert.equal(res.value.requestId, 'req-orca-77');
  });

  it('reports unknown outcome when the launch reply cannot be parsed', async () => {
    const { adapter } = makeAdapter((args) =>
      args[1] === 'worker-start' ? proc({ exitCode: 0, stdout: '<html>oops</html>' }) :
      args[1] === 'show' ? okTerm(readyTerm('term_x')) :
      okEnv({ terminal: { handle: 'term_x' }, idle: true }),
    );
    const res = await adapter.launchWorker(launchSpec());
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'unknown');
  });

  it('repeats of the same launch do NOT reuse an idempotency key — each first attempt is bare', async () => {
    const handler = devinLaunchHandler();
    const { adapter, calls } = makeAdapter(handler);
    const spec = launchSpec();
    await adapter.launchWorker(spec);
    await adapter.launchWorker(spec);
    for (const argv of calls) {
      assert.ok(!argv.includes('--retry-request'), `unexpected retry flag: ${argv.join(' ')}`);
    }
  });

  it('refuses reuseTerminal while the terminal still owns active work', async () => {
    const { adapter, calls } = makeAdapter((args) =>
      args[1] === 'worker-list'
        ? okEnv({ workers: [{ dispatchId: 'ctx_old', terminal: 'term_busy', outcome: 'in_progress', liveness: 'live' }] })
        : okEnv({}),
    );
    const res = await adapter.launchWorker(launchSpec({ reuseTerminal: 'term_busy' }));
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'failed');
    assert.match(res.value.detail ?? '', /terminal_busy/);
    assert.ok(calls.every((a) => a[1] !== 'worker-start'), 'must not start on a busy terminal');
  });

  it('reuses a terminal only after the prior dispatch is proven settled', async () => {
    const { adapter, calls } = makeAdapter((args) =>
      args[1] === 'worker-list'
        ? okEnv({ workers: [{ dispatchId: 'ctx_old', terminal: 'term_keep', outcome: 'succeeded', liveness: 'idle', terminalState: 'retained' }] })
        : args[1] === 'show'
          ? okTerm(readyTerm('term_keep'))
          : args[1] === 'worker-start'
            ? okEnv({ dispatchId: 'ctx_d2' })
            : okEnv({}),
    );
    const res = await adapter.launchWorker(launchSpec({ reuseTerminal: 'term_keep' }));
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'started');
    const start = calls.find((a) => a[1] === 'worker-start');
    assert.ok(start?.includes('--terminal') && start.includes('term_keep'));
    assert.ok(calls.every((a) => a[1] !== 'create'), 'reuse lane must not create a terminal');
  });

  it('reuses a terminal whose settled dispatch still shows a live retained session', async () => {
    // worker-list row shaped like the observed 1.4.261 worker-show receipt:
    // state carries the settlement while the retained session stays 'live'
    // with no outcome field — the old liveness check kept it 'busy' forever.
    const { adapter, calls } = makeAdapter((args) =>
      args[1] === 'worker-list'
        ? okEnv({ workers: [{ dispatchId: 'ctx_old', terminal: 'term_keep', state: 'succeeded', liveness: 'live', terminalState: 'retained' }] })
        : args[1] === 'show'
          ? okTerm(readyTerm('term_keep'))
          : args[1] === 'worker-start'
            ? okEnv({ dispatchId: 'ctx_d3' })
            : okEnv({}),
    );
    const res = await adapter.launchWorker(launchSpec({ reuseTerminal: 'term_keep' }));
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'started');
    const start = calls.find((a) => a[1] === 'worker-start');
    assert.ok(start?.includes('--terminal') && start.includes('term_keep'));
  });

  // Readiness proof regressions — a trust/permission screen satisfies
  // tui-idle but is NOT a launchable prompt (the live OSINTGPT startup bug:
  // worker-start refused "not running a recognized agent" AFTER idle passed).
  // Every not-ready/unproven state must refuse BEFORE worker-start.
  for (const [name, showReply, match] of [
    [
      'a trust/permission menu (agentWait pending)',
      readyTermWith('term_t', { agentWait: 'permission-prompt' }),
      /agent_not_ready|waiting on/i,
    ],
    [
      'a disconnected terminal',
      readyTermWith('term_t', { connected: false }),
      /agent_not_ready|not connected/i,
    ],
    [
      'an unrecognized agent identity',
      readyTermWith('term_t', { agentIdentity: null }),
      /agent_not_ready|recognized/i,
    ],
    [
      'a different agent than the launched command',
      readyTermWith('term_t', { agentIdentity: 'codex' }),
      /agent_not_ready|recognized/i,
    ],
    [
      'a show receipt describing another terminal',
      { terminal: { handle: 'term_other', connected: true, agentIdentity: 'devin', agentWait: null } },
      /readiness_unproven|unidentified/i,
    ],
    [
      'a malformed show receipt',
      { unexpected: true },
      /readiness_unproven|no terminal record/i,
    ],
    [
      'a show receipt that omits agentWait entirely',
      { terminal: { handle: 'term_t', connected: true, agentIdentity: 'devin' } },
      /readiness_unproven|agentWait/i,
    ],
  ] as const) {
    it(`refuses worker-start when readiness shows ${name}`, async () => {
      const { adapter, calls } = makeAdapter((args) => {
        const cmd = args[1];
        if (cmd === 'create') return okTerm({ terminal: { handle: 'term_t' } }, 'rcpt-tc-1');
        if (cmd === 'wait') return okEnv({ idle: true }); // idle lies — trust screen reads idle
        if (cmd === 'show') return okTerm(showReply);
        return failEnv('unexpected_command', String(cmd));
      });
      const res = await adapter.launchWorker(launchSpec());
      assert.ok(res.ok);
      if (!res.ok) return;
      assert.equal(res.value.outcome, 'unknown', name);
      assert.match(res.value.detail ?? '', match);
      assert.ok(
        calls.every((a) => a[1] !== 'worker-start'),
        `worker-start must not run when readiness is unproven: ${name}`,
      );
      // The terminal handle is still surfaced for operator attention.
      assert.equal(res.value.terminalHandle, 'term_t');
    });
  }

  it('refuses worker-start when terminal show itself fails', async () => {
    const { adapter, calls } = makeAdapter((args) => {
      const cmd = args[1];
      if (cmd === 'create') return okTerm({ terminal: { handle: 'term_t' } }, 'rcpt-tc-1');
      if (cmd === 'wait') return okEnv({ idle: true });
      if (cmd === 'show') return failEnv('terminal_not_found', 'term_t');
      return failEnv('unexpected_command', String(cmd));
    });
    const res = await adapter.launchWorker(launchSpec());
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'unknown');
    assert.ok(calls.every((a) => a[1] !== 'worker-start'));
  });

  it('applies the same readiness proof to a retained terminal before reusing it', async () => {
    // Settled prior dispatch, but the retained terminal sits on a trust menu —
    // custody alone is not readiness.
    const { adapter, calls } = makeAdapter((args) =>
      args[1] === 'worker-list'
        ? okEnv({ workers: [{ dispatchId: 'ctx_old', terminal: 'term_keep', state: 'succeeded' }] })
        : args[1] === 'show'
          ? okTerm(readyTermWith('term_keep', { agentWait: 'workspace-trust' }))
          : okEnv({}),
    );
    const res = await adapter.launchWorker(launchSpec({ reuseTerminal: 'term_keep' }));
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'unknown');
    assert.ok(calls.every((a) => a[1] !== 'worker-start'), 'must not start on a trust-screen terminal');
  });
});

describe('OrcaAdapter mutation recovery', () => {
  it('requestShow maps Orca request states', async () => {
    const { adapter } = makeAdapter((args) =>
      args[1] === 'request-show' && args.includes('req-abs')
        ? okEnv({ requestId: 'req-abs', state: 'absent' })
        : args[1] === 'request-show' && args.includes('req-done')
          ? okEnv({ requestId: 'req-done', state: 'completed' })
          : failEnv('unexpected'),
    );
    const a = await adapter.requestShow('req-abs');
    assert.ok(a.ok);
    if (a.ok) assert.equal(a.value.state, 'absent');
    const c = await adapter.requestShow('req-done');
    assert.ok(c.ok);
    if (c.ok) assert.equal(c.value.state, 'completed');
  });

  it('retryMutation re-issues the logged argv with --retry-request only after absent', async () => {
    const { adapter, calls } = makeAdapter((args) => {
      if (args[1] === 'request-show') return okEnv({ requestId: 'req-ws-1', state: 'absent' });
      if (args[1] === 'create') return okTerm({ terminal: { handle: 'term_r' } }, 'rcpt-tc-1');
      if (args[1] === 'wait') return okEnv({ idle: true });
      if (args[1] === 'show') return okTerm({ terminal: { handle: 'term_r', connected: true, agentIdentity: 'devin', agentWait: null } });
      if (args[1] === 'worker-start') {
        return args.includes('--retry-request')
          ? okMut({ dispatchId: 'ctx_replayed', mutation: undefined }, 'req-ws-1')
          : okMut({ dispatchId: 'ctx_d1' }, 'req-ws-1');
      }
      return failEnv('unexpected_command', String(args[1]));
    });
    const launched = await adapter.launchWorker(launchSpec());
    assert.ok(launched.ok);
    const before = calls.length;
    const retry = await adapter.retryMutation('req-ws-1');
    assert.ok(retry.ok);
    if (!retry.ok) return;
    assert.equal(retry.value.state, 'reissued');
    // Exactly one new mutation: the identical argv + --retry-request <orca id>.
    const replay = calls[calls.length - 1];
    assert.equal(calls.length, before + 2, 'request-show probe + one re-issue'); // probe + reissue
    assert.deepEqual(replay.slice(0, 2), ['orchestration', 'worker-start']);
    const i = replay.indexOf('--retry-request');
    assert.equal(replay[i + 1], 'req-ws-1');
  });

  it('retryMutation does NOT re-issue when request-show proves completed/pending', async () => {
    for (const state of ['completed', 'pending']) {
      const { adapter, calls } = makeAdapter((args) =>
        args[1] === 'request-show'
          ? okEnv({ requestId: 'req-ws-1', state })
          : args[1] === 'create'
            ? okTerm({ terminal: { handle: 'term_r' } }, 'rcpt-tc-1')
            : args[1] === 'wait'
              ? okEnv({ idle: true })
              : args[1] === 'show'
                ? okTerm({ terminal: { handle: 'term_r', connected: true, agentIdentity: 'devin', agentWait: null } })
                : okMut({ dispatchId: 'ctx_d1' }, 'req-ws-1'),
      );
      await adapter.launchWorker(launchSpec());
      const before = calls.length;
      const retry = await adapter.retryMutation('req-ws-1');
      assert.ok(retry.ok);
      if (!retry.ok) return;
      assert.equal(retry.value.state, state === 'completed' ? 'completed' : 'pending');
      assert.equal(calls.length, before + 1, 'only the request-show probe, no re-issue');
    }
  });

  it('retryMutation refuses an id this process never logged — no fabricated argv', async () => {
    const { adapter, calls } = makeAdapter((args) =>
      args[1] === 'request-show' ? okEnv({ requestId: 'req-x', state: 'absent' }) : okEnv({}),
    );
    const res = await adapter.retryMutation('req-foreign');
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.state, 'refused');
    assert.ok(calls.every((a) => !a.includes('--retry-request')));
  });
});

describe('OrcaAdapter.observeWorker settled dispatches', () => {
  // Exact worker-show receipt captured on Orca 1.4.261 after the failed live
  // smoke: the organiser Task had finished and written roster.proposed.json,
  // yet observation reported 'idle' because only terminalState 'retained' was
  // recognized — the engine never admitted the artifact.
  const REAL_SETTLED_RECEIPT = {
    dispatchId: 'ctx_0c5cc9ffa889',
    taskId: 'task_4e757dfde09e',
    runId: 'run_29e9a8ec4853',
    state: 'succeeded',
    stage: 'settled',
    liveness: 'unverifiable',
    terminal: 'term_2432b953-4baa-4c55-9dfa-c568878ec198',
    terminalState: 'retained',
    workspace: 'C:\\orca\\worktrees\\wt',
    attention: ['unverifiable'],
    waitingOnHuman: 'unknown',
  };

  it('admits the real 1.4.261 receipt: state succeeded + retained terminal → finished/succeeded', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv(REAL_SETTLED_RECEIPT));
    const res = await adapter.observeWorker({ dispatchId: 'ctx_0c5cc9ffa889' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.liveness, 'finished');
    assert.equal(res.value.taskStatus, 'succeeded');
    assert.equal(res.value.terminalState, 'retained');
    assert.deepEqual(calls[0].slice(0, 2), ['orchestration', 'worker-show']);
  });

  it('reports a failed settlement as finished with the exact taskStatus', async () => {
    const { adapter } = makeAdapter(() =>
      okEnv({ ...REAL_SETTLED_RECEIPT, state: 'failed' }),
    );
    const res = await adapter.observeWorker({ dispatchId: 'ctx_0c5cc9ffa889' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.liveness, 'finished');
    assert.equal(res.value.taskStatus, 'failed');
  });

  it('preserves a failed verdict behind a generic settled state', async () => {
    // worker-list-style row: `state` is the lifecycle marker, `outcome` the
    // verdict — taskStatus must carry 'failed', not 'settled'.
    const { adapter } = makeAdapter(() =>
      okEnv({ ...REAL_SETTLED_RECEIPT, state: 'settled', outcome: 'failed' }),
    );
    const res = await adapter.observeWorker({ dispatchId: 'ctx_0c5cc9ffa889' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.liveness, 'finished');
    assert.equal(res.value.taskStatus, 'failed');
  });

  it('treats a stage-only settled marker as unverifiable — no verdict, no guessed success', async () => {
    const { state: _dropped, ...rec } = REAL_SETTLED_RECEIPT;
    const { adapter } = makeAdapter(() => okEnv(rec));
    const res = await adapter.observeWorker({ dispatchId: 'ctx_0c5cc9ffa889' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.liveness, 'unverifiable');
    assert.equal(res.value.taskStatus, undefined);
  });

  it('treats physical death / release without a verdict as unverifiable', async () => {
    for (const rec of [
      { dispatchId: 'ctx_p1', liveness: 'exited', terminalState: 'retained' },
      { dispatchId: 'ctx_p2', liveness: 'dead' },
      { dispatchId: 'ctx_p3', terminalState: 'released', stage: 'settled' },
      { dispatchId: 'ctx_p4', terminalState: 'release_pending' },
    ]) {
      const { adapter } = makeAdapter(() => okEnv(rec));
      const res = await adapter.observeWorker({ dispatchId: 'ctx_p1' });
      assert.ok(res.ok);
      if (!res.ok) return;
      assert.equal(res.value.liveness, 'unverifiable', JSON.stringify(rec));
    }
  });

  it('flags contradictory decisive fields instead of picking a verdict', async () => {
    const { adapter } = makeAdapter(() =>
      okEnv({ ...REAL_SETTLED_RECEIPT, state: 'succeeded', outcome: 'failed' }),
    );
    const res = await adapter.observeWorker({ dispatchId: 'ctx_0c5cc9ffa889' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.liveness, 'unverifiable');
    assert.match(res.value.detail ?? '', /conflict/i);
    assert.equal(res.value.taskStatus, undefined);
  });

  it('lets an explicit outcome verdict win over a non-decisive state', async () => {
    const { adapter } = makeAdapter(() =>
      okEnv({ ...REAL_SETTLED_RECEIPT, state: 'in_progress', outcome: 'succeeded' }),
    );
    const res = await adapter.observeWorker({ dispatchId: 'ctx_0c5cc9ffa889' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.liveness, 'finished');
    assert.equal(res.value.taskStatus, 'succeeded');
  });

  it('lets logical settlement win over a still-live retained session', async () => {
    const { adapter } = makeAdapter(() =>
      okEnv({ ...REAL_SETTLED_RECEIPT, liveness: 'live', waitingOnHuman: 'no' }),
    );
    const res = await adapter.observeWorker({ dispatchId: 'ctx_0c5cc9ffa889' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.liveness, 'finished');
    assert.equal(res.value.taskStatus, 'succeeded');
  });

  it('keeps genuinely in-progress work working — settlement priority cannot turn live work done', async () => {
    const { adapter } = makeAdapter(() =>
      okEnv({
        dispatchId: 'ctx_live1',
        taskId: 'task_live1',
        state: 'in_progress',
        stage: 'active',
        liveness: 'live',
        terminal: 'term_live1',
        terminalState: 'active',
        waitingOnHuman: 'no',
      }),
    );
    const res = await adapter.observeWorker({ dispatchId: 'ctx_live1' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.liveness, 'working');
    assert.equal(res.value.taskStatus, 'in_progress');
    assert.equal(res.value.terminalState, 'active');
  });

  it('stays honest on wrong/missing/unknown fields — unverifiable, never a guess', async () => {
    for (const rec of [
      {},
      { state: 'unknown', stage: '???', liveness: 'unverifiable' },
      { dispatchId: 'ctx_x', something: 'else' },
    ]) {
      const { adapter } = makeAdapter(() => okEnv(rec));
      const res = await adapter.observeWorker({ dispatchId: 'ctx_u1' });
      assert.ok(res.ok);
      if (!res.ok) return;
      assert.equal(res.value.liveness, 'unverifiable', JSON.stringify(rec));
      assert.match(res.value.detail ?? '', /decisive/);
    }
  });
});

describe('OrcaAdapter.observeWorker/sendNotification/stop/release', () => {
  it('maps liveness honestly and treats uncertain reads as unverifiable', async () => {
    const { adapter } = makeAdapter(() => okEnv({ liveness: 'live', outcome: 'in_progress', terminalState: 'active' }));
    const res = await adapter.observeWorker({ dispatchId: 'ctx_d1' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.liveness, 'working');
    assert.equal(res.value.terminalState, 'active');
  });

  it('returns unverifiable (not a guessed state) on an uncertain worker-show', async () => {
    const { adapter } = makeAdapter(() => failEnv('runtime_unavailable', 'temporarily unreachable'));
    const res = await adapter.observeWorker({ dispatchId: 'ctx_d1' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.liveness, 'unverifiable');
  });

  it('sends a bounded notification to a dispatch mailbox', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv({ messageId: 'msg_1' }));
    const res = await adapter.sendNotification({
      to: 'dispatch:ctx_d1',
      subject: 'envelope ready',
      body: 'see artifacts',
      taskId: 'task_1',
      dispatchId: 'ctx_d1',
    });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'sent');
    assert.equal(res.value.messageId, 'msg_1');
    const argv = calls[0];
    assert.ok(argv.includes('--to') && argv.includes('dispatch:ctx_d1'));
    assert.ok(argv.includes('--subject=envelope ready'));
  });

  it('refuses oversized bodies and malformed targets without spawning', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv({}));
    const big = await adapter.sendNotification({ to: 'dispatch:ctx_1', subject: 's', body: 'x'.repeat(9000) });
    assert.equal(big.ok, false);
    const badTo = await adapter.sendNotification({ to: 'no such target', subject: 's', body: 'b' });
    assert.equal(badTo.ok, false);
    assert.equal(calls.length, 0);
  });

  it('surfaces stop outcomes: stopped / refused / unknown', async () => {
    const { adapter: a1 } = makeAdapter(() => okEnv({ stopped: true }));
    assert.deepEqual((await a1.requestStop({ dispatchId: 'ctx_1', reason: 'cancel' })).ok && (await a1.requestStop({ dispatchId: 'ctx_1', reason: 'cancel' })).ok, true);

    const { adapter: a2 } = makeAdapter(() => failEnv('invalid_state', 'already settled'));
    const refused = await a2.requestStop({ dispatchId: 'ctx_1', reason: 'cancel' });
    assert.ok(refused.ok);
    if (refused.ok) assert.equal(refused.value.outcome, 'refused');

    const { adapter: a3 } = makeAdapter(() => failEnv('stop_unknown', 'fence unsure'));
    const unknown = await a3.requestStop({ dispatchId: 'ctx_1', reason: 'cancel' });
    assert.ok(unknown.ok);
    if (unknown.ok) assert.equal(unknown.value.outcome, 'unknown');
  });

  it('releases a settled worker terminal', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv({ released: true }));
    const res = await adapter.releaseWorker({ dispatchId: 'ctx_1' });
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.value.released, true);
    assert.deepEqual(calls[0].slice(0, 2), ['orchestration', 'worker-release']);
  });

  it('does NOT claim release on the observed retained release receipt (1.4.261)', async () => {
    // Exact worker-release receipt from the completed council diagnostic:
    // ok:true but state 'retained' — nothing was released.
    const { adapter } = makeAdapter(() =>
      okMut({
        dispatchId: 'ctx_c032111e1e93',
        state: 'retained',
        reason: 'user_requested',
        processAction: 'none',
        archive: null,
      }, 'req-rel-1'),
    );
    const res = await adapter.releaseWorker({ dispatchId: 'ctx_c032111e1e93' });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.released, false);
  });

  it('claims released only on explicit release proof', async () => {
    for (const rec of [
      { dispatchId: 'ctx_r1', state: 'released', archive: 'receipts/ctx_r1.json' },
      { released: true },
      { terminalState: 'released' },
    ]) {
      const { adapter } = makeAdapter(() => okEnv(rec));
      const res = await adapter.releaseWorker({ dispatchId: 'ctx_r' });
      assert.ok(res.ok);
      if (!res.ok) continue;
      assert.equal(res.value.released, true, JSON.stringify(rec));
    }
  });

  it('treats release_pending/unknown/refused/malformed release receipts as NOT released', async () => {
    for (const rec of [
      { dispatchId: 'ctx_u1', state: 'release_pending' },
      { dispatchId: 'ctx_u2', state: 'release_unknown' },
      { dispatchId: 'ctx_u3', state: 'refused' },
      { released: false },
      {},
      { something: 'else' },
    ]) {
      const { adapter } = makeAdapter(() => okEnv(rec));
      const res = await adapter.releaseWorker({ dispatchId: 'ctx_u' });
      assert.ok(res.ok);
      if (!res.ok) continue;
      assert.equal(res.value.released, false, JSON.stringify(rec));
    }
  });

  it('refuses release on CONFLICTING markers — unambiguous proof required', async () => {
    for (const rec of [
      { released: true, state: 'retained' },
      { released: false, state: 'released' },
      { state: 'released', terminalState: 'retained' },
      { released: true, terminalState: 'active' },
      { state: 'released', status: 'pending' },
    ]) {
      const { adapter } = makeAdapter(() => okEnv(rec));
      const res = await adapter.releaseWorker({ dispatchId: 'ctx_c' });
      assert.ok(res.ok);
      if (!res.ok) continue;
      assert.equal(res.value.released, false, JSON.stringify(rec));
    }
    // Consistent positive markers still confirm.
    const { adapter } = makeAdapter(() => okEnv({ released: true, state: 'released' }));
    const res = await adapter.releaseWorker({ dispatchId: 'ctx_ok' });
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.value.released, true);
  });

  it('keeps release command failures as errors with the uncertain flag preserved', async () => {
    const { adapter } = makeAdapter(() => failEnv('release_unknown', 'fence unsure'));
    const res = await adapter.releaseWorker({ dispatchId: 'ctx_1' });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.details?.uncertain, true);
  });

  it('claims stopped only on a confirmed stopped result', async () => {
    const { adapter } = makeAdapter(() => okEnv({ state: 'stopped' }));
    const res = await adapter.requestStop({ dispatchId: 'ctx_s', reason: 'cancel' });
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.value.outcome, 'stopped');
  });

  it('maps explicit surviving/ended stop-receipt states to refused, ambiguous ones to unknown', async () => {
    for (const [rec, expected] of [
      [{ state: 'in_progress', processAction: 'none' }, 'refused'],
      [{ state: 'retained', reason: 'user_requested' }, 'refused'],
      [{ stopped: false }, 'refused'],
      [{ state: 'settled' }, 'refused'],
      [{ state: 'refused' }, 'refused'],
      [{ refused: true }, 'refused'],
      [{}, 'unknown'],
      [{ state: 'unknown' }, 'unknown'],
    ] as const) {
      const { adapter } = makeAdapter(() => okEnv(rec));
      const res = await adapter.requestStop({ dispatchId: 'ctx_x', reason: 'cancel' });
      assert.ok(res.ok);
      if (res.ok) assert.equal(res.value.outcome, expected, JSON.stringify(rec));
    }
  });

  it('keeps unfamiliar/pending stop states and contradictory markers unknown', async () => {
    for (const rec of [
      { state: 'release_pending' },
      { state: 'pending' },
      { state: 'stop_unknown' },
      { state: 'some_future_state' },
      { stopped: true, state: 'in_progress' },
      { state: 'stopped', stopped: false },
      { state: 'stopped', refused: true },
      // A stopped vote must be unambiguous across EVERY supported field —
      // status/worker.state contradictions and unfamiliar states veto.
      { state: 'stopped', status: 'pending' },
      { stopped: true, state: 'stop_unknown' },
      { state: 'stopped', status: 'in_progress' },
      { state: 'stopped', worker: { state: 'in_progress' } },
    ]) {
      const { adapter } = makeAdapter(() => okEnv(rec));
      const res = await adapter.requestStop({ dispatchId: 'ctx_x', reason: 'cancel' });
      assert.ok(res.ok);
      if (res.ok) assert.equal(res.value.outcome, 'unknown', JSON.stringify(rec));
    }
    // Consistent stopped markers across fields still confirm.
    const { adapter } = makeAdapter(() => okEnv({ state: 'stopped', status: 'stopped' }));
    const res = await adapter.requestStop({ dispatchId: 'ctx_ok', reason: 'cancel' });
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.value.outcome, 'stopped');
  });

  it('notes unconfirmed retention when keep-open does not prove it', async () => {
    const { adapter } = makeAdapter((args) => {
      const cmd = args[1];
      if (cmd === 'create') return okTerm({ terminal: { handle: 'term_new1' } }, 'rcpt-tc-1');
      if (cmd === 'wait') return okEnv({ idle: true });
      if (cmd === 'show') return okTerm(readyTerm('term_new1'), 'rcpt-ts-1');
      if (cmd === 'worker-start') return okMut({ dispatchId: 'ctx_d1', terminal: 'term_new1' }, 'req-ws-1');
      if (cmd === 'worker-keep-open') return okMut({ state: 'released' }, 'req-ko-1'); // did NOT retain
      return failEnv('unexpected_command', String(cmd));
    });
    const res = await adapter.launchWorker(launchSpec({ retainTerminal: true }));
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'started');
    assert.match(res.value.detail ?? '', /did not confirm retention/);
  });

  it('warns on conflicting keep-open markers and stays silent on consistent proof', async () => {
    for (const koReceipt of [
      { kept: true, state: 'released' },
      { kept: false, state: 'retained' },
      { kept: true, state: 'active' },
      { kept: true, terminalState: 'released' },
      { kept: true, terminal: { state: 'active' } },
      {},
    ]) {
      const { adapter } = makeAdapter((args) => {
        const cmd = args[1];
        if (cmd === 'create') return okTerm({ terminal: { handle: 'term_new1' } }, 'rcpt-tc-1');
        if (cmd === 'wait') return okEnv({ idle: true });
        if (cmd === 'show') return okTerm(readyTerm('term_new1'), 'rcpt-ts-1');
        if (cmd === 'worker-start') return okMut({ dispatchId: 'ctx_d1', terminal: 'term_new1' }, 'req-ws-1');
        if (cmd === 'worker-keep-open') return okMut(koReceipt, 'req-ko-1');
        return failEnv('unexpected_command', String(cmd));
      });
      const res = await adapter.launchWorker(launchSpec({ retainTerminal: true }));
      assert.ok(res.ok);
      if (!res.ok) continue;
      assert.match(res.value.detail ?? '', /did not confirm retention/, JSON.stringify(koReceipt));
    }
    // Consistent positive markers confirm — no advisory detail.
    for (const koReceipt of [
      { kept: true, state: 'retained' },
      { kept: true, state: 'retained', terminalState: 'retained' },
    ]) {
      const { adapter } = makeAdapter((args) => {
        const cmd = args[1];
        if (cmd === 'create') return okTerm({ terminal: { handle: 'term_new1' } }, 'rcpt-tc-1');
        if (cmd === 'wait') return okEnv({ idle: true });
        if (cmd === 'show') return okTerm(readyTerm('term_new1'), 'rcpt-ts-1');
        if (cmd === 'worker-start') return okMut({ dispatchId: 'ctx_d1', terminal: 'term_new1' }, 'req-ws-1');
        if (cmd === 'worker-keep-open') return okMut(koReceipt, 'req-ko-1');
        return failEnv('unexpected_command', String(cmd));
      });
      const res = await adapter.launchWorker(launchSpec({ retainTerminal: true }));
      assert.ok(res.ok);
      if (!res.ok) continue;
      assert.equal(res.value.detail, undefined, JSON.stringify(koReceipt));
    }
  });
});

describe('adapter invariants', () => {
  it('never issues a consuming check or --ack across all operations', async () => {
    const { adapter, calls } = makeAdapter((args) => {
      if (args.includes('check') || args.includes('--ack')) {
        throw new Error('consuming mail call attempted');
      }
      if (args[1] === 'worker-list') return okEnv({ workers: [] });
      if (args[1] === 'create') return okEnv({ terminal: { handle: 'term_x' } });
      if (args[1] === 'wait') return okEnv({ idle: true });
      return okEnv({ dispatchId: 'ctx_d', run: { id: 'run_r' }, task: { id: 'task_t' }, messageId: 'msg_1' });
    });
    await adapter.createRun({ objective: 'o' });
    await adapter.createTask({ runId: 'run_r', specFilePath: 's.md', title: 't' });
    await adapter.launchWorker(launchSpec());
    await adapter.observeWorker({ dispatchId: 'ctx_d' });
    await adapter.sendNotification({ to: 'dispatch:ctx_d', subject: 's', body: 'b' });
    await adapter.requestStop({ dispatchId: 'ctx_d', reason: 'r' });
    await adapter.releaseWorker({ dispatchId: 'ctx_d' });
    for (const argv of calls) {
      assert.ok(!argv.includes('check'), `argv consumed mail: ${argv.join(' ')}`);
      assert.ok(!argv.includes('--ack'), `argv acked mail: ${argv.join(' ')}`);
    }
  });
});

describe('mapLiveness', () => {
  it('maps decisive fields and collapses ambiguity to unverifiable', () => {
    assert.equal(mapLiveness({ liveness: 'live' }), 'working');
    assert.equal(mapLiveness({ outcome: 'in_progress' }), 'working');
    assert.equal(mapLiveness({ outcome: 'succeeded' }), 'finished');
    assert.equal(mapLiveness({ state: 'stopped' }), 'finished');
    // Logical settlement beats a retained session's physical signals
    // (1.4.261 worker-show: state 'succeeded' + terminalState 'retained').
    assert.equal(mapLiveness({ state: 'succeeded' }), 'finished');
    assert.equal(mapLiveness({ state: 'failed' }), 'finished');
    assert.equal(mapLiveness({ state: 'cancelled' }), 'finished');
    assert.equal(mapLiveness({ state: 'abandoned' }), 'finished');
    assert.equal(mapLiveness({ outcome: 'failed', state: 'settled' }), 'finished');
    assert.equal(
      mapLiveness({ state: 'succeeded', liveness: 'live', terminalState: 'retained' }),
      'finished',
    );
    // No verdict → no 'finished': physical death, release transitions, and
    // verdict-less settled/done markers are not proof of success.
    assert.equal(mapLiveness({ stage: 'settled' }), 'unverifiable');
    assert.equal(mapLiveness({ state: 'settled' }), 'unverifiable');
    assert.equal(mapLiveness({ liveness: 'dead' }), 'unverifiable');
    assert.equal(mapLiveness({ liveness: 'exited' }), 'unverifiable');
    assert.equal(mapLiveness({ terminalState: 'released' }), 'unverifiable');
    assert.equal(mapLiveness({ state: 'succeeded', outcome: 'failed' }), 'unverifiable');
    assert.equal(mapLiveness({ state: 'in_progress', terminalState: 'retained' }), 'working');
    assert.equal(mapLiveness({ waitReason: 'permission prompt open' }), 'waiting_human');
    assert.equal(mapLiveness({ liveness: 'idle' }), 'idle');
    assert.equal(mapLiveness({ terminalState: 'retained' }), 'idle');
    assert.equal(mapLiveness({ state: 'unknown' }), 'unverifiable');
    assert.equal(mapLiveness({ something: 'else' }), 'unverifiable');
    assert.equal(mapLiveness({}), 'unverifiable');
  });
});
