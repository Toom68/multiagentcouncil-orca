// Fake "orca" fixture: leaks a credential-shaped value on stderr so the
// process boundary's redaction can be verified.
process.stderr.write('fatal: auth failed for token sk-abcdefghijklmnopqrstuvwxyz\n');
process.exit(1);
