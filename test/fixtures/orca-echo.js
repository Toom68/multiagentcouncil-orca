// Fake "orca" fixture: prints its argv as a JSON envelope so tests can verify
// the adapter passed arguments literally (spaces preserved, no shell join).
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({ ok: true, result: { argv } }));
