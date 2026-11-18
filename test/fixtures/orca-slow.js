// Fake "orca" fixture: hangs so the timeout/kill path is exercised.
setTimeout(() => process.exit(0), 60_000);
