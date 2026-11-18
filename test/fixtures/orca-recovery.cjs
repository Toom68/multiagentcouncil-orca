/**
 * Fake `orca` CLI for council recovery tests — NEVER loaded directly.
 *
 * The real CLI boundary spawns `ORCA_CLI_COMMAND <argv>` with shell:false.
 * Tests point ORCA_CLI_COMMAND at the Node executable and inject this file
 * into every spawned node child via NODE_OPTIONS="--require <this file>".
 * The trick: `node orchestration run-current --json` makes argv[1] equal
 * 'orchestration', so this module detects an orca-shaped invocation, emits
 * the canned JSON envelope, and exits before Node tries to load a file named
 * 'orchestration'. Inside any other node process (the council CLI itself,
 * the test runner) it is a complete no-op.
 *
 * Scenario (FAKE_ORCA_SCENARIO — path to a JSON file):
 *   { "<argv1> <argv2>": [ <envelope>, <envelope>, ... ], ... }
 * Each key queues responses consumed FIFO per command family, e.g.
 *   "orchestration run-current": [{"ok":true,"result":{"runId":"run_1"}},
 *                                  {"ok":true,"result":{"runId":null}}]
 *   "terminal create":           [{"ok":true,"result":{"handle":"term_t1"}}]
 * A missing/exhausted queue returns {"ok":true,"result":{}}.
 * An envelope {"ok":false,"error":{code,message,data}} simulates a host
 * refusal/failure. Exit code is always 0 — the envelope carries the verdict.
 *
 * Every invocation appends one JSON line {"argv":[...]} to FAKE_ORCA_LOG so
 * tests can assert exactly which commands ran (or prove one never did).
 */
(function () {
  const argv = process.argv.slice(1);
  // Node resolves the entry point to an absolute path before preloads run,
  // so argv[0] is e.g. '.../orchestration' — compare the basename.
  const head = require('node:path').basename(argv[0] ?? '');
  if (head !== 'orchestration' && head !== 'terminal' && head !== 'status') return;

  const fs = require('node:fs');
  const log = process.env.FAKE_ORCA_LOG;
  if (log) {
    try {
      fs.appendFileSync(log, JSON.stringify({ argv }) + '\n');
    } catch {
      /* logging is observability, never fatal */
    }
  }

  // argv[0] is the resolved entry path — the family key is basename + verb.
  const key = `${head} ${argv[1] ?? ''}`;
  let envelope = { ok: true, result: {} };
  const scenarioPath = process.env.FAKE_ORCA_SCENARIO;
  if (scenarioPath) {
    try {
      const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
      const queue = scenario[key];
      if (Array.isArray(queue) && queue.length > 0) {
        const entry = queue[0];
        // Persist consumption so later processes see the remaining queue.
        queue.shift();
        try {
          fs.writeFileSync(scenarioPath, JSON.stringify(scenario));
        } catch {
          /* best effort — a read-only scenario simply replays */
        }
        if (entry && typeof entry === 'object') {
          // Spy seam: an entry may carry {"spyFile": "<abs>", "spyLabel": "…"}
          // asking the fake to snapshot that file into the call log at the
          // exact moment the host receives this command — e.g. proving the
          // durable record already said start_issued when worker-start ran.
          if (typeof entry.spyFile === 'string' && log) {
            try {
              const content = fs.readFileSync(entry.spyFile, 'utf8');
              fs.appendFileSync(
                log,
                JSON.stringify({ spy: entry.spyLabel ?? key, content }) + '\n',
              );
            } catch (e) {
              fs.appendFileSync(
                log,
                JSON.stringify({ spy: entry.spyLabel ?? key, error: String(e) }) + '\n',
              );
            }
          }
          envelope = { ok: entry.ok !== false, ...(entry.result !== undefined ? { result: entry.result } : {}), ...(entry.error !== undefined ? { error: entry.error } : {}), ...(entry.id !== undefined ? { id: entry.id } : {}) };
        }
      }
    } catch {
      /* a broken scenario yields the default empty ok envelope */
    }
  }

  process.stdout.write(JSON.stringify(envelope) + '\n');
  process.exit(0);
})();
