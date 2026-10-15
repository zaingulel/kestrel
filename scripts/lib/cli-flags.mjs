// cli-flags.mjs — rejection of unknown command-line arguments.
//
// A rejected argument THROWS: printing it and choosing the exit code are the command's job,
// so this file is pure and testable without spawning a script.

export function rejectUnknownArgs(argv, { flags, positionals, expectation }) {
  let nextPositional = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const valueCount = flags.get(arg);
    if (valueCount !== undefined) {
      for (let value = 0; value < valueCount && !argv[i + 1]?.startsWith('--'); value += 1) i += 1;
      continue;
    }
    if (positionals[nextPositional]?.(arg, i)) {
      nextPositional += 1;
      continue;
    }
    throw new Error(`unrecognised argument "${arg}" — ${expectation}`);
  }
}

