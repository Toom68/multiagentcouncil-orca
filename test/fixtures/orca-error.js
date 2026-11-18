// Fake "orca" fixture: emits the CLI's flat stderr error shape and exits 1.
process.stderr.write('error: invalid_argument: Unknown flag --bogus for command: orchestration send\n');
process.exit(1);
