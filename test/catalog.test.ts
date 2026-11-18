import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_CATALOG,
  CATALOG_EXECUTION_POLICY,
  CATALOG_VERSION,
  LAUNCH_POLICY_HASH,
  describeCatalog,
  resolveAgentLaunch,
  validateAgentChoice,
} from '../src/catalog.js';
import type { AgentChoice } from '../src/contracts.js';

const dev = (extra: Partial<AgentChoice> = {}): AgentChoice => ({
  agent: 'devin',
  model: 'swe-2-max',
  permissionMode: 'bypass',
  ...extra,
});

// ─── Catalog shape ───────────────────────────────────────────────────────────

test('catalog ships exactly the three documented agents', () => {
  assert.deepEqual(Object.keys(AGENT_CATALOG).sort(), ['claude', 'codex', 'devin']);
  for (const e of Object.values(AGENT_CATALOG)) {
    assert.equal(e.lane, 'argv');
    assert.equal(e.modelSelection, 'explicit');
    assert.ok(Object.keys(e.permissionModes).length > 0, `${e.agent} has explicit postures`);
  }
});

test('CATALOG_VERSION is a stable string; hash is 64-char sha256', () => {
  assert.equal(typeof CATALOG_VERSION, 'string');
  assert.match(LAUNCH_POLICY_HASH, /^[0-9a-f]{64}$/);
});

// ─── Exact argv rendering ────────────────────────────────────────────────────

test('devin bypass renders the original pin verbatim', () => {
  const r = resolveAgentLaunch(dev());
  assert.ok(r.ok);
  assert.deepEqual(r.value.command, ['devin', '--model', 'swe-2-max', '--permission-mode', 'dangerous']);
  assert.equal(r.value.expectedAgent, 'devin');
  assert.equal(r.value.verification, 'live-verified');
  assert.equal(r.value.accountMode, 'ambient');
});

test('devin native postures render their own tokens', () => {
  const r = resolveAgentLaunch(dev({ permissionMode: 'smart' }));
  assert.ok(r.ok);
  assert.deepEqual(r.value.command, ['devin', '--model', 'swe-2-max', '--permission-mode', 'smart']);
});

test('claude renders model, mapped posture and verified effort', () => {
  const r = resolveAgentLaunch({
    agent: 'claude', model: 'claude-sonnet-4-6', permissionMode: 'bypass', effort: 'high',
  });
  assert.ok(r.ok);
  assert.deepEqual(r.value.command, [
    'claude', '--model', 'claude-sonnet-4-6', '--permission-mode', 'bypassPermissions', '--effort', 'high',
  ]);
  assert.equal(r.value.accountMode, 'ambient');
});

test('codex renders sandbox+approval posture pair and named profile', () => {
  const r = resolveAgentLaunch({
    agent: 'codex', model: 'gpt-6-astra', permissionMode: 'auto', profile: 'work',
  });
  assert.ok(r.ok);
  assert.deepEqual(r.value.command, [
    'codex', '--model', 'gpt-6-astra', '--sandbox', 'workspace-write',
    '--ask-for-approval', 'on-request', '--profile', 'work',
  ]);
  assert.equal(r.value.accountMode, 'named-profile');
});

test('codex read-only posture renders documented pair', () => {
  const r = resolveAgentLaunch({ agent: 'codex', model: 'm1', permissionMode: 'read-only' });
  assert.ok(r.ok);
  assert.deepEqual(r.value.command, [
    'codex', '--model', 'm1', '--sandbox', 'read-only', '--ask-for-approval', 'never',
  ]);
});

test('provider/model selector syntax is accepted as data', () => {
  const r = resolveAgentLaunch({ agent: 'claude', model: 'provider/claude-x:level', permissionMode: 'auto' });
  assert.ok(r.ok);
  assert.deepEqual(r.value.command[2], 'provider/claude-x:level');
});

// ─── Rejects — never a substitute or fallback ────────────────────────────────

test('unknown agent is unsupported, not substituted', () => {
  const r = resolveAgentLaunch({ agent: 'gpt', model: 'm', permissionMode: 'auto' });
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'unsupported');
  assert.equal(validateAgentChoice({ agent: 'gpt', model: 'm', permissionMode: 'auto' }).ok, false);
});

test('inherited property names never resolve to catalog entries — error, never throw', () => {
  // 'constructor'/'toString' are valid token-charset strings that resolve to
  // inherited Object.prototype members — they must hit a clean Result error.
  for (const agent of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    let r!: ReturnType<typeof resolveAgentLaunch>;
    assert.doesNotThrow(() => { r = resolveAgentLaunch({ agent, model: 'm', permissionMode: 'auto' }); });
    assert.ok(!r.ok, `agent ${agent} must not resolve`);
    assert.equal(r.error.code, 'unsupported');
    assert.doesNotThrow(() => validateAgentChoice({ agent, model: 'm', permissionMode: 'auto' }));
  }
});

test('inherited posture names never reach the argv spread — error, never throw', () => {
  for (const permissionMode of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    let r!: ReturnType<typeof resolveAgentLaunch>;
    assert.doesNotThrow(() => { r = resolveAgentLaunch(dev({ permissionMode })); });
    assert.ok(!r.ok, `posture ${permissionMode} must not resolve to an inherited member`);
    assert.equal(r.error.code, 'unsupported');
  }
  // A successful resolve must emit only string tokens — never an inherited fn.
  const r = resolveAgentLaunch(dev());
  assert.ok(r.ok);
  assert.ok(r.value.command.every((t) => typeof t === 'string'));
});

test('model values reject PowerShell/flag-leading and shell-hostile forms', () => {
  for (const model of ['@worker/x:y', '@model', '-rf', '--help', 'm;rm -rf', 'a|b', '$(id)', 'x`y`', 'a b', '>out', 'p&&q']) {
    const r = resolveAgentLaunch(dev({ model }));
    assert.ok(!r.ok, `model ${JSON.stringify(model)} must be rejected`);
    assert.equal(r.error.code, 'config_invalid');
  }
  // provider/model:level selector syntax remains accepted as opaque data
  assert.ok(resolveAgentLaunch({ agent: 'claude', model: 'provider/claude-x:level', permissionMode: 'auto' }).ok);
  assert.ok(resolveAgentLaunch(dev({ model: 'vendor+build/model_v2.1:fast' })).ok);
});

test('profile is a strictly named grammar — paths and selectors rejected', () => {
  for (const profile of ['../x', 'a/b', 'a\\b', 'a:b', '@p', '.hidden', '-p', 'a+b', 'work dir']) {
    const r = resolveAgentLaunch({ agent: 'codex', model: 'm', permissionMode: 'auto', profile });
    assert.ok(!r.ok, `profile ${JSON.stringify(profile)} must be rejected`);
    assert.equal(r.error.code, 'config_invalid');
  }
  for (const profile of ['work', 'team-a', 'ops.dev', 'p1']) {
    const r = resolveAgentLaunch({ agent: 'codex', model: 'm', permissionMode: 'auto', profile });
    assert.ok(r.ok, `profile ${JSON.stringify(profile)} must be accepted`);
    assert.deepEqual(r.value.command.slice(-2), ['--profile', profile]);
  }
});

test('posture outside the explicit map is unsupported', () => {
  const r = resolveAgentLaunch(dev({ permissionMode: 'yolo' }));
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'unsupported');
});

test('effort is refused on agents without a verified selector', () => {
  for (const agent of ['devin', 'codex']) {
    const r = resolveAgentLaunch({ agent, model: 'm', permissionMode: agent === 'devin' ? 'bypass' : 'auto', effort: 'high' });
    assert.ok(!r.ok, `${agent} effort must be refused`);
    assert.equal(r.error.code, 'unsupported');
  }
});

test('claude effort outside verified tokens is refused', () => {
  const r = resolveAgentLaunch({ agent: 'claude', model: 'm', permissionMode: 'auto', effort: 'ultra' });
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'unsupported');
});

test('named profile is refused where no documented selector exists', () => {
  for (const agent of ['devin', 'claude']) {
    const r = resolveAgentLaunch({ agent, model: 'm', permissionMode: 'bypass', profile: 'work' });
    assert.ok(!r.ok, `${agent} profile must be refused`);
    assert.equal(r.error.code, 'unsupported');
  }
});

test('shell punctuation in any value token is rejected', () => {
  const bad = ['m;rm -rf', 'a|b', '$(id)', 'x`y`', 'a b', '>out', 'p&&q'];
  for (const model of bad) {
    const r = resolveAgentLaunch(dev({ model }));
    assert.ok(!r.ok, `model ${JSON.stringify(model)} must be rejected`);
    assert.equal(r.error.code, 'config_invalid');
  }
  const r = resolveAgentLaunch({ agent: 'codex', model: 'm', permissionMode: 'auto', profile: '../etc/passwd' });
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'config_invalid');
});

test('no fallback fields exist in emitted argv', () => {
  const r = resolveAgentLaunch({ agent: 'claude', model: 'm', permissionMode: 'auto' });
  assert.ok(r.ok);
  assert.ok(!r.value.command.includes('--fallback-model'));
  assert.ok(!r.value.command.includes('--settings'));
  assert.ok(!r.value.command.includes('--dangerously-skip-permissions'));
});

// ─── validateAgentChoice mirrors resolve ─────────────────────────────────────

test('validateAgentChoice accepts every valid combination resolve accepts', () => {
  const good: AgentChoice[] = [
    dev(),
    dev({ permissionMode: 'auto' }),
    { agent: 'claude', model: 'sonnet', permissionMode: 'plan', effort: 'low' },
    { agent: 'codex', model: 'o3', permissionMode: 'bypass', profile: 'team-a' },
  ];
  for (const c of good) {
    assert.equal(validateAgentChoice(c).ok, true, JSON.stringify(c));
    assert.equal(resolveAgentLaunch(c).ok, true, JSON.stringify(c));
  }
});

// ─── Policy fingerprint and execution policy ─────────────────────────────────

test('LAUNCH_POLICY_HASH is deterministic across calls', async () => {
  const fresh = await import('../src/catalog.js');
  assert.equal(fresh.LAUNCH_POLICY_HASH, LAUNCH_POLICY_HASH);
});

test('CATALOG_EXECUTION_POLICY binds the shipped hash and validator', () => {
  assert.equal(CATALOG_EXECUTION_POLICY.policyHash, LAUNCH_POLICY_HASH);
  assert.equal(CATALOG_EXECUTION_POLICY.validateChoice(dev()).ok, true);
  assert.equal(
    CATALOG_EXECUTION_POLICY.validateChoice({ agent: 'nobody', model: 'm', permissionMode: 'auto' }).ok,
    false,
  );
});

// ─── describeCatalog ─────────────────────────────────────────────────────────

test('describeCatalog exposes sorted, honest presentation data', () => {
  const d = describeCatalog();
  assert.equal(d.length, 3);
  const byAgent = Object.fromEntries(d.map((e) => [e.agent, e]));
  assert.equal(byAgent.devin.verification, 'live-verified');
  assert.equal(byAgent.claude.effortFlag, '--effort');
  assert.deepEqual([...byAgent.claude.effortValues!].sort(), ['high', 'low', 'max', 'medium']);
  assert.equal(byAgent.codex.profileFlag, '--profile');
  assert.equal(byAgent.devin.profileFlag, null);
  assert.equal(byAgent.claude.profileFlag, null);
  // Sorted posture tokens for stable output
  for (const e of d) {
    const sorted = [...e.permissionModes].sort();
    assert.deepEqual(e.permissionModes, sorted);
  }
});
