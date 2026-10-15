import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectUnknownArgs } from './cli-flags.mjs';

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
