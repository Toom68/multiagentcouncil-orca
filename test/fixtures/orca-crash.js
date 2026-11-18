// Fake "orca" fixture: exits nonzero with partial unstructured output.
process.stdout.write('partial garbage that is not json');
process.stderr.write('panic: something broke\n');
process.exit(3);
