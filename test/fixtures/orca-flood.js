// Fake "orca" fixture: floods stdout/stderr so output-cap handling is exercised.
const flood = 'x'.repeat(6 * 1024 * 1024);
process.stdout.write(flood);
process.stderr.write('e'.repeat(2 * 1024 * 1024));
