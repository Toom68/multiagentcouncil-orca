/**
 * Tests for src/hostmem.ts — the `council doctor` host-memory probe.
 *
 * Parsers and the fit estimate are exercised on fixed Windows CIM output,
 * a /proc/meminfo sample, and injected probe failures — no real powershell
 * spawn and no real filesystem read happens in unit tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SESSION_COMMIT_MB,
  DEFAULT_SESSION_RAM_MB,
  estimateAdditionalSessions,
  parseProcMeminfo,
  parseWindowsCommitOutput,
  peakCouncilSessions,
  probeHostMemory,
  sessionFootprintFromEnv,
} from '../src/hostmem.js';
import type { ProcessResult, SpawnPlan } from '../src/host/process.js';

const MB = 1024 * 1024;

function procResult(partial: Partial<ProcessResult>): ProcessResult {
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

// ─── Windows CIM output parsing ─────────────────────────────────────────────

test('parseWindowsCommitOutput parses single-object CIM JSON (KB)', () => {
  const out = parseWindowsCommitOutput(
    '{"FreeVirtualMemory":52428800,"TotalVirtualMemorySize":78000000}',
  );
  assert.deepEqual(out, { freeKb: 52_428_800, totalKb: 78_000_000 });
});

test('parseWindowsCommitOutput accepts an array-wrapped row', () => {
  const out = parseWindowsCommitOutput(
    '[{"FreeVirtualMemory":1024,"TotalVirtualMemorySize":2048}]',
  );
  assert.deepEqual(out, { freeKb: 1024, totalKb: 2048 });
});

test('parseWindowsCommitOutput rejects garbage, missing and invalid fields', () => {
  assert.equal(parseWindowsCommitOutput('not json'), null);
  assert.equal(parseWindowsCommitOutput('{"FreeVirtualMemory":1}'), null);
  assert.equal(parseWindowsCommitOutput('{"TotalVirtualMemorySize":1}'), null);
  assert.equal(parseWindowsCommitOutput('{"FreeVirtualMemory":-5,"TotalVirtualMemorySize":10}'), null);
  assert.equal(parseWindowsCommitOutput('{"FreeVirtualMemory":5,"TotalVirtualMemorySize":0}'), null);
  assert.equal(parseWindowsCommitOutput('"a string"'), null);
  assert.equal(parseWindowsCommitOutput(''), null);
});

// ─── /proc/meminfo parsing ──────────────────────────────────────────────────

const MEMINFO_SAMPLE = [
  'MemTotal:       16384000 kB',
  'MemFree:         1024000 kB',
  'MemAvailable:    8192000 kB',
  'CommitLimit:    32768000 kB',
  'Committed_AS:   20480000 kB',
].join('\n');

test('parseProcMeminfo extracts MemAvailable and commit fields', () => {
  assert.deepEqual(parseProcMeminfo(MEMINFO_SAMPLE), {
    memAvailableKb: 8_192_000,
    commitLimitKb: 32_768_000,
    committedASKb: 20_480_000,
  });
});

test('parseProcMeminfo reports partial data and rejects empty input', () => {
  assert.deepEqual(parseProcMeminfo('MemAvailable:  4096 kB\n'), { memAvailableKb: 4096 });
  assert.equal(parseProcMeminfo(''), null);
  assert.equal(parseProcMeminfo('unrelated: text\n'), null);
});

// ─── Per-session footprint env overrides ────────────────────────────────────

test('sessionFootprintFromEnv defaults to the measured Devin-worker footprint', () => {
  assert.deepEqual(sessionFootprintFromEnv({}), {
    commitMb: DEFAULT_SESSION_COMMIT_MB,
    ramMb: DEFAULT_SESSION_RAM_MB,
  });
});

test('sessionFootprintFromEnv honors positive overrides and rejects junk', () => {
  assert.deepEqual(
    sessionFootprintFromEnv({ COUNCIL_SESSION_COMMIT_MB: '5000', COUNCIL_SESSION_RAM_MB: '700' }),
    { commitMb: 5000, ramMb: 700 },
  );
  for (const bad of ['0', '-10', 'abc', '']) {
    assert.equal(
      sessionFootprintFromEnv({ COUNCIL_SESSION_COMMIT_MB: bad }).commitMb,
      DEFAULT_SESSION_COMMIT_MB,
      `commit override ${JSON.stringify(bad)} must default`,
    );
    assert.equal(
      sessionFootprintFromEnv({ COUNCIL_SESSION_RAM_MB: bad }).ramMb,
      DEFAULT_SESSION_RAM_MB,
      `ram override ${JSON.stringify(bad)} must default`,
    );
  }
});

// ─── Peak retained sessions + fit estimate ──────────────────────────────────

test('peakCouncilSessions counts seats plus scribe and supervisor', () => {
  assert.equal(peakCouncilSessions({ participants: 15 }), 17);
  assert.equal(peakCouncilSessions({ participants: 2 }), 4);
});

test('estimateAdditionalSessions takes the smaller of commit and RAM headroom', () => {
  const mem = { commitFreeMb: 10_240, ramFreeMb: 4_096 };
  const byCommit = estimateAdditionalSessions(mem, { commitMb: 3_400, ramMb: 400 });
  assert.deepEqual(byCommit, { additionalSessions: 3, limitedBy: 'commit' }); // 10240/3400
  const byRam = estimateAdditionalSessions(mem, { commitMb: 400, ramMb: 2_000 });
  assert.deepEqual(byRam, { additionalSessions: 2, limitedBy: 'ram' }); // 4096/2000
});

test('estimateAdditionalSessions is RAM-only when commit was not measured', () => {
  const est = estimateAdditionalSessions(
    { ramFreeMb: 1_000 },
    { commitMb: 3_400, ramMb: 500 },
  );
  assert.deepEqual(est, { additionalSessions: 2, limitedBy: 'ram' });
});

test('estimateAdditionalSessions prefers Linux MemAvailable over freemem', () => {
  const est = estimateAdditionalSessions(
    { commitFreeMb: 100_000, ramFreeMb: 100, memAvailableMb: 4_000 },
    { commitMb: 3_400, ramMb: 500 },
  );
  assert.deepEqual(est, { additionalSessions: 8, limitedBy: 'ram' }); // 4000/500, not 100/500
});

test('estimateAdditionalSessions floors at zero', () => {
  const est = estimateAdditionalSessions(
    { commitFreeMb: 10, ramFreeMb: 10 },
    { commitMb: 3_400, ramMb: 500 },
  );
  assert.equal(est.additionalSessions, 0);
});

// ─── Live probe (injected seams) ────────────────────────────────────────────

test('windows probe runs powershell argv with no shell and parses commit', async () => {
  const seen: SpawnPlan[] = [];
  const probe = await probeHostMemory({
    platform: 'win32',
    ramFreeBytes: 16 * 1024 * MB,
    ramTotalBytes: 64 * 1024 * MB,
    resolvePath: () => 'C:\\fake\\powershell.exe',
    spawn: async (plan) => {
      seen.push(plan);
      return procResult({
        stdout: JSON.stringify({ FreeVirtualMemory: 50 * 1024 * 1024, TotalVirtualMemorySize: 80 * 1024 * 1024 }),
      });
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.file, 'C:\\fake\\powershell.exe');
  assert.deepEqual([...seen[0]!.args.slice(0, 3)], ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(seen[0]!.args[3] ?? '', /Win32_OperatingSystem/);
  assert.equal(probe.commitProbed, true);
  assert.equal(probe.commitFreeMb, 50 * 1024);
  assert.equal(probe.commitTotalMb, 80 * 1024);
  assert.equal(probe.commitSource, 'windows-cim');
  assert.equal(probe.ramFreeMb, 16 * 1024);
  assert.equal(probe.commitUnverifiedReason, undefined);
});

test('windows probe failure reports the commit dimension unverified', async () => {
  for (const [label, proc] of [
    ['timeout', procResult({ reason: 'timed_out', exitCode: null })],
    ['spawn failure', procResult({ reason: 'spawn_failed', exitCode: null, stderr: 'ENOENT' })],
    ['nonzero exit', procResult({ exitCode: 1, stderr: 'Access denied' })],
    ['unparseable stdout', procResult({ stdout: 'hello' })],
  ] as const) {
    const probe = await probeHostMemory({
      platform: 'win32',
      ramFreeBytes: 16 * 1024 * MB,
      ramTotalBytes: 64 * 1024 * MB,
      resolvePath: () => 'C:\\fake\\powershell.exe',
      spawn: async () => proc,
    });
    assert.equal(probe.commitProbed, true, label);
    assert.equal(probe.commitFreeMb, undefined, label);
    assert.equal(typeof probe.commitUnverifiedReason, 'string', label);
    assert.ok(probe.ramFreeMb > 0, 'RAM is still reported on commit failure');
  }
  const unresolved = await probeHostMemory({
    platform: 'win32',
    ramFreeBytes: 16 * 1024 * MB,
    ramTotalBytes: 64 * 1024 * MB,
    resolvePath: () => {
      throw new Error('not found');
    },
    spawn: async () => procResult({}),
  });
  assert.equal(unresolved.commitFreeMb, undefined);
  assert.match(unresolved.commitUnverifiedReason ?? '', /powershell not resolvable/);
});

test('linux probe reads one /proc/meminfo for commit headroom and MemAvailable', async () => {
  let reads = 0;
  const probe = await probeHostMemory({
    platform: 'linux',
    ramFreeBytes: 1 * 1024 * MB, // freemem is conservative on Linux
    ramTotalBytes: 16 * 1024 * MB,
    readMeminfo: async () => {
      reads += 1;
      return MEMINFO_SAMPLE;
    },
  });
  assert.equal(reads, 1);
  assert.equal(probe.commitProbed, true);
  // commit headroom = CommitLimit - Committed_AS = 32768000-20480000 = 12288000 kB = 12000 MB
  assert.equal(probe.commitFreeMb, 12_000);
  assert.equal(probe.commitTotalMb, 32_000);
  assert.equal(probe.commitSource, 'linux-proc');
  assert.equal(probe.memAvailableMb, 8_000);
});

test('linux probe failure reports commit unverified with the reason', async () => {
  const probe = await probeHostMemory({
    platform: 'linux',
    ramFreeBytes: 1 * 1024 * MB,
    ramTotalBytes: 16 * 1024 * MB,
    readMeminfo: async () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(probe.commitProbed, true);
  assert.equal(probe.commitFreeMb, undefined);
  assert.match(probe.commitUnverifiedReason ?? '', /meminfo/);
  assert.equal(probe.ramFreeMb, 1 * 1024);
});

test('unsupported platforms report RAM only, commit unprobed', async () => {
  const probe = await probeHostMemory({
    platform: 'darwin',
    ramFreeBytes: 2 * 1024 * MB,
    ramTotalBytes: 16 * 1024 * MB,
    spawn: async () => {
      throw new Error('must never spawn on darwin');
    },
  });
  assert.equal(probe.commitProbed, false);
  assert.equal(probe.commitFreeMb, undefined);
  assert.match(probe.commitUnverifiedReason ?? '', /darwin/);
  assert.equal(probe.ramFreeMb, 2 * 1024);
});
