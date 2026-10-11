// cli-flags.mjs — the shared reader for numeric CLI flags and rejection of unknown arguments.
//
// Numeric flags are validated at parse time because a bad value fails SILENTLY otherwise: Number('abc')
// is NaN, and every comparison against NaN is false, so a bound the operator asked for becomes no bound
// at all and they are told nothing (#591). A flag PRESENT with no value (last argument, or followed by
// another flag) is an error too, not the default: substituting the default there discards what was
// asked for just as silently. The accepted range is PER-FLAG, so each flag passes its own
// { valid, expectation } pair: the predicate and the phrase the operator is told it accepts travel
// together so they cannot drift apart. A rejected value THROWS: printing it and choosing the exit
// code are the CLI wrapper's job, so this file is pure and testable without spawning a script.
export function numericFlagReader(argv) {
  return (name, def, { valid, expectation }) => {
    const i = argv.indexOf(name);
    if (i < 0) return def;
    const raw = argv[i + 1];
    const value = raw?.trim() ? Number(raw) : NaN; // '' and undefined must not become Number('') === 0
    if (!valid(value)) throw new Error(`${name} needs ${expectation}, got "${raw ?? ''}"`);
    return value;
  };
}

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

