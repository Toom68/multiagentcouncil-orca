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
const failEnv = (code: string, message = 'm', data?: unknown) =>
  proc({
    exitCode: 1,
    stdout: JSON.stringify({ ok: false, error: { code, message, ...(data === undefined ? {} : { data }) } }),
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
  it('creates a run with explicit retry-request and returns the id', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv({ run: { id: 'run_c1' } }));
    const res = await adapter.createRun({ objective: 'review the thing' });
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.value.runId, 'run_c1');
    const argv = calls[0];
    assert.deepEqual(argv.slice(0, 2), ['orchestration', 'run-create']);
    assert.ok(argv.includes('--objective=review the thing'));
    assert.ok(argv.includes('--json'));
    const k = argv.indexOf('--retry-request');
    assert.match(argv[k + 1], /^council-run-/);
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
  const devinLaunchHandler = (): ((args: readonly string[]) => ProcessResult) => (args) => {
    const cmd = args[1];
    if (cmd === 'create') return okEnv({ terminal: { handle: 'term_new1' } });
    if (cmd === 'wait') return okEnv({ idle: true });
    if (cmd === 'worker-start') return okEnv({ dispatchId: 'ctx_d1', terminal: 'term_new1' });
    if (cmd === 'worker-keep-open') return okEnv({ kept: true });
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
    assert.equal(calls.length, 3);

    const create = calls[0];
    assert.deepEqual(create.slice(0, 2), ['terminal', 'create']);
    const cmdArg = create.find((a) => a.startsWith('--command='));
    // Devin CLI --permission-mode accepts only auto|accept-edits|smart|dangerous
    // (verified on this host). "bypass" is user-facing config vocabulary and
    // must be mapped to "dangerous" — never emitted to the CLI.
    assert.equal(cmdArg, '--command=devin --model swe-2-max --permission-mode dangerous');
    assert.doesNotMatch(cmdArg ?? '', /bypass/);

    const start = calls[2];
    assert.deepEqual(start.slice(0, 2), ['orchestration', 'worker-start']);
    for (const flag of ['--task', '--run', '--terminal', '--worktree', '--retry-request', '--json']) {
      assert.ok(start.includes(flag), `missing ${flag}`);
    }
    assert.ok(start.includes('task_aaa'));
    assert.ok(start.includes('term_new1'));
  });

  it('marks the dispatch for retention when retainTerminal is set', async () => {
    const { adapter, calls } = makeAdapter(devinLaunchHandler());
    const res = await adapter.launchWorker(launchSpec({ retainTerminal: true }));
    assert.ok(res.ok);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[3].slice(0, 2), ['orchestration', 'worker-keep-open']);
    assert.ok(calls[3].includes('ctx_d1'));
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

  it('rejects non-allowlisted model/permission values — no config fallback', async () => {
    const { adapter, calls } = makeAdapter(() => okEnv({}));
    const badModel = await adapter.launchWorker(
      launchSpec({ agent: { agent: 'devin', model: 'swe-2-lightning', permissionMode: 'bypass' } }),
    );
    assert.equal(badModel.ok, false);
    if (!badModel.ok) assert.equal(badModel.error.code, 'unsupported');

    // Valid Devin CLI modes that are NOT the approved council posture are
    // rejected too — the allowlist is the approval boundary.
    for (const pm of ['yolo', 'auto', 'smart', 'accept-edits']) {
      const badPerm = await adapter.launchWorker(
        launchSpec({ agent: { agent: 'devin', model: 'swe-2-max', permissionMode: pm } }),
      );
      assert.equal(badPerm.ok, false, pm);
    }
    assert.equal(calls.length, 0);
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

  it('reports unknown outcome for an uncertain worker-start reply', async () => {
    const { adapter } = makeAdapter((args) =>
      args[1] === 'worker-start' ? failEnv('outcome_unknown', 'request timed out; effect unknown') :
      args[1] === 'worker-list' ? okEnv({ workers: [] }) :
      okEnv({ terminal: { handle: 'term_x' }, idle: true }),
    );
    const res = await adapter.launchWorker(launchSpec({ retainTerminal: false }));
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'unknown');
    assert.match(res.value.requestId ?? '', /^council-launch-/);
  });

  it('reports unknown outcome when the launch reply cannot be parsed', async () => {
    const { adapter } = makeAdapter((args) =>
      args[1] === 'worker-start' ? proc({ exitCode: 0, stdout: '<html>oops</html>' }) :
      okEnv({ terminal: { handle: 'term_x' }, idle: true }),
    );
    const res = await adapter.launchWorker(launchSpec());
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.outcome, 'unknown');
  });

  it('derives a deterministic requestId so a retry replays the same mutation', async () => {
    const handler = devinLaunchHandler();
    const { adapter, calls } = makeAdapter(handler);
    const spec = launchSpec();
    await adapter.launchWorker(spec);
    await adapter.launchWorker(spec);
    const keys = calls
      .map((argv) => {
        const i = argv.indexOf('--retry-request');
        return i >= 0 ? argv[i + 1] : null;
      })
      .filter((k): k is string => k !== null && k.startsWith('council-launch-'));
    assert.equal(new Set(keys).size, 1, 'launch retries must reuse one request key');
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
    assert.equal(mapLiveness({ waitReason: 'permission prompt open' }), 'waiting_human');
    assert.equal(mapLiveness({ liveness: 'idle' }), 'idle');
    assert.equal(mapLiveness({ something: 'else' }), 'unverifiable');
    assert.equal(mapLiveness({}), 'unverifiable');
  });
});
