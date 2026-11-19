/**
 * Tests for src/artifacts.ts — exact-byte integrity receipts, the rebuildable
 * index projection, policy-marker agreement, and managed-artifact audit.
 * Covers clm_0004/0032/0041: post-admission tamper detection, immutable
 * rewrite refusal, envelope self-authorization rejection, ledger/report
 * versioning, fault windows around index/journal, and legacy untracked runs.
 * Runs from dist/test against OS temp dirs; no engine or network involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { JournalEvent, SourceSnapshot } from '../src/contracts.js';
import { SCHEMA_VERSION } from '../src/contracts.js';
import {
  INTEGRITY_INDEX_PATH,
  INTEGRITY_POLICY,
  collectReceipts,
  emptyIndex,
  integrityPolicy,
  journalHasPolicyMarker,
  loadIndex,
  noteReceipt,
  parseIntegrityIndex,
  readVerifiedArtifact,
  receiptForBytes,
  receiptJournalFields,
  rebuildIndexFromEvents,
  recordManagedWrite,
  resolveIntegrityPolicy,
  sha256Bytes,
  verifyManagedArtifacts,
} from '../src/artifacts.js';
import { captureSnapshot } from '../src/snapshot.js';
import { createStore, STORE_PATHS, type Store } from '../src/store.js';
import { resolveConfig } from '../src/validation.js';

// ─── fixture helpers ─────────────────────────────────────────────────────────

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'council-artifacts-'));
}

const RUN_ID = 'crun_arttest';

async function makeSnapshot(): Promise<{ targetRoot: string; snapshot: SourceSnapshot }> {
  const targetRoot = tmp();
  mkdirSync(path.join(targetRoot, 'src'), { recursive: true });
  writeFileSync(path.join(targetRoot, 'src', 'x.ts'), 'export const x = 1;\n');
  const snap = await captureSnapshot(targetRoot);
  assert.ok(snap.ok, JSON.stringify(snap));
  return { targetRoot, snapshot: snap.value };
}

async function initStore(runDir: string): Promise<Store> {
  const { targetRoot, snapshot } = await makeSnapshot();
  const store = createStore({ runDir });
  const cfg = resolveConfig({ requestedPerspectives: 10, participants: 2, rounds: 1 });
  assert.ok(cfg.ok);
  const r = await store.initialize({
    runId: RUN_ID,
    targetRoot,
    objective: 'review x',
    config: cfg.value,
    snapshot,
  });
  assert.ok(r.ok, JSON.stringify(r));
  return store;
}

let seq = 0;
function ev(type: JournalEvent['type'], payload?: Record<string, unknown>): JournalEvent {
  seq += 1;
  return { seq, ts: new Date().toISOString(), type, actor: 'engine', payload };
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ─── sha256Bytes / receiptForBytes ──────────────────────────────────────────

test('sha256Bytes hashes exact bytes for strings and buffers', () => {
  const a = sha256Bytes('hello');
  const b = sha256Bytes(Buffer.from('hello', 'utf8'));
  assert.equal(a.sha256, sha('hello'));
  assert.equal(a.bytes, 5);
  assert.deepEqual(a, b);
  assert.notEqual(sha256Bytes('hello\n').sha256, a.sha256);
});

test('receiptForBytes builds a receipt over caller-held bytes', () => {
  const r = receiptForBytes('outputs/a1.md', 'claim text', 'worker_output');
  assert.ok(r.ok);
  assert.equal(r.value.path, 'outputs/a1.md');
  assert.equal(r.value.category, 'worker_output');
  assert.equal(r.value.sha256, sha('claim text'));
  assert.equal(r.value.bytes, 'claim text'.length);
  assert.equal(r.value.version, 1);
});

test('receiptForBytes refuses unsafe, forbidden, and malformed inputs', () => {
  for (const bad of ['../escape.txt', 'a/../../x', '/abs/path', 'a//b', '']) {
    const r = receiptForBytes(bad, 'x', 'worker_output');
    assert.ok(!r.ok, `expected refusal for ${JSON.stringify(bad)}`);
  }
  for (const forbidden of [INTEGRITY_INDEX_PATH, 'events.jsonl', 'lock']) {
    const r = receiptForBytes(forbidden, 'x', 'runner');
    assert.ok(!r.ok, `expected refusal for ${forbidden}`);
    assert.equal(r.error.details?.reason, 'forbidden_receipt_path');
  }
  const badCat = receiptForBytes('a.txt', 'x', 'nonsense' as 'runner');
  assert.ok(!badCat.ok);
  const badVer = receiptForBytes('a.txt', 'x', 'runner', 0);
  assert.ok(!badVer.ok);
});

// ─── collectReceipts sequencing rules ────────────────────────────────────────

function journalReceipt(
  type: JournalEvent['type'],
  relPath: string,
  content: string,
  category: Parameters<typeof receiptForBytes>[2],
  version: number,
): JournalEvent {
  const r = receiptForBytes(relPath, content, category, version);
  assert.ok(r.ok);
  return ev(type, receiptJournalFields(r.value));
}

test('collectReceipts folds receipt payloads; marker-only events are not receipts', () => {
  seq = 0;
  const events = [
    ev('run.initialized', { integrity: INTEGRITY_POLICY, runId: RUN_ID }),
    journalReceipt('artifact.admitted', 'outputs/a.md', 'v1', 'worker_output', 1),
    journalReceipt('claim.updated', 'claims.json', 'L1', 'ledger', 1),
    journalReceipt('claim.updated', 'claims.json', 'L2', 'ledger', 2),
    ev('phase.entered', { phase: 'discussion' }),
  ];
  const { receipts, anomalies } = collectReceipts(events);
  assert.deepEqual(anomalies, []);
  assert.equal(receipts.size, 2);
  assert.equal(receipts.get('claims.json')!.version, 2);
  assert.equal(receipts.get('claims.json')!.sha256, sha('L2'));
  assert.equal(receipts.get('outputs/a.md')!.version, 1);
});

test('collectReceipts flags version regression, same-version conflicts, skips, and category changes', () => {
  seq = 0;
  const mk = (content: string, version: number, cat: 'ledger' | 'runner' = 'ledger') =>
    journalReceipt('claim.updated', 'claims.json', content, cat, version);
  const events = [
    mk('A', 1),
    mk('B', 3), // skip 1 → 3: accepted, anomaly
    mk('C', 2), // regression: keep v3, anomaly
    mk('D', 3), // same version different bytes: conflict anomaly, keep v3
    mk('E', 3), // identical re-record of different? no — E ≠ B… actually same ver diff bytes again
    journalReceipt('artifact.written', 'claims.json', 'A', 'runner', 4), // category change
  ];
  const { receipts, anomalies } = collectReceipts(events);
  const final = receipts.get('claims.json')!;
  assert.equal(final.version, 3, 'latest stays v3');
  assert.equal(final.sha256, sha('B'), 'first v3 receipt wins; later v3 conflicts refused');
  assert.equal(final.category, 'ledger', 'category change refused');
  // anomalies: skip, regression, two same-version conflicts, category change
  assert.ok(anomalies.length >= 4, JSON.stringify(anomalies));
  assert.ok(anomalies.some((a) => a.includes('version skip')));
  assert.ok(anomalies.some((a) => a.includes('version regression')));
  assert.ok(anomalies.some((a) => a.includes('same-version different-bytes')));
  assert.ok(anomalies.some((a) => a.includes('category change')));
});

test('collectReceipts: immutable re-mint and malformed receipt payloads are anomalies', () => {
  seq = 0;
  const events = [
    journalReceipt('artifact.admitted', 'outputs/a.md', 'orig', 'worker_output', 1),
    journalReceipt('artifact.admitted', 'outputs/a.md', 'rewritten', 'worker_output', 2),
    // malformed: marker present but sha256 invalid
    ev('artifact.admitted', {
      integrity: INTEGRITY_POLICY,
      path: 'outputs/b.md',
      sha256: 'not-a-hash',
      bytes: 4,
      version: 1,
      category: 'worker_output',
    }),
    // receipt-looking but path unsafe
    ev('artifact.admitted', {
      integrity: INTEGRITY_POLICY,
      path: '../escape.md',
      sha256: sha('x'),
      bytes: 1,
      version: 1,
      category: 'worker_output',
    }),
  ];
  const { receipts, anomalies } = collectReceipts(events);
  const out = receipts.get('outputs/a.md')!;
  assert.equal(out.sha256, sha('orig'), 'immutable keeps first receipt');
  assert.equal(out.version, 1);
  assert.ok(anomalies.some((a) => a.includes('re-minted immutable')));
  assert.ok(anomalies.filter((a) => a.includes('malformed')).length === 2, JSON.stringify(anomalies));
  assert.equal(receipts.has('outputs/b.md'), false);
  assert.equal(receipts.has('../escape.md'), false);
});

// ─── resolveIntegrityPolicy / markers ────────────────────────────────────────

test('resolveIntegrityPolicy: meta and journal must agree', () => {
  // v1 meta + marked journal → v1
  const v1 = resolveIntegrityPolicy({ metaPolicy: INTEGRITY_POLICY, journalHasMarker: true, indexPresent: true });
  assert.ok(v1.ok && v1.value.policy === INTEGRITY_POLICY);
  // v1 meta + empty journal (pre-first-event) → v1 (marker can't be judged yet)
  const v1b = resolveIntegrityPolicy({ metaPolicy: INTEGRITY_POLICY, journalHasMarker: null, indexPresent: true });
  assert.ok(v1b.ok && v1b.value.policy === INTEGRITY_POLICY);
  // v1 meta + NON-empty journal without marker → conflict (stripped marker)
  const c1 = resolveIntegrityPolicy({ metaPolicy: INTEGRITY_POLICY, journalHasMarker: false, indexPresent: true });
  assert.ok(!c1.ok && c1.error.details?.reason === 'integrity_policy_conflict');
  // no meta + marked journal → conflict (stripped/forged meta)
  const c2 = resolveIntegrityPolicy({ metaPolicy: undefined, journalHasMarker: true, indexPresent: true });
  assert.ok(!c2.ok);
  // no meta + unmarked journal → legacy
  const leg = resolveIntegrityPolicy({ metaPolicy: undefined, journalHasMarker: false, indexPresent: false });
  assert.ok(leg.ok && leg.value.policy === 'legacy');
  // unknown meta value → conflict
  const c3 = resolveIntegrityPolicy({ metaPolicy: 'receipts-v2', journalHasMarker: false, indexPresent: false });
  assert.ok(!c3.ok);
});

test('journalHasPolicyMarker: empty=null, then marker presence', () => {
  assert.equal(journalHasPolicyMarker([]), null);
  assert.equal(journalHasPolicyMarker([ev('phase.entered', { phase: 'x' })]), false);
  assert.equal(
    journalHasPolicyMarker([
      ev('phase.entered', { phase: 'x' }),
      ev('run.initialized', { integrity: INTEGRITY_POLICY }),
    ]),
    true,
  );
});

test('initialize stamps the policy marker, genesis journal event, and empty index', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const meta = JSON.parse(readFileSync(path.join(runDir, STORE_PATHS.council), 'utf8'));
  assert.equal(meta.integrityPolicy, INTEGRITY_POLICY);
  assert.ok(existsSync(path.join(runDir, INTEGRITY_INDEX_PATH)));
  const idx = await loadIndex(store);
  assert.ok(idx.ok, JSON.stringify(idx));
  assert.equal(idx.value.policy, INTEGRITY_POLICY);
  assert.equal(idx.value.runId, RUN_ID);
  assert.deepEqual(idx.value.entries, {});
  const pol = await integrityPolicy(store);
  assert.ok(pol.ok && pol.value.markerPresent && pol.value.indexPresent);
  // The journal is born with the genesis marker at seq 1 — policy resolution
  // already agrees before any engine advance.
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  assert.equal(journal.value.length, 1);
  assert.equal(journal.value[0].type, 'run.initialized');
  assert.equal(journal.value[0].payload?.integrity, INTEGRITY_POLICY);
  assert.equal(journalHasPolicyMarker(journal.value), true);
  const res = resolveIntegrityPolicy({ metaPolicy: meta.integrityPolicy, journalHasMarker: true, indexPresent: true });
  assert.ok(res.ok && res.value.policy === INTEGRITY_POLICY);
});

test('pre-engine journal writers stay marker-consistent (operator repro)', async () => {
  // Reproduced defect: init → a non-engine first writer (start-supervisor)
  // journals worker.started → the next advance convicted the run as
  // stripped-marker. With the genesis marker at seq 1 the first append
  // chains on it and policy stays coherent.
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const a = await store.appendJournal([
    { ts: new Date().toISOString(), type: 'worker.started', actor: 'cli', payload: { participantId: 'supervisor' } },
  ]);
  assert.ok(a.ok);
  assert.equal(a.value[0].seq, 2, 'first append lands after the genesis marker');
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  assert.equal(journal.value.length, 2);
  assert.equal(journalHasPolicyMarker(journal.value), true);
  const pol = await integrityPolicy(store);
  assert.ok(pol.ok);
  const res = resolveIntegrityPolicy({
    metaPolicy: pol.value.metaPolicy,
    journalHasMarker: journalHasPolicyMarker(journal.value),
    indexPresent: pol.value.indexPresent,
  });
  assert.ok(res.ok && res.value.policy === INTEGRITY_POLICY, JSON.stringify(res));
  // Hash chain: the appended event binds the marker line.
  const lines = readFileSync(path.join(runDir, STORE_PATHS.journal), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[1]).prevHash, sha(lines[0]));
});

test('tampered genesis marker convicts as policy conflict', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // Rewrite the marker's integrity value — the hash chain still verifies
  // (single-line journal rebuilt consistently), but the marker is gone.
  const journalPath = path.join(runDir, STORE_PATHS.journal);
  const line = JSON.parse(readFileSync(journalPath, 'utf8').trim());
  line.payload.integrity = 'receipts-v0';
  writeFileSync(journalPath, JSON.stringify(line) + '\n');
  const journal = await store.readJournal();
  assert.ok(journal.ok, 'rewritten single-line journal still parses');
  const audit = await verifyManagedArtifacts(store, { events: journal.value });
  assert.ok(audit.ok);
  assert.equal(audit.value.policy, 'conflict');
});

// ─── recordManagedWrite / noteReceipt / readVerifiedArtifact ─────────────────

test('recordManagedWrite persists exact bytes and records a receipt', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const r = await recordManagedWrite(store, 'envelopes/w1.json', '{"assigned":["a"]}', 'envelope');
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.value.receipt.sha256, sha('{"assigned":["a"]}'));
  assert.equal(r.value.receipt.version, 1);
  assert.equal(readFileSync(path.join(runDir, 'envelopes/w1.json'), 'utf8'), '{"assigned":["a"]}');
  const idx = await loadIndex(store);
  assert.ok(idx.ok && idx.value.entries['envelopes/w1.json'].sha256 === sha('{"assigned":["a"]}'));
});

test('versioned categories: ledger versions increase; stale bytes are caught', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const receipts = new Map();
  const fold = (o: { receipt: import('../src/artifacts.js').ArtifactReceipt }) =>
    receipts.set(o.receipt.path, o.receipt);
  const r1 = await recordManagedWrite(store, 'claims.json', '["c1"]', 'ledger', { prior: receipts });
  assert.ok(r1.ok);
  fold(r1.value);
  const r2 = await recordManagedWrite(store, 'claims.json', '["c1","c2"]', 'ledger', { prior: receipts });
  assert.ok(r2.ok);
  assert.equal(r2.value.receipt.version, 2, 'version bumps on rewrite');
  fold(r2.value);
  // identical re-write is idempotent — no version bump
  const r3 = await recordManagedWrite(store, 'claims.json', '["c1","c2"]', 'ledger', { prior: receipts });
  assert.ok(r3.ok);
  assert.equal(r3.value.receipt.version, 2, 'same bytes keep the standing version');
  // verify current bytes against journal view
  const rv = await readVerifiedArtifact(store, 'claims.json', { receipts });
  assert.ok(rv.ok && rv.value.verdict.status === 'ok');
});

test('immutable categories: different-bytes rewrite is refused and original preserved', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const r1 = await recordManagedWrite(store, 'rejected/a__out.md', 'original', 'archive');
  assert.ok(r1.ok);
  const r2 = await recordManagedWrite(store, 'rejected/a__out.md', 'tampered', 'archive');
  assert.ok(!r2.ok, 'immutable overwrite must fail');
  assert.equal(r2.error.details?.reason, 'receipt_conflict');
  assert.equal(
    readFileSync(path.join(runDir, 'rejected/a__out.md'), 'utf8'),
    'original',
    'original preserved on refused overwrite',
  );
  // identical rewrite is idempotent
  const r3 = await recordManagedWrite(store, 'rejected/a__out.md', 'original', 'archive');
  assert.ok(r3.ok && r3.value.receipt.version === 1);
});

test('noteReceipt receipts worker bytes the caller already holds', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // worker wrote its output file itself
  const w = await store.writeArtifact('rounds/1/outputs/w1.md', 'worker text');
  assert.ok(w.ok);
  const r = await noteReceipt(store, 'rounds/1/outputs/w1.md', 'worker text', 'worker_output');
  assert.ok(r.ok);
  assert.equal(r.value.receipt.sha256, sha('worker text'));
});

// ─── post-admission tamper detection (clm_0004 mechanism) ───────────────────

test('post-admission tamper fails visibly at the journal-bound boundary', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // worker output lands on disk, then is admitted with a receipt
  const w = await store.writeArtifact('rounds/1/outputs/w1.md', '{"claims":[]}');
  assert.ok(w.ok);
  const noted = await noteReceipt(store, 'rounds/1/outputs/w1.md', '{"claims":[]}', 'worker_output');
  assert.ok(noted.ok);
  const appended = await store.appendJournal([
    { ts: new Date().toISOString(), type: 'artifact.admitted', actor: 'engine',
      payload: receiptJournalFields(noted.value.receipt) },
  ]);
  assert.ok(appended.ok);
  // tamper: rewrite the admitted bytes on disk
  const t = await store.writeArtifact('rounds/1/outputs/w1.md', '{"claims":[{"id":"forged"}]}');
  assert.ok(t.ok);
  // consume: collect authoritative receipts from the journal
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const { receipts } = collectReceipts(journal.value);
  const rv = await readVerifiedArtifact(store, 'rounds/1/outputs/w1.md', { receipts });
  assert.ok(rv.ok);
  assert.equal(rv.value.verdict.status, 'mismatch', 'tampered bytes must not verify');
  assert.equal(rv.value.verdict.receipt?.sha256, sha('{"claims":[]}'));
  // audit agrees
  const audit = await verifyManagedArtifacts(store, { events: journal.value });
  assert.ok(audit.ok);
  const row = audit.value.artifacts.find((a) => a.path === 'rounds/1/outputs/w1.md');
  assert.equal(row?.status, 'changed');
});

test('envelope cannot self-authorize changed assignments', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const env = JSON.stringify({ assigned: ['p1', 'p2'], round: 1 });
  const r = await recordManagedWrite(store, 'rounds/1/envelopes/challenge/p1.json', env, 'envelope');
  assert.ok(r.ok);
  const appended = await store.appendJournal([
    { ts: new Date().toISOString(), type: 'envelope.built', actor: 'engine',
      payload: { ...receiptJournalFields(r.value.receipt), assigned: ['p1', 'p2'] } },
  ]);
  assert.ok(appended.ok);
  // attacker rewrites the envelope to assign different work
  const forged = JSON.stringify({ assigned: ['p1', 'p2', 'p3'], round: 1 });
  writeFileSync(path.join(runDir, 'rounds/1/envelopes/challenge/p1.json'), forged);
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const { receipts } = collectReceipts(journal.value);
  const rv = await readVerifiedArtifact(store, 'rounds/1/envelopes/challenge/p1.json', { receipts });
  assert.ok(rv.ok);
  assert.equal(rv.value.verdict.status, 'mismatch', 'self-authored envelope edits are rejected');
});

test('ledger/report versioned rewrites bind the LATEST receipt', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const journalEvents: Omit<JournalEvent, 'seq'>[] = [];
  const receipts = new Map();
  const write = async (rel: string, bytes: string, cat: 'ledger' | 'report') => {
    const r = await recordManagedWrite(store, rel, bytes, cat, { prior: receipts });
    assert.ok(r.ok);
    receipts.set(rel, r.value.receipt);
    journalEvents.push({
      ts: new Date().toISOString(),
      type: cat === 'ledger' ? 'claim.updated' : 'report.written',
      actor: 'engine',
      payload: receiptJournalFields(r.value.receipt),
    });
  };
  await write('claims.json', 'V1', 'ledger');
  await write('report.json', 'R1', 'report');
  await write('claims.json', 'V2', 'ledger');
  await write('report.json', 'R2', 'report');
  const appended = await store.appendJournal(journalEvents);
  assert.ok(appended.ok);
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const { receipts: jr } = collectReceipts(journal.value);
  assert.equal(jr.get('claims.json')!.version, 2);
  assert.equal(jr.get('report.json')!.version, 2);
  // rewind report.json to the superseded version → caught
  writeFileSync(path.join(runDir, 'report.json'), 'R1');
  const rv = await readVerifiedArtifact(store, 'report.json', { receipts: jr });
  assert.ok(rv.ok && rv.value.verdict.status === 'mismatch', 'superseded version must fail');
});

// ─── index tamper / rebuild / fault windows ──────────────────────────────────

test('index tamper cannot override the journaled receipt', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const r = await recordManagedWrite(store, 'outputs/a.md', 'real', 'worker_output');
  assert.ok(r.ok);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'artifact.admitted', actor: 'engine',
      payload: receiptJournalFields(r.value.receipt) },
  ]);
  // attacker rewrites the index to bless tampered content, then tampers file
  const idx = await loadIndex(store);
  assert.ok(idx.ok);
  const forgedSha = sha('forged');
  idx.value.entries['outputs/a.md'] = { ...r.value.receipt, sha256: forgedSha, recordedAt: new Date().toISOString() };
  writeFileSync(path.join(runDir, INTEGRITY_INDEX_PATH), JSON.stringify(idx.value, null, 2));
  writeFileSync(path.join(runDir, 'outputs/a.md'), 'forged');
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const { receipts } = collectReceipts(journal.value);
  const rv = await readVerifiedArtifact(store, 'outputs/a.md', { receipts });
  assert.ok(rv.ok);
  assert.equal(rv.value.verdict.status, 'mismatch', 'journal receipt still convicts');
  // index-only view would be fooled — that is exactly why consumers must bind
  // the journal. The audit surfaces the index↔journal drift.
  const audit = await verifyManagedArtifacts(store, { events: journal.value });
  assert.ok(audit.ok);
  assert.ok(audit.value.anomalies.some((a) => a.includes('diverges from the journaled receipt')),
    JSON.stringify(audit.value.anomalies));
});

test('missing index is a visible error; rebuild restores the projection', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const r = await recordManagedWrite(store, 'outputs/a.md', 'real', 'worker_output');
  assert.ok(r.ok);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'artifact.admitted', actor: 'engine',
      payload: receiptJournalFields(r.value.receipt) },
  ]);
  rmSync(path.join(runDir, INTEGRITY_INDEX_PATH));
  const idx = await loadIndex(store);
  assert.ok(!idx.ok && idx.error.details?.reason === 'index_missing');
  const rv = await readVerifiedArtifact(store, 'outputs/a.md');
  assert.ok(!rv.ok, 'index-bound read must fail visibly, not silently untrack');
  // rebuild from the journal
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const rb = await rebuildIndexFromEvents(store, journal.value);
  assert.ok(rb.ok);
  assert.equal(rb.value.entries, 1);
  const rv2 = await readVerifiedArtifact(store, 'outputs/a.md');
  assert.ok(rv2.ok && rv2.value.verdict.status === 'ok');
});

test('corrupt index fails visibly and rebuild drops index-only entries', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const r = await recordManagedWrite(store, 'outputs/a.md', 'real', 'worker_output');
  assert.ok(r.ok);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'artifact.admitted', actor: 'engine',
      payload: receiptJournalFields(r.value.receipt) },
  ]);
  // corrupt the index
  writeFileSync(path.join(runDir, INTEGRITY_INDEX_PATH), '{not json');
  const idx = await loadIndex(store);
  assert.ok(!idx.ok && idx.error.details?.reason === 'index_corrupt');
  const audit = await verifyManagedArtifacts(store);
  assert.ok(audit.ok && audit.value.indexStatus === 'corrupt');
  // plant an index-only entry, then rebuild: it must be dropped
  const idx2 = emptyIndex(RUN_ID);
  idx2.entries['outputs/a.md'] = { ...r.value.receipt, recordedAt: new Date().toISOString() };
  idx2.entries['ghost.md'] = { ...r.value.receipt, path: 'ghost.md', recordedAt: new Date().toISOString() };
  writeFileSync(path.join(runDir, INTEGRITY_INDEX_PATH), JSON.stringify(idx2, null, 2));
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const rb = await rebuildIndexFromEvents(store, journal.value);
  assert.ok(rb.ok);
  assert.deepEqual(rb.value.droppedIndexOnly, ['ghost.md']);
  const idx3 = await loadIndex(store);
  assert.ok(idx3.ok && !('ghost.md' in idx3.value.entries));
});

test('journal-only receipts survive a lost index entry (audit journalOnly)', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // file written + journaled, index entry never recorded (crash between index
  // write and journal append simulated in reverse: journal has it, index lost)
  const w = await store.writeArtifact('outputs/a.md', 'journaled only');
  assert.ok(w.ok);
  const noted = await noteReceipt(store, 'outputs/a.md', 'journaled only', 'worker_output');
  assert.ok(noted.ok);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'artifact.admitted', actor: 'engine',
      payload: receiptJournalFields(noted.value.receipt) },
  ]);
  // drop the index entry to simulate projection loss
  const idx = await loadIndex(store);
  assert.ok(idx.ok);
  delete idx.value.entries['outputs/a.md'];
  writeFileSync(path.join(runDir, INTEGRITY_INDEX_PATH), JSON.stringify(idx.value, null, 2));
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const audit = await verifyManagedArtifacts(store, { events: journal.value });
  assert.ok(audit.ok);
  assert.deepEqual(audit.value.journalOnly, ['outputs/a.md']);
  const row = audit.value.artifacts.find((a) => a.path === 'outputs/a.md');
  assert.equal(row?.status, 'ok', 'file still verifies against the journal');
});

test('receipted file deleted on disk reports missing', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const r = await recordManagedWrite(store, 'outputs/a.md', 'x', 'worker_output');
  assert.ok(r.ok);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'artifact.admitted', actor: 'engine',
      payload: receiptJournalFields(r.value.receipt) },
  ]);
  unlinkSync(path.join(runDir, 'outputs/a.md'));
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const { receipts } = collectReceipts(journal.value);
  const rv = await readVerifiedArtifact(store, 'outputs/a.md', { receipts });
  assert.ok(rv.ok && rv.value.verdict.status === 'missing');
  const audit = await verifyManagedArtifacts(store, { events: journal.value });
  assert.ok(audit.ok);
  assert.equal(audit.value.artifacts[0].status, 'missing');
});

// ─── legacy runs: honest untracked, still loadable ───────────────────────────

async function makeLegacyRun(runDir: string): Promise<Store> {
  // A "legacy" run predates the policy marker entirely: strip it from
  // council.json, remove the index, and empty the journal (the genesis
  // run.initialized marker did not exist in that era).
  const store = await initStore(runDir);
  const metaPath = path.join(runDir, STORE_PATHS.council);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  delete meta.integrityPolicy;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  rmSync(path.join(runDir, INTEGRITY_INDEX_PATH));
  writeFileSync(path.join(runDir, STORE_PATHS.journal), '');
  return store;
}

test('legacy run loads, audit reports untracked and never claims verified', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await makeLegacyRun(runDir);
  // legacy file written without receipts
  const w = await store.writeArtifact('outputs/a.md', 'legacy content');
  assert.ok(w.ok);
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const audit = await verifyManagedArtifacts(store, { events: journal.value });
  assert.ok(audit.ok);
  assert.equal(audit.value.policy, 'legacy');
  assert.ok(audit.value.summary.legacy);
  assert.equal(audit.value.summary.verified, 0);
  assert.ok(audit.value.untracked.includes('outputs/a.md'));
  // readVerifiedArtifact on an index-less legacy file → untracked, not error
  const rv = await readVerifiedArtifact(store, 'outputs/a.md', { receipts: new Map() });
  assert.ok(rv.ok && rv.value.verdict.status === 'untracked');
});

test('marker stripped from journal side is a conflict, never a downgrade', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // Strip the genesis marker by rewriting the journal to an UNMARKED event —
  // meta still says receipts-v1, so a non-empty unmarked journal is a hard
  // conflict (never silently blessed, never downgraded to legacy).
  writeFileSync(path.join(runDir, STORE_PATHS.journal), '');
  const appended = await store.appendJournal([
    { ts: new Date().toISOString(), type: 'phase.entered', actor: 'engine', payload: { phase: 'x' } },
  ]);
  assert.ok(appended.ok);
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const audit = await verifyManagedArtifacts(store, { events: journal.value });
  assert.ok(audit.ok);
  assert.equal(audit.value.policy, 'conflict');
  assert.ok(audit.value.anomalies.some((a) => a.includes('integrity policy conflict')));
  // resolveIntegrityPolicy agrees
  const res = resolveIntegrityPolicy({ metaPolicy: INTEGRITY_POLICY, journalHasMarker: false, indexPresent: true });
  assert.ok(!res.ok);
});

test('stripped meta marker with marked journal is also a conflict', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // journal a marked event first
  const r = await recordManagedWrite(store, 'outputs/a.md', 'x', 'worker_output');
  assert.ok(r.ok);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'artifact.admitted', actor: 'engine',
      payload: receiptJournalFields(r.value.receipt) },
  ]);
  // now strip the meta marker
  const metaPath = path.join(runDir, STORE_PATHS.council);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  delete meta.integrityPolicy;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const audit = await verifyManagedArtifacts(store, { events: journal.value });
  assert.ok(audit.ok && audit.value.policy === 'conflict');
});

// ─── readVerifiedArtifact receipt-source rules ───────────────────────────────

test('explicit empty receipts map never falls back to the index', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const r = await recordManagedWrite(store, 'outputs/a.md', 'x', 'worker_output');
  assert.ok(r.ok);
  // index HAS the entry, but caller passed an empty journal map → untracked
  const rv = await readVerifiedArtifact(store, 'outputs/a.md', { receipts: new Map() });
  assert.ok(rv.ok && rv.value.verdict.status === 'untracked');
  // index view (no opts) → ok
  const rv2 = await readVerifiedArtifact(store, 'outputs/a.md');
  assert.ok(rv2.ok && rv2.value.verdict.status === 'ok' && rv2.value.verdict.source === 'index');
  // explicit receipt → journal source
  const rv3 = await readVerifiedArtifact(store, 'outputs/a.md', { receipt: r.value.receipt });
  assert.ok(rv3.ok && rv3.value.verdict.status === 'ok' && rv3.value.verdict.source === 'journal');
});

test('readVerifiedArtifact refuses unsafe paths', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  for (const bad of ['../x', 'a/../../b', '/abs']) {
    const rv = await readVerifiedArtifact(store, bad);
    assert.ok(!rv.ok && rv.error.code === 'untrusted_output');
  }
});

// ─── no recursive locks / no blocking pending writes ─────────────────────────

test('verify and audit never take the store lock (safe inside withLock)', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const r = await recordManagedWrite(store, 'outputs/a.md', 'x', 'worker_output');
  assert.ok(r.ok);
  // hold the mutation lock and verify+audit inside it — no deadlock
  const inside = await store.withLock(async () => {
    const rv = await readVerifiedArtifact(store, 'outputs/a.md');
    const au = await verifyManagedArtifacts(store);
    const rec = await recordManagedWrite(store, 'outputs/b.md', 'y', 'worker_output');
    return { ok: true as const, value: { rv, au, rec } };
  });
  assert.ok(inside.ok, JSON.stringify(inside));
  assert.ok(inside.value.rv.ok && inside.value.au.ok && inside.value.rec.ok);
});

test('reads do not wait for a held mutation lock', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const lp = store.withLock(async () => {
    await gate;
    return { ok: true as const, value: null };
  });
  const rv = await readVerifiedArtifact(store, 'council.json');
  assert.ok(rv.ok, 'read must resolve while the lock is held');
  release();
  const done = await lp;
  assert.ok(done.ok);
});

// ─── audit shape on a healthy v1 run ─────────────────────────────────────────

test('healthy v1 run audits clean: all tracked, verified, nothing untracked', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const r = await recordManagedWrite(store, 'outputs/a.md', 'x', 'worker_output');
  assert.ok(r.ok);
  const w = await recordManagedWrite(store, 'claims.json', '[]', 'ledger');
  assert.ok(w.ok);
  // journal both receipts — index entries without journal backing are
  // honestly 'index_only', not verified
  const appended = await store.appendJournal([
    { ts: new Date().toISOString(), type: 'artifact.admitted', actor: 'engine',
      payload: receiptJournalFields(r.value.receipt) },
    { ts: new Date().toISOString(), type: 'claim.updated', actor: 'engine',
      payload: receiptJournalFields(w.value.receipt) },
  ]);
  assert.ok(appended.ok);
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const audit = await verifyManagedArtifacts(store, { events: journal.value });
  assert.ok(audit.ok);
  assert.equal(audit.value.policy, INTEGRITY_POLICY);
  assert.equal(audit.value.indexStatus, 'ok');
  assert.equal(audit.value.journalBinding, 'bound');
  assert.equal(audit.value.summary.verified, audit.value.summary.tracked);
  assert.equal(audit.value.summary.tracked, 2);
  assert.equal(audit.value.summary.changed, 0);
  assert.equal(audit.value.summary.missing, 0);
  assert.deepEqual(audit.value.anomalies, []);
});

test('untracked managed-looking files are listed honestly', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const w = await store.writeArtifact('outputs/stray.md', 'no receipt');
  assert.ok(w.ok);
  const audit = await verifyManagedArtifacts(store);
  assert.ok(audit.ok);
  assert.ok(audit.value.untracked.includes('outputs/stray.md'));
});

// ─── fault windows ───────────────────────────────────────────────────────────

test('write-without-record leaves an unreceipted file that fails verification', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // crash mid-recordManagedWrite: bytes landed, index/journal did not
  const w = await store.writeArtifact('outputs/crash.md', 'orphaned');
  assert.ok(w.ok);
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const { receipts } = collectReceipts(journal.value);
  const rv = await readVerifiedArtifact(store, 'outputs/crash.md', { receipts });
  assert.ok(rv.ok && rv.value.verdict.status === 'untracked');
  const audit = await verifyManagedArtifacts(store, { events: journal.value });
  assert.ok(audit.ok && audit.value.untracked.includes('outputs/crash.md'));
});

test('parseIntegrityIndex rejects malformed shapes', () => {
  assert.ok(!parseIntegrityIndex(null).ok);
  assert.ok(!parseIntegrityIndex('str').ok);
  assert.ok(!parseIntegrityIndex({ schemaVersion: 'x' }).ok);
  const bad = emptyIndex(RUN_ID) as unknown as Record<string, unknown>;
  (bad.entries as Record<string, unknown>)['../evil'] = { path: '../evil', sha256: sha('x'), bytes: 1, version: 1, category: 'runner', recordedAt: 't' };
  assert.ok(!parseIntegrityIndex(bad).ok, 'unsafe entry keys rejected');
});

// ─── receipt-forbidden / prototype-pollution hardening ───────────────────────

test('journaled receipts for forbidden paths are anomalies, never collected', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // Hand-forged payloads: receiptForBytes refuses these, but a journal event
  // payload is attacker-controllable — collectReceipts must still refuse.
  const forged = (relPath: string) =>
    ev('artifact.written', {
      integrity: INTEGRITY_POLICY,
      path: relPath,
      sha256: sha('x'),
      bytes: 1,
      version: 1,
      category: 'runner',
    });
  for (const p of ['__proto__', 'events.jsonl', 'lock', INTEGRITY_INDEX_PATH]) {
    const { receipts, anomalies } = collectReceipts([forged(p)]);
    assert.equal(receipts.has(p), false, `${p} must not be collected`);
    assert.ok(anomalies.some((a) => a.includes('malformed')), `anomaly for ${p}: ${JSON.stringify(anomalies)}`);
  }
  // The projection cannot be polluted through a forged journal: rebuild on
  // these events leaves a clean entries object (no prototype assignment).
  const a = await store.appendJournal([forged('__proto__')]);
  assert.ok(a.ok);
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const rb = await rebuildIndexFromEvents(store, journal.value);
  assert.ok(rb.ok);
  const idx = await loadIndex(store);
  assert.ok(idx.ok);
  assert.equal(Object.getPrototypeOf(idx.value.entries), Object.prototype);
  assert.equal(Object.hasOwn(idx.value.entries, '__proto__'), false);
});

test('paths colliding with inherited Object members record and verify honestly', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // 'constructor'/'toString' are legal safe-relative filenames — without
  // own-property lookups they resolve through the prototype and corrupt
  // receipt bookkeeping.
  for (const p of ['constructor', 'toString', 'outputs/hasOwnProperty.md']) {
    const r = await recordManagedWrite(store, p, `bytes-${p}`, 'runner');
    assert.ok(r.ok, `record ${p}: ${JSON.stringify(r)}`);
    const rv = await readVerifiedArtifact(store, p);
    assert.ok(rv.ok);
    assert.equal(rv.value.verdict.status, 'ok', `verify ${p}`);
  }
  const idx = await loadIndex(store);
  assert.ok(idx.ok);
  for (const p of ['constructor', 'toString', 'outputs/hasOwnProperty.md']) {
    assert.ok(Object.hasOwn(idx.value.entries, p), `own entry for ${p}`);
  }
});

test('recordManagedWrite and noteReceipt refuse receipt-forbidden paths', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  for (const p of ['__proto__', 'events.jsonl', 'lock', INTEGRITY_INDEX_PATH]) {
    const w = await recordManagedWrite(store, p, 'x', 'runner');
    assert.ok(!w.ok, `recordManagedWrite ${p} must fail`);
    assert.equal(w.error.details?.reason, 'forbidden_receipt_path');
    const n = await noteReceipt(store, p, 'x', 'runner');
    assert.ok(!n.ok, `noteReceipt ${p} must fail`);
  }
});

// ─── index↔journal drift: adoption + anomaly evidence ───────────────────────

test('interrupted index write: identical-bytes replay adopts the orphan with evidence', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const receipts = new Map();
  // v1 journaled normally.
  const r1 = await recordManagedWrite(store, 'claims.json', 'V1', 'ledger', { prior: receipts });
  assert.ok(r1.ok);
  receipts.set('claims.json', r1.value.receipt);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'claim.updated', actor: 'engine', payload: receiptJournalFields(r1.value.receipt) },
  ]);
  // Crash window (b): v2 bytes + index landed, journal append never did.
  const r2 = await recordManagedWrite(store, 'claims.json', 'V2', 'ledger', { prior: receipts });
  assert.ok(r2.ok);
  // Simulate the crash: the caller's journal-authoritative map still has v1.
  // Replay regenerates IDENTICAL bytes — the index orphan is adopted: the
  // journaled receipt binds exactly v2, no phantom v3 is minted.
  const replay = await recordManagedWrite(store, 'claims.json', 'V2', 'ledger', { prior: receipts });
  assert.ok(replay.ok);
  assert.equal(replay.value.receipt.version, 2, 'adopted the orphaned index receipt');
  assert.equal(replay.value.receipt.sha256, sha('V2'));
  assert.ok(replay.value.indexAnomaly !== undefined, 'adoption is surfaced as evidence');
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'claim.updated', actor: 'engine', payload: receiptJournalFields(replay.value.receipt) },
  ]);
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const { receipts: jr, anomalies } = collectReceipts(journal.value);
  assert.equal(jr.get('claims.json')!.version, 2);
  assert.deepEqual(anomalies, [], 'adopted replay leaves a clean v1→v2 chain');
});

test('interrupted index write: different-bytes replay bumps version and preserves evidence', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const receipts = new Map();
  const r1 = await recordManagedWrite(store, 'claims.json', 'V1', 'ledger', { prior: receipts });
  assert.ok(r1.ok);
  receipts.set('claims.json', r1.value.receipt);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'claim.updated', actor: 'engine', payload: receiptJournalFields(r1.value.receipt) },
  ]);
  // Unjournaled v2 index entry (interrupted write), then the replay
  // regenerates DIFFERENT bytes — the standing v2 index entry is evidence,
  // the anomaly is surfaced, and the new mint is v3: the journaled chain
  // v1→v3 honestly shows the dropped v2 as a version skip.
  const r2 = await recordManagedWrite(store, 'claims.json', 'V2-interrupted', 'ledger', { prior: receipts });
  assert.ok(r2.ok);
  const replay = await recordManagedWrite(store, 'claims.json', 'V2-regenerated', 'ledger', { prior: receipts });
  assert.ok(replay.ok);
  assert.equal(replay.value.receipt.version, 3, 'never re-mint over the orphan version');
  assert.ok(replay.value.indexAnomaly !== undefined && replay.value.indexAnomaly.includes('ahead'));
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'claim.updated', actor: 'engine', payload: receiptJournalFields(replay.value.receipt) },
  ]);
  const journal = await store.readJournal();
  assert.ok(journal.ok);
  const { anomalies } = collectReceipts(journal.value);
  assert.ok(anomalies.some((a) => a.includes('version skip')), 'dropped v2 stays visible as a chain gap');
});

test('index-only entry with no journaled receipt is surfaced on the next write', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // First-ever write lands in the index but its journal receipt is lost.
  const r1 = await recordManagedWrite(store, 'outputs/orphan.md', 'orphan-v1', 'worker_output');
  assert.ok(r1.ok);
  // Replay with different bytes and an EMPTY journal map: the index-only
  // entry must be surfaced — silent version bump would hide the evidence.
  const replay = await recordManagedWrite(store, 'outputs/orphan.md', 'orphan-v2', 'worker_output', { prior: new Map() });
  // worker_output is immutable: different bytes on an existing file is
  // refused preserve-first — the original is intact and the conflict is
  // the evidence.
  assert.ok(!replay.ok);
  assert.equal(replay.error.details?.reason, 'receipt_conflict');
  assert.equal(readFileSync(path.join(runDir, 'outputs/orphan.md'), 'utf8'), 'orphan-v1');
  // A versioned category instead: index-only entry → anomaly + v2 mint.
  const w1 = await recordManagedWrite(store, 'meta/report.json', 'R1', 'report');
  assert.ok(w1.ok);
  const w2 = await recordManagedWrite(store, 'meta/report.json', 'R2', 'report', { prior: new Map() });
  assert.ok(w2.ok);
  assert.equal(w2.value.receipt.version, 2);
  assert.ok(w2.value.indexAnomaly !== undefined && w2.value.indexAnomaly.includes('index-only'), JSON.stringify(w2.value.indexAnomaly));
});

test('stale and same-version-divergent index entries surface anomalies', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const receipts = new Map();
  const r1 = await recordManagedWrite(store, 'claims.json', 'A', 'ledger', { prior: receipts });
  assert.ok(r1.ok);
  receipts.set('claims.json', r1.value.receipt);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'claim.updated', actor: 'engine', payload: receiptJournalFields(r1.value.receipt) },
  ]);
  const r2 = await recordManagedWrite(store, 'claims.json', 'B', 'ledger', { prior: receipts });
  assert.ok(r2.ok);
  receipts.set('claims.json', r2.value.receipt);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'claim.updated', actor: 'engine', payload: receiptJournalFields(r2.value.receipt) },
  ]);
  // Tamper: wind the index entry back to v1 bytes → lags the journal.
  const idx = await loadIndex(store);
  assert.ok(idx.ok);
  idx.value.entries['claims.json'] = { ...r1.value.receipt, recordedAt: new Date().toISOString() };
  writeFileSync(path.join(runDir, INTEGRITY_INDEX_PATH), JSON.stringify(idx.value, null, 2));
  const w = await recordManagedWrite(store, 'claims.json', 'C', 'ledger', { prior: receipts });
  assert.ok(w.ok);
  assert.equal(w.value.receipt.version, 3);
  assert.ok(w.value.indexAnomaly !== undefined && w.value.indexAnomaly.includes('lags'), JSON.stringify(w.value.indexAnomaly));
  receipts.set('claims.json', w.value.receipt);
  await store.appendJournal([
    { ts: new Date().toISOString(), type: 'claim.updated', actor: 'engine', payload: receiptJournalFields(w.value.receipt) },
  ]);
  // Tamper: same version as the journal, different hash → divergent projection.
  const idx2 = await loadIndex(store);
  assert.ok(idx2.ok);
  idx2.value.entries['claims.json'] = { ...w.value.receipt, sha256: sha('forged'), recordedAt: new Date().toISOString() };
  writeFileSync(path.join(runDir, INTEGRITY_INDEX_PATH), JSON.stringify(idx2.value, null, 2));
  const w2 = await recordManagedWrite(store, 'claims.json', 'D', 'ledger', { prior: receipts });
  assert.ok(w2.ok);
  assert.ok(w2.value.indexAnomaly !== undefined && w2.value.indexAnomaly.includes('same-version'), JSON.stringify(w2.value.indexAnomaly));
});

// ─── receipt-path binding ────────────────────────────────────────────────────

test('a receipt minted for a different path fails visibly, not as mismatch', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  const r = await recordManagedWrite(store, 'outputs/a.md', 'x', 'worker_output');
  assert.ok(r.ok);
  const w = await store.writeArtifact('outputs/b.md', 'x');
  assert.ok(w.ok);
  const rv = await readVerifiedArtifact(store, 'outputs/b.md', { receipt: r.value.receipt });
  assert.ok(!rv.ok);
  assert.equal(rv.error.details?.reason, 'receipt_path_mismatch');
  // Same through a hand-built map whose value path disagrees with its key.
  const badMap = new Map([['outputs/b.md', r.value.receipt]]);
  const rv2 = await readVerifiedArtifact(store, 'outputs/b.md', { receipts: badMap });
  assert.ok(!rv2.ok && rv2.error.details?.reason === 'receipt_path_mismatch');
});

test('legacy run: index-bound read is honestly untracked, not an error', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await makeLegacyRun(runDir);
  const w = await store.writeArtifact('outputs/legacy.md', 'old content');
  assert.ok(w.ok);
  const rv = await readVerifiedArtifact(store, 'outputs/legacy.md');
  assert.ok(rv.ok, JSON.stringify(rv));
  assert.equal(rv.value.verdict.status, 'untracked');
  assert.equal(rv.value.verdict.source, 'none');
  assert.equal(rv.value.text, 'old content', 'caller still receives the real bytes');
  // Unknown marker values are a conflict, not a silent untracked.
  const metaPath = path.join(runDir, STORE_PATHS.council);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  meta.integrityPolicy = 'receipts-v9';
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  const rv2 = await readVerifiedArtifact(store, 'outputs/legacy.md');
  assert.ok(!rv2.ok && rv2.error.details?.reason === 'integrity_policy_conflict');
});

test('crafted __proto__ index key is rejected at parse time', async () => {
  const runDir = path.join(tmp(), 'run');
  const store = await initStore(runDir);
  // JSON.parse produces a genuine own-property '__proto__' key — the parser
  // must reject it rather than let it reach a Record assignment.
  const crafted = JSON.parse(
    `{"schemaVersion":${JSON.stringify(SCHEMA_VERSION)},"policy":"${INTEGRITY_POLICY}","runId":"${RUN_ID}","updatedAt":"t","entries":{"__proto__":{"path":"__proto__","category":"runner","sha256":"${sha('x')}","bytes":1,"version":1,"recordedAt":"t"}}}`,
  );
  const parsed = parseIntegrityIndex(crafted);
  assert.ok(!parsed.ok, '__proto__ entry key refused');
  writeFileSync(path.join(runDir, INTEGRITY_INDEX_PATH), JSON.stringify(crafted));
  const idx = await loadIndex(store);
  assert.ok(!idx.ok);
});
