// Fake "orca" fixture: emits a normal JSON envelope on stdout.
// Fixture selects a canned response by the first argv entry.
const which = process.argv[2] ?? 'ok';
const bodies = {
  ok: { ok: true, result: { runId: 'run_fixture001' } },
  failed: { ok: false, error: { code: 'invalid_argument', message: 'Unknown flag --from' } },
  unknown: { ok: false, error: { code: 'outcome_unknown', message: 'request timed out; effect unknown', data: { requestId: 'req_1' } } },
};
process.stdout.write(JSON.stringify(bodies[which] ?? bodies.ok));
