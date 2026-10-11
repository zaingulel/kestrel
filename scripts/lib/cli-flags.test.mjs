import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numericFlagReader, rejectUnknownArgs } from './cli-flags.mjs';

// The reader's whole contract, in process: it throws rather than printing and exiting, so each
// case is reached here without spawning a CLI.

const nonNegative = { valid: (v) => Number.isFinite(v) && v >= 0, expectation: 'a non-negative number' };

test('an absent flag returns the default and a present valid value is returned as a number', () => {
  const flag = numericFlagReader(['--cap-min', '0.5']);

  assert.equal(flag('--interval', 30, nonNegative), 30);
  assert.equal(flag('--cap-min', 25, nonNegative), 0.5);
});

// The message is the operator's whole explanation, so it is asserted verbatim: it pins the flag
// name, the offending value AND the expectation phrase, which travelled as a loose literal at each
// call site until it was paired with its predicate here. A tightened predicate now cannot leave the
// phrase behind without this going red.
test('a non-numeric value throws naming the flag, the expectation and the offending value', () => {
  const flag = numericFlagReader(['--cap-min', 'abc']);

  assert.throws(
    () => flag('--cap-min', 25, nonNegative),
    { message: '--cap-min needs a non-negative number, got "abc"' },
  );
});

// The silent-wrong half of #591: falling back to the default here discards the bound the operator
// asked for and says nothing. A flag as the FINAL argument has no value at all, and a flag followed
// by another FLAG is the same mistake wearing a value.
test('a flag present with no value throws instead of falling back to the default', () => {
  assert.throws(
    () => numericFlagReader(['--cap-min'])('--cap-min', 25, nonNegative),
    { message: '--cap-min needs a non-negative number, got ""' },
  );
  assert.throws(
    () => numericFlagReader(['--cap-min', '--interval', '5'])('--cap-min', 25, nonNegative),
    { message: '--cap-min needs a non-negative number, got "--interval"' },
  );
});

// Number('') and Number('   ') are 0, not NaN, so a bare `Number(raw)` would accept an empty value
// as a legitimate zero bound — a 0-minute cap that reads as deliberate.
test('an empty or blank value throws instead of becoming Number("") === 0', () => {
  assert.throws(
    () => numericFlagReader(['--cap-min', ''])('--cap-min', 25, nonNegative),
    { message: '--cap-min needs a non-negative number, got ""' },
  );
  assert.throws(
    () => numericFlagReader(['--cap-min', '  '])('--cap-min', 25, nonNegative),
    { message: '--cap-min needs a non-negative number, got "  "' },
  );
});

// indexOf finds the FIRST occurrence, which callers rely on: they append raw
// arguments after its own typed bounds, so a repeat has to lose to the earlier one.
test('a repeated flag reads the first occurrence, not the last', () => {
  const flag = numericFlagReader(['--cap-min', '1', '--cap-min', '2']);

  assert.equal(flag('--cap-min', 25, nonNegative), 1);
});

test('rejectUnknownArgs accepts declared arguments and names the first unknown token', () => {
  const isJson = (arg) => arg.endsWith('.json');
  const known = {
    flags: new Map([['--cap-min', 1], ['--verbose', 0]]),
    positionals: [(arg, index) => index === 3 && isJson(arg)],
    expectation: 'expected [--cap-min <minutes>] [--verbose] <report.json>',
  };

  assert.doesNotThrow(() => rejectUnknownArgs(['--cap-min', '5', '--verbose', 'report.json'], known));
  assert.throws(
    () => rejectUnknownArgs(['--cap-mni', '5'], known),
    { message: 'unrecognised argument "--cap-mni" — expected [--cap-min <minutes>] [--verbose] <report.json>' },
  );
  assert.throws(
    () => rejectUnknownArgs(['report.json', 'extra.json'], { ...known, positionals: [isJson] }),
    { message: 'unrecognised argument "extra.json" — expected [--cap-min <minutes>] [--verbose] <report.json>' },
  );
});
