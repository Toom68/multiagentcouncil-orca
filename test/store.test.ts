/**
 * Tests for src/store.ts — run from dist/test against OS temp dirs.
 * Covers initialize/persist-restart, atomic safe-relative artifact IO
 * (traversal + symlink/junction escapes), the append-only hash-linked
 * journal (concurrent appends, corruption/truncation detection, refusal to
 * extend a corrupt chain), the process lock (serialization, non-reentrancy,
 * dead-pid reclaim, live-owner timeout), roster validation, approval hash
 * binding, and verifySourceSnapshot drift detection including the exclusion
 * of the run's own .council-dev artifacts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  ApprovedRoster,
  ApprovalBinding,
  ApprovalRecord,
  CouncilConfig,
  JournalEvent,
  ProposedRoster,
  SourceSnapshot,
} from '../src/contracts.js';
import { SCHEMA_VERSION } from '../src/contracts.js';
import { captureSnapshot } from '../src/snapshot.js';
import { createStore, STORE_PATHS, writeFully, type Store } from '../src/store.js';
import {
  canonicalApprovalHash,
  canonicalRosterHash,
  resolveConfig,
} from '../src/validation.js';

// ─── fixture helpers ─────────────────────────────────────────────────────────

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'council-store-'));
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function config(): CouncilConfig {
  const r = resolveConfig({ requestedPerspectives: 10, participants: 2, rounds: 1 });
  assert.ok(r.ok);
  return r.value;
}

function proposal(runId: string, count = 10): ProposedRoster {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    perspectives: Array.from({ length: count }, (_, i) => ({
      perspectiveId: `p${i + 1}`,
      name: `Perspective ${i + 1}`,
      charter: {
        incentives: `incentives ${i + 1}`,
        expertise: `expertise ${i + 1}`,
        method: `method ${i + 1}`,
        blindSpots: `blind spots ${i + 1}`,
        reviewQuestions: [`question ${i + 1}?`],
      },
      tags: [`t${i + 1}`],
    })),
  };
}

function approved(runId: string, prop: ProposedRoster, seats = 2): ApprovedRoster {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    seats: prop.perspectives.slice(0, seats).map((p, i) => ({
      seatId: `s${i + 1}`,
      perspectiveId: p.perspectiveId,
      participantId: `w${i + 1}`,
      agent: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
    })),
  };
}

const RUN_ID = 'crun_test123';
const OBJECTIVE = 'review the widget for defects';

/** Build a target tree and capture a snapshot for initialize(). */
async function makeTarget(): Promise<{ targetRoot: string; snapshot: SourceSnapshot }> {
  const targetRoot = tmp();
  writeTree(targetRoot, {
    'src/main.ts': 'export const main = 1;\n',
    'README.md': '# target\n',
  });
  const snap = await captureSnapshot(targetRoot);
  assert.ok(snap.ok, JSON.stringify(snap));
  return { targetRoot, snapshot: snap.value };
}

async function initStore(
  runDir: string,
): Promise<{ store: Store; snapshot: SourceSnapshot; targetRoot: string }> {
  const { targetRoot, snapshot } = await makeTarget();
  const store = createStore({ runDir });
  const r = await store.initialize({
    runId: RUN_ID,
    targetRoot,
    objective: OBJECTIVE,
    config: config(),
    snapshot,
  });
  assert.ok(r.ok, JSON.stringify(r));
  return { store, snapshot, targetRoot };
}

function ev(type: JournalEvent['type'], actor = 'engine'): Omit<JournalEvent, 'seq'> {
  return { ts: new Date().toISOString(), type, actor };
}

const lineHashOf = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

// ─── initialize / persistence ────────────────────────────────────────────────

test('initialize writes stable artifacts and a valid initial state', async () => {
  const runDir = path.join(tmp(), 'run');
  const { snapshot } = await initStore(runDir);

  for (const p of [
    STORE_PATHS.council,
    STORE_PATHS.state,
    STORE_PATHS.objective,
    STORE_PATHS.snapshot,
    STORE_PATHS.journal,
  ]) {
    assert.ok(existsSync(path.join(runDir, p)), `missing ${p}`);
  }
  const meta = JSON.parse(readFileSync(path.join(runDir, STORE_PATHS.council), 'utf8'));
  assert.equal(meta.runId, RUN_ID);
  assert.equal(readFileSync(path.join(runDir, STORE_PATHS.objective), 'utf8'), `${OBJECTIVE}\n`);
  // Journal is born with the genesis integrity marker as seq 1 (v1 runs are
  // never both non-empty and unmarked — see src/artifacts.ts policy rules).
  const journalLines = readFileSync(path.join(runDir, STORE_PATHS.journal), 'utf8')
    .trim()
    .split('\n');
  assert.equal(journalLines.length, 1);
  const genesis = JSON.parse(journalLines[0]);
  assert.equal(genesis.seq, 1);
  assert.equal(genesis.type, 'run.initialized');
  assert.equal(genesis.payload.integrity, 'receipts-v1');
  assert.equal(genesis.payload.runId, RUN_ID);
  assert.equal(genesis.payload.snapshotId, snapshot.snapshotId);
  assert.equal(genesis.prevHash, undefined, 'chain head carries no prevHash');

  const store = createStore({ runDir });
  const state = await store.loadState();
  assert.ok(state.ok, JSON.stringify(state));
  assert.equal(state.value.status, 'initialized');
  assert.equal(state.value.runId, RUN_ID);
  assert.equal(state.value.snapshotId, snapshot.snapshotId);
  assert.equal(state.value.supervisor, null); // left for the CLI/supervisor
  assert.equal(state.value.approvalHash, null);
  assert.equal(state.value.targetRoot, snapshot.targetRoot);
});

test('initialize refuses to clobber an existing run', async () => {
  const runDir = path.join(tmp(), 'run');
  const { snapshot, targetRoot } = await initStore(runDir);
  const store = createStore({ runDir });
  const r = await store.initialize({
    runId: 'crun_other',
    targetRoot,
    objective: 'again',
    config: config(),
    snapshot,
  });
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'already_initialized');
  // Original artifacts untouched.
  const meta = JSON.parse(readFileSync(path.join(runDir, STORE_PATHS.council), 'utf8'));
  assert.equal(meta.runId, RUN_ID);
});

test('a fresh store on the same dir loads persisted state and journal', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  const appended = await store.appendJournal([ev('run.initialized'), ev('phase.entered')]);
  assert.ok(appended.ok);

  const reopened = createStore({ runDir });
  const state = await reopened.loadState();
  assert.ok(state.ok);
  const journal = await reopened.readJournal();
  assert.ok(journal.ok);
  assert.deepEqual(journal.value.map((e) => e.seq), [1, 2, 3]);
  assert.equal(journal.value[0].type, 'run.initialized');
  assert.equal(journal.value[0].payload?.integrity, 'receipts-v1');
});

test('snapshot target mismatch is refused at initialize', async () => {
  const runDir = path.join(tmp(), 'run');
  const { snapshot } = await makeTarget();
  const other = await makeTarget(); // different tree
  const store = createStore({ runDir });
  const r = await store.initialize({
    runId: RUN_ID,
    targetRoot: other.targetRoot,
    objective: OBJECTIVE,
    config: config(),
    snapshot,
  });
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'snapshot_target_mismatch');
  assert.equal(existsSync(path.join(runDir, STORE_PATHS.state)), false);
});

// ─── artifact IO ─────────────────────────────────────────────────────────────

test('artifact write/read/exists/list roundtrip, nested dirs allowed', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);

  assert.ok((await store.writeArtifact('findings/w1.json', '{"a":1}\n')).ok);
  assert.ok((await store.writeArtifact('rounds/1/challenges/w1.json', '[]')).ok);
  const read = await store.readArtifact('findings/w1.json');
  assert.ok(read.ok);
  assert.deepEqual(read.value, '{"a":1}\n');
  // rename-over-existing works on Windows and POSIX
  assert.ok((await store.writeArtifact('findings/w1.json', '{"a":2}\n')).ok);
  const read2 = await store.readArtifact('findings/w1.json');
  assert.ok(read2.ok);
  assert.deepEqual(read2.value, '{"a":2}\n');
  const exists = await store.artifactExists('findings/w1.json');
  assert.ok(exists.ok && exists.value === true);
  const missing = await store.artifactExists('findings/nope.json');
  assert.ok(missing.ok && missing.value === false);

  const list = await store.listArtifacts('findings');
  assert.ok(list.ok);
  assert.deepEqual(list.value, ['findings/w1.json']);
  const all = await store.listArtifacts('');
  assert.ok(all.ok);
  assert.ok(all.value.includes('findings/w1.json'));
  assert.ok(all.value.includes('rounds/1/challenges/w1.json'));
  assert.ok(
    all.value.every((p) => p !== STORE_PATHS.lock),
    'lock file hidden',
  );
  assert.deepEqual([...all.value].sort(), all.value, 'sorted output');
});

test('artifact paths refuse traversal, absolutes, and colon tricks', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  for (const bad of [
    '../outside.txt',
    'a/../../outside.txt',
    '/abs.txt',
    'C:/win.txt',
    'a//b.txt',
    './x.txt',
    'x\\y.txt',
  ]) {
    const w = await store.writeArtifact(bad, 'x');
    assert.ok(!w.ok, `write ${bad} should fail`);
    assert.equal(w.error.details?.reason, 'unsafe_path');
    const r = await store.readArtifact(bad);
    assert.ok(!r.ok, `read ${bad} should fail`);
  }
});

test('artifact IO refuses symlink escapes (junction to outside dir)', async (t) => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  const outside = tmp();
  writeFileSync(path.join(outside, 'loot.txt'), 'loot');
  try {
    symlinkSync(
      outside,
      path.join(runDir, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (e) {
    t.skip(`cannot create dir link: ${e}`);
    return;
  }
  const w = await store.writeArtifact('escape/pwned.txt', 'x');
  assert.ok(!w.ok);
  assert.equal(w.error.details?.reason, 'symlink_escape');
  const r = await store.readArtifact('escape/loot.txt');
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'symlink_escape');
  const l = await store.listArtifacts('escape');
  assert.ok(!l.ok);
  assert.equal(l.error.details?.reason, 'symlink_escape');
});

test('atomic writes leave no temp files and prior content survives failure', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  assert.ok((await store.writeArtifact('good.json', '{"ok":1}')).ok);
  // A refused write must not have touched anything.
  assert.ok(!(await store.writeArtifact('../bad', 'x')).ok);
  const back = await store.readArtifact('good.json');
  assert.ok(back.ok);
  assert.deepEqual(back.value, '{"ok":1}');
  const leftovers = readdirSync(runDir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'no temp files left behind');
});

// ─── journal ─────────────────────────────────────────────────────────────────

test('journal appends are sequential and hash-linked', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  const a = await store.appendJournal([ev('run.initialized'), ev('phase.entered', 'engine')]);
  assert.ok(a.ok);
  assert.deepEqual(a.value.map((e) => e.seq), [2, 3]);
  assert.equal(a.value[0].prevHash, lineHashOf(readFileSync(path.join(runDir, STORE_PATHS.journal), 'utf8').split('\n')[0]));
  const b = await store.appendJournal([ev('artifact.written')]);
  assert.ok(b.ok);
  assert.equal(b.value[0].seq, 4);

  const lines = readFileSync(path.join(runDir, STORE_PATHS.journal), 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 4);
  assert.equal(JSON.parse(lines[1]).prevHash, lineHashOf(lines[0]));
  assert.equal(JSON.parse(lines[2]).prevHash, lineHashOf(lines[1]));
  assert.equal(JSON.parse(lines[3]).prevHash, lineHashOf(lines[2]));
  const all = await store.readJournal();
  assert.ok(all.ok);
  assert.equal(all.value.length, 4);
});

test('writeFully completes short writes and fails on a stalled handle', async () => {
  // A single write() syscall may accept only part of the buffer — the journal
  // append must loop until the whole block is out, or the hash-chained tail
  // silently truncates and every later event fails the chain.
  const sink: number[] = [];
  const partialFh = {
    calls: 0,
    async write(buf: Buffer, offset = 0) {
      this.calls += 1;
      const n = Math.min(7, buf.length - offset); // always accept at most 7 bytes
      for (let i = 0; i < n; i++) sink.push(buf[offset + i]);
      return { bytesWritten: n };
    },
  };
  const buf = Buffer.from('x'.repeat(100), 'utf8');
  await writeFully(partialFh, buf);
  assert.equal(sink.length, 100, 'every byte landed despite short writes');
  assert.ok(partialFh.calls > 1, 'the loop actually iterated');
  assert.deepEqual(Buffer.from(sink).toString('utf8'), 'x'.repeat(100), 'byte order preserved');

  const stalled = { async write() { return { bytesWritten: 0 }; } };
  await assert.rejects(writeFully(stalled, buf), /stalled/, 'a zero-byte write must fail, not spin');
});

test('concurrent appends across store instances lose no events', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  const other = createStore({ runDir });
  const stores = [store, other];
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      stores[i % 2].appendJournal([
        { ...ev('artifact.admitted'), payload: { i } },
        ev('mail.sent'),
      ]),
    ),
  );
  for (const r of results) assert.ok(r.ok, JSON.stringify(r));
  const all = await store.readJournal();
  assert.ok(all.ok);
  assert.equal(all.value.length, 25);
  assert.deepEqual(
    all.value.map((e) => e.seq),
    Array.from({ length: 25 }, (_, i) => i + 1),
    'contiguous seq under concurrency',
  );
  const is = new Set<number>();
  for (const e of all.value) {
    if (typeof e.payload?.i === 'number') {
      assert.ok(!is.has(e.payload.i), 'duplicate append detected');
      is.add(e.payload.i);
    }
  }
  assert.equal(is.size, 12);
});

test('journal read detects garbage, truncation, seq gaps and hash tampering', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  assert.ok((await store.appendJournal([ev('run.initialized'), ev('phase.entered')])).ok);
  const journalPath = path.join(runDir, STORE_PATHS.journal);
  const good = readFileSync(journalPath, 'utf8');

  // garbage line appended manually
  await fsp.appendFile(journalPath, 'not json\n');
  let r = await store.readJournal();
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'journal_corrupt');

  // truncated tail (no newline, cut mid-line)
  writeFileSync(journalPath, good + good.split('\n')[0].slice(0, 10));
  r = await store.readJournal();
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'journal_corrupt');

  // seq gap: rewrite with seq 1 then 3
  writeFileSync(
    journalPath,
    good.split('\n')[0] + '\n' + JSON.stringify({ seq: 3, ts: 't', type: 'error', actor: 'x' }) + '\n',
  );
  r = await store.readJournal();
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'journal_corrupt');
  assert.match(String(r.error.details?.cause), /seq 3, expected 2/);

  // hash tamper: valid second event with wrong prevHash
  const line1 = good.split('\n')[0];
  const tampered2 = JSON.stringify({
    seq: 2,
    ts: 't',
    type: 'error',
    actor: 'x',
    prevHash: '0'.repeat(64),
  });
  writeFileSync(journalPath, line1 + '\n' + tampered2 + '\n');
  r = await store.readJournal();
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'journal_corrupt');
});

test('appendJournal refuses to extend a corrupt chain', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  assert.ok((await store.appendJournal([ev('run.initialized')])).ok);
  await fsp.appendFile(path.join(runDir, STORE_PATHS.journal), 'garbage\n');
  const r = await store.appendJournal([ev('phase.entered')]);
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'journal_corrupt');
});

test('journal events failing schema validation are rejected before writing', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  const bad = { ts: 'x', type: 'nope', actor: 'x' } as unknown as Omit<JournalEvent, 'seq'>;
  const r = await store.appendJournal([bad]);
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'schema_invalid');
  const all = await store.readJournal();
  assert.ok(all.ok);
  assert.equal(all.value.length, 1, 'only the genesis marker — nothing appended');
});

// ─── locking ─────────────────────────────────────────────────────────────────

test('withLock serializes mutations; internal appends run under the outer lock', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  const order: string[] = [];
  const r1 = store.withLock(async () => {
    order.push('a-start');
    const inner = await store.appendJournal([ev('phase.entered')]); // internal lock aware
    assert.ok(inner.ok);
    await new Promise((r) => setTimeout(r, 50));
    order.push('a-end');
    return { ok: true, value: 'A' };
  });
  const r2 = store.withLock(async () => {
    order.push('b');
    return { ok: true, value: 'B' };
  });
  const [a, b] = await Promise.all([r1, r2]);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(order, ['a-start', 'a-end', 'b'], 'second withLock waited');
  const all = await store.readJournal();
  assert.ok(all.ok && all.value.length === 2); // genesis marker + appended event
});

test('journal appends inside a lock session cannot interleave with outside appends', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  // An append running inside withLock plus raw sibling appends: every event
  // must land with a unique contiguous seq — no lost/torn lines.
  const inside = store.withLock(async () => {
    const r = await store.appendJournal([ev('phase.entered'), ev('worker.started')]);
    assert.ok(r.ok);
    return r as { ok: true; value: JournalEvent[] };
  });
  const siblings = await Promise.all([
    inside,
    store.appendJournal([ev('mail.sent')]),
    store.appendJournal([ev('mail.observed')]),
  ]);
  for (const r of siblings) assert.ok(r.ok, JSON.stringify(r));
  const all = await store.readJournal();
  assert.ok(all.ok);
  assert.equal(all.value.length, 5); // genesis marker + 4 appended
  assert.deepEqual(
    all.value.map((e) => e.seq),
    [1, 2, 3, 4, 5],
    'seq stayed contiguous across lock boundary',
  );
});

test('withLock is not reentrant — nesting fails fast', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  const r = await store.withLock(async () => store.withLock(async () => ({ ok: true, value: 1 })));
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'lock_nested');
});

test('a lock owned by a dead pid is reclaimed', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = child.pid;
  assert.ok(deadPid > 0);
  writeFileSync(
    path.join(runDir, STORE_PATHS.lock),
    JSON.stringify({ pid: deadPid, startedAt: new Date(Date.now() - 1000).toISOString(), host: 'x' }),
  );
  process.env.COUNCIL_LOCK_WAIT_MS = '3000';
  try {
    const r = await store.withLock(async () => ({ ok: true, value: 'reclaimed' }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value, 'reclaimed');
  } finally {
    delete process.env.COUNCIL_LOCK_WAIT_MS;
  }
});

test('a lock owned by a live pid is never deleted — caller times out honestly', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  // Lock owned by THIS live process → the store must wait, then fail.
  writeFileSync(
    path.join(runDir, STORE_PATHS.lock),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: 'x' }),
  );
  process.env.COUNCIL_LOCK_WAIT_MS = '250';
  process.env.COUNCIL_LOCK_POLL_MS = '40';
  try {
    const r = await store.withLock(async () => ({ ok: true, value: 'never' }));
    assert.ok(!r.ok);
    assert.equal(r.error.details?.reason, 'lock_timeout');
    const owner = r.error.details?.owner as { pid?: number } | undefined;
    assert.equal(owner?.pid, process.pid);
    // The live lock file was NOT deleted.
    assert.ok(existsSync(path.join(runDir, STORE_PATHS.lock)));
  } finally {
    delete process.env.COUNCIL_LOCK_WAIT_MS;
    delete process.env.COUNCIL_LOCK_POLL_MS;
    await fsp.unlink(path.join(runDir, STORE_PATHS.lock));
  }
});

// ─── state validation ────────────────────────────────────────────────────────

test('saveState validates and refuses mismatched/corrupt state', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  const s = await store.loadState();
  assert.ok(s.ok);

  const bad = { ...s.value, status: 'bogus' } as unknown as typeof s.value;
  const w = await store.saveState(bad);
  assert.ok(!w.ok);
  assert.equal(w.error.code, 'schema_invalid');

  const wrongRun = { ...s.value, runId: 'crun_other' };
  const w2 = await store.saveState(wrongRun);
  assert.ok(!w2.ok);
  assert.equal(w2.error.details?.reason, 'run_id_mismatch');

  const good = { ...s.value, status: 'organising' as const, objective: 'updated' };
  assert.ok((await store.saveState(good)).ok);
  const again = await createStore({ runDir }).loadState();
  assert.ok(again.ok);
  assert.equal(again.value.status, 'organising');

  // Corrupt the file behind the store's back → honest load error.
  writeFileSync(path.join(runDir, STORE_PATHS.state), '{not json');
  const r = await store.loadState();
  assert.ok(!r.ok);
});

// ─── rosters ─────────────────────────────────────────────────────────────────

test('proposed roster validates count/ids and round-trips', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);

  const bad = proposal(RUN_ID, 9); // config requires exactly 10
  const w = await store.writeProposedRoster(bad);
  assert.ok(!w.ok);
  assert.equal(w.error.code, 'roster_invalid');

  const good = proposal(RUN_ID, 10);
  assert.ok((await store.writeProposedRoster(good)).ok, 'write failed');
  const back = await store.readProposedRoster();
  assert.ok(back.ok);
  assert.equal(back.value.perspectives.length, 10);
  assert.equal(canonicalRosterHash(back.value), canonicalRosterHash(good));
});

test('approved roster is checked against the proposal and config seats', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  assert.ok((await store.writeProposedRoster(proposal(RUN_ID, 10))).ok);

  const tooMany = approved(RUN_ID, proposal(RUN_ID, 10), 3); // config participants=2
  const w = await store.writeApprovedRoster(tooMany);
  assert.ok(!w.ok);
  assert.equal(w.error.code, 'roster_invalid');

  const unknownPerspective = approved(RUN_ID, proposal(RUN_ID, 10), 2);
  unknownPerspective.seats[1].perspectiveId = 'p99';
  const w2 = await store.writeApprovedRoster(unknownPerspective);
  assert.ok(!w2.ok);
  assert.equal(w2.error.code, 'roster_invalid');

  const good = approved(RUN_ID, proposal(RUN_ID, 10), 2);
  assert.ok((await store.writeApprovedRoster(good)).ok);
  const back = await store.readApprovedRoster();
  assert.ok(back.ok);
  assert.deepEqual(back.value.seats.map((s) => s.seatId), ['s1', 's2']);
});

// ─── approval ────────────────────────────────────────────────────────────────

test('approval round-trip requires record.hash == canonicalApprovalHash(binding)', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store, snapshot } = await initStore(runDir);
  const prop = proposal(RUN_ID, 10);
  assert.ok((await store.writeProposedRoster(prop)).ok);
  const ap = approved(RUN_ID, prop, 2);
  assert.ok((await store.writeApprovedRoster(ap)).ok);

  const binding: ApprovalBinding = {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN_ID,
    objective: OBJECTIVE,
    seats: ap.seats,
    proposedRosterHash: canonicalRosterHash(prop),
    config: config(),
    snapshotId: snapshot.snapshotId,
    snapshotHeadHash: snapshot.headHash,
  };
  const record: ApprovalRecord = {
    schemaVersion: SCHEMA_VERSION,
    approvalId: 'apv_1',
    hash: canonicalApprovalHash(binding),
    approver: 'primary-orchestrator',
    createdAt: new Date().toISOString(),
  };
  assert.ok((await store.writeApproval(record, binding)).ok, 'write failed');
  const back = await store.readApproval();
  assert.ok(back.ok);
  assert.equal(back.value.record.hash, record.hash);
  assert.equal(back.value.binding.proposedRosterHash, binding.proposedRosterHash);

  // A hash that does not match the binding is rejected.
  const badRecord = { ...record, approvalId: 'apv_2', hash: 'f'.repeat(64) };
  const w = await store.writeApproval(badRecord, binding);
  assert.ok(!w.ok);
  assert.equal(w.error.code, 'approval_stale');
  assert.equal(w.error.details?.reason, 'hash_mismatch');

  // A binding edited after hashing (charter tamper simulation) is rejected.
  const tampered = { ...binding, objective: 'different objective' };
  const w2 = await store.writeApproval(record, tampered);
  assert.ok(!w2.ok);
  assert.equal(w2.error.details?.reason, 'hash_mismatch');

  // A binding for another run is rejected.
  const foreign = { ...binding, runId: 'crun_other' };
  const hashForeign = canonicalApprovalHash(foreign);
  const w3 = await store.writeApproval({ ...record, hash: hashForeign }, foreign);
  assert.ok(!w3.ok);
  assert.equal(w3.error.details?.reason, 'run_id_mismatch');
});

// ─── verifySourceSnapshot ────────────────────────────────────────────────────

test('verifySourceSnapshot: clean tree → no drift; add/remove/modify → changed paths', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store, targetRoot } = await initStore(runDir);

  let r = await store.verifySourceSnapshot();
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.value.drift, false);
  assert.deepEqual(r.value.changed, []);

  writeFileSync(path.join(targetRoot, 'src', 'main.ts'), 'export const main = 2;\n');
  writeTree(targetRoot, { 'new.txt': 'new\n' });
  await fsp.rm(path.join(targetRoot, 'README.md'));
  r = await store.verifySourceSnapshot();
  assert.ok(r.ok);
  assert.equal(r.value.drift, true);
  assert.deepEqual(r.value.changed, ['README.md', 'new.txt', 'src/main.ts']);
});

test('run artifacts inside .council-dev of the target do not count as drift', async () => {
  const targetRoot = tmp();
  writeTree(targetRoot, { 'src/x.ts': 'x\n' });
  const snap = await captureSnapshot(targetRoot);
  assert.ok(snap.ok);
  // Run dir lives inside the target's .council-dev — must be excluded.
  const runDir = path.join(targetRoot, '.council-dev', 'runs', RUN_ID);
  const store = createStore({ runDir });
  const init = await store.initialize({
    runId: RUN_ID,
    targetRoot,
    objective: OBJECTIVE,
    config: config(),
    snapshot: snap.value,
  });
  assert.ok(init.ok, JSON.stringify(init));
  const r = await store.verifySourceSnapshot();
  assert.ok(r.ok);
  assert.equal(r.value.drift, false, JSON.stringify(r.value.changed));
});

test('verifySourceSnapshot reports manifest tampering and id mismatch', async () => {
  const runDir = path.join(tmp(), 'run');
  const { store } = await initStore(runDir);
  const snapPath = path.join(runDir, STORE_PATHS.snapshot);

  // Rewritten headHash breaks manifest integrity.
  const snapJson = JSON.parse(readFileSync(snapPath, 'utf8'));
  const realHash = snapJson.headHash;
  snapJson.headHash = '0'.repeat(64);
  writeFileSync(snapPath, JSON.stringify(snapJson, null, 2));
  let r = await store.verifySourceSnapshot();
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'snapshot_drift');
  assert.equal(r.error.details?.reason, 'manifest_integrity');

  // Restored hash but a manifest entry tampered → also integrity failure.
  snapJson.headHash = realHash;
  const key = Object.keys(snapJson.files)[0];
  snapJson.files[key].sha256 = '1'.repeat(64);
  writeFileSync(snapPath, JSON.stringify(snapJson, null, 2));
  r = await store.verifySourceSnapshot();
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'manifest_integrity');
});

// ─── integrity policy marker + index (src/artifacts.ts seam) ────────────────

test('initialize stamps integrityPolicy and an empty receipt index', async () => {
  const runDir = path.join(tmp(), 'run');
  await initStore(runDir);
  const meta = JSON.parse(readFileSync(path.join(runDir, STORE_PATHS.council), 'utf8'));
  assert.equal(meta.integrityPolicy, 'receipts-v1');
  const indexPath = path.join(runDir, STORE_PATHS.integrityIndex);
  assert.ok(existsSync(indexPath), 'integrity/index.json must exist at init');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.equal(index.policy, 'receipts-v1');
  assert.equal(index.runId, RUN_ID);
  assert.deepEqual(index.entries, {});
});

test('initialize refuses to clobber a stray integrity index', async () => {
  const runDir = path.join(tmp(), 'run');
  const { targetRoot, snapshot } = await makeTarget();
  mkdirSync(path.join(runDir, 'integrity'), { recursive: true });
  writeFileSync(path.join(runDir, 'integrity', 'index.json'), '{}');
  const store = createStore({ runDir });
  const r = await store.initialize({
    runId: RUN_ID,
    targetRoot,
    objective: OBJECTIVE,
    config: config(),
    snapshot,
  });
  assert.ok(!r.ok);
  assert.equal(r.error.details?.reason, 'already_initialized');
});
