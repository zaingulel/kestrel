import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseSingleSelectField,
  optionIdFor,
  parseIssueItemId,
  parseIssueItemValue,
  parseBatchArgs,
  moveCards,
  moveLanes,
} from './board-move.mjs';
import { BOARD_PROJECT_NUMBER } from './board-config.mjs';
import { installFakeGh } from './fake-gh.mjs';

// Shapes mirror the real `gh api graphql` payloads (verified live against the board
// while fixing #461). Expected ids are independent literals.
const STATUS_FIELD_JSON = {
  data: {
    user: {
      projectV2: {
        id: 'PVT_kwHOA50uGs4BcfoO',
        field: {
          id: 'PVTSSF_status',
          options: [
            { id: 'opt-backlog', name: 'Backlog' },
            { id: 'opt-ready', name: 'Ready' },
            { id: 'opt-inprogress', name: 'In progress' },
            { id: 'opt-inreview', name: 'In review' },
            { id: 'opt-done', name: 'Done' },
          ],
        },
      },
    },
  },
};

function issueItemJson(nodes) {
  return { data: { repository: { issue: { projectItems: { nodes } } } } };
}

test('parseSingleSelectField returns projectId + fieldId + options', () => {
  assert.deepEqual(parseSingleSelectField(STATUS_FIELD_JSON), {
    projectId: 'PVT_kwHOA50uGs4BcfoO',
    fieldId: 'PVTSSF_status',
    options: STATUS_FIELD_JSON.data.user.projectV2.field.options,
  });
});

test('parseSingleSelectField throws (fail-loud) when the project id is missing', () => {
  assert.throws(() => parseSingleSelectField({ data: { user: { projectV2: {} } } }), /no project id/);
});

test('parseSingleSelectField throws (fail-loud) when the Status field is missing', () => {
  assert.throws(
    () => parseSingleSelectField({ data: { user: { projectV2: { id: 'PVT_x' } } } }),
    /no "Status" field/,
  );
});

// board-add.mjs reads Workstream through this same parser, so the non-default
// fieldName path needs its own coverage: without it the parameter is only ever
// exercised on its default and a Workstream failure could name the wrong field.
test('parseSingleSelectField names a non-default field in both fail-loud messages', () => {
  assert.throws(
    () => parseSingleSelectField({ data: { user: { projectV2: {} } } }, 'Workstream'),
    /workstream-field JSON has no project id/,
  );
  assert.throws(
    () => parseSingleSelectField({ data: { user: { projectV2: { id: 'PVT_x' } } } }, 'Workstream'),
    /no "Workstream" field on the project/,
  );
});

test('optionIdFor is case-insensitive and handles multi-word statuses', () => {
  const options = STATUS_FIELD_JSON.data.user.projectV2.field.options;
  assert.equal(optionIdFor(options, 'Done'), 'opt-done');
  assert.equal(optionIdFor(options, 'done'), 'opt-done');
  assert.equal(optionIdFor(options, 'In review'), 'opt-inreview');
  assert.equal(optionIdFor(options, '  in progress '), 'opt-inprogress');
});

test('optionIdFor throws on an unknown status, naming the valid options', () => {
  const options = STATUS_FIELD_JSON.data.user.projectV2.field.options;
  assert.throws(() => optionIdFor(options, 'Bogus'), /unknown Status "Bogus".*Done/s);
});

test('parseIssueItemId picks the configured project\'s node among others; throws when not on the board', () => {
  const json = issueItemJson([
    { id: 'item-other-project', project: { number: BOARD_PROJECT_NUMBER + 1 } },
    { id: 'item-a', project: { number: BOARD_PROJECT_NUMBER } },
  ]);
  assert.equal(parseIssueItemId(json, 453), 'item-a');
  // One assertion pins the whole refusal as a contiguous message: the diagnosis AND the
  // scripted way forward. Without the pointer the caller falls back to a bare
  // `gh project item-add` and leaves an unfielded card behind.
  assert.throws(
    () => parseIssueItemId(issueItemJson([{ id: 'x', project: { number: BOARD_PROJECT_NUMBER + 1 } }]), 999),
    /#999 is not on the board — add it with Status and Workstream: node scripts\/board-add\.mjs 999 <Status> <Workstream>/,
  );
});

test('parseIssueItemId throws (fail-loud) on malformed JSON', () => {
  assert.throws(() => parseIssueItemId({ data: { repository: { issue: {} } } }, 453), /no nodes\[\] array/);
});

test('parseIssueItemValue reads the configured project\'s node\'s current field value, or null with no value', () => {
  const withStatus = issueItemJson([{ id: 'item-a', project: { number: BOARD_PROJECT_NUMBER }, value: { name: 'Done' } }]);
  assert.equal(parseIssueItemValue(withStatus, 453), 'Done');
  const withoutStatus = issueItemJson([{ id: 'item-b', project: { number: BOARD_PROJECT_NUMBER }, value: null }]);
  assert.equal(parseIssueItemValue(withoutStatus, 453), null);
  assert.throws(
    () => parseIssueItemValue(issueItemJson([{ id: 'x', project: { number: BOARD_PROJECT_NUMBER + 1 } }]), 999),
    /#999 is not on the board/,
  );
});

test('parseBatchArgs parses "<issue#>:<Status>" pairs, incl. multi-word "In review"', () => {
  assert.deepEqual(parseBatchArgs(['453:Done', '454:In review']), [
    { issueNumber: 453, statusName: 'Done' },
    { issueNumber: 454, statusName: 'In review' },
  ]);
});

test('parseBatchArgs throws on a malformed pair', () => {
  assert.throws(() => parseBatchArgs(['453'])); // missing colon
  assert.throws(() => parseBatchArgs(['abc:Done'])); // non-numeric issue
  assert.throws(() => parseBatchArgs(['453:'])); // empty status
  assert.throws(() => parseBatchArgs([':Done'])); // missing issue number
});

// A `--lane` typo must be described as a Lane, not sent to the reader as a Status.
test('parseBatchArgs names the value label it is given in its errors, not Status', () => {
  assert.throws(() => parseBatchArgs(['12'], 'Lane'), {
    message: 'malformed batch pair "12" — expected "<issue#>:<Lane>"',
  });
  assert.throws(() => parseBatchArgs(['12:'], 'Lane'), {
    message: 'malformed batch pair "12:" — lane must not be empty',
  });
});

// Records every exec() call so we can assert the exact call count + order — the
// #461 acceptance criterion (status-field query resolved ONCE regardless of pair
// count, not once per card). `currentStatusByIssue` is optional per-issue Status,
// absent by default (no value, never mistaken for "already there").
function recordingExec(itemIdByIssue, currentStatusByIssue = {}) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    if (args[0] === 'api') {
      const query = args[3];
      if (query.includes('projectV2(number:')) return JSON.stringify(STATUS_FIELD_JSON);
      const match = query.match(/issue\(number:(\d+)\)/);
      const issueNumber = Number(match[1]);
      const status = currentStatusByIssue[issueNumber];
      return JSON.stringify(issueItemJson([{
        id: itemIdByIssue[issueNumber],
        project: { number: BOARD_PROJECT_NUMBER },
        value: status ? { name: status } : null,
      }]));
    }
    return '';
  };
  return { exec, calls };
}

test('moveCards over 3 pairs issues exactly 1 status-field query, 3 issue resolves, 3 item-edits, in that order', () => {
  const { exec, calls } = recordingExec({ 453: 'item-453', 454: 'item-454', 455: 'item-455' });
  const pairs = [
    { issueNumber: 453, statusName: 'Done' },
    { issueNumber: 454, statusName: 'In review' },
    { issueNumber: 455, statusName: 'In progress' },
  ];
  const completed = moveCards(pairs, exec);

  assert.deepEqual(completed, pairs.map((p) => ({ ...p, skipped: false, cleared: false })));
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[0].slice(0, 3), ['api', 'graphql', '-f']);
  assert.match(calls[0][3], new RegExp(`projectV2\\(number:${BOARD_PROJECT_NUMBER}\\)`));
  // Per pair: issue resolve query, then item-edit — in that order.
  const expectedOptionIds = { 453: 'opt-done', 454: 'opt-inreview', 455: 'opt-inprogress' };
  const expectedItemIds = { 453: 'item-453', 454: 'item-454', 455: 'item-455' };
  for (let i = 0; i < pairs.length; i++) {
    const resolveCall = calls[1 + i * 2];
    const editCall = calls[2 + i * 2];
    assert.equal(resolveCall[0], 'api');
    assert.match(resolveCall[3], new RegExp(`issue\\(number:${pairs[i].issueNumber}\\)`));
    assert.deepEqual(editCall, [
      'project', 'item-edit',
      '--id', expectedItemIds[pairs[i].issueNumber],
      '--project-id', 'PVT_kwHOA50uGs4BcfoO',
      '--field-id', 'PVTSSF_status',
      '--single-select-option-id', expectedOptionIds[pairs[i].issueNumber],
    ]);
  }
});

test('moveCards over a single pair issues exactly 1 status-field query + 1 issue resolve + 1 item-edit', () => {
  const { exec, calls } = recordingExec({ 272: 'item-272' });
  const completed = moveCards([{ issueNumber: 272, statusName: 'Done' }], exec);
  assert.deepEqual(completed, [{ issueNumber: 272, statusName: 'Done', skipped: false, cleared: false }]);
  assert.equal(calls.length, 3);
  assert.match(calls[0][3], new RegExp(`projectV2\\(number:${BOARD_PROJECT_NUMBER}\\)`));
  assert.match(calls[1][3], /issue\(number:272\)/);
  assert.equal(calls[2][0], 'project');
});

// The closeout no-op acceptance criterion: a card the item-closed workflow already
// moved to Done must not receive a second, redundant Status write.
test('moveCards skips the item-edit when the card is already at the target Status', () => {
  const { exec, calls } = recordingExec({ 272: 'item-272' }, { 272: 'Done' });
  const completed = moveCards([{ issueNumber: 272, statusName: 'Done' }], exec);
  assert.deepEqual(completed, [{ issueNumber: 272, statusName: 'Done', skipped: true, cleared: false }]);
  // Only the status-field query and the issue resolve ran — no item-edit.
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c[0] !== 'project'), JSON.stringify(calls));
});

test('moveCards skips are case-insensitive and still write when the current Status differs', () => {
  const { exec: skipExec, calls: skipCalls } = recordingExec({ 272: 'item-272' }, { 272: 'done' });
  moveCards([{ issueNumber: 272, statusName: 'Done' }], skipExec);
  assert.ok(skipCalls.every((c) => c[0] !== 'project'), 'case difference should still count as already there');

  const { exec: writeExec, calls: writeCalls } = recordingExec({ 272: 'item-272' }, { 272: 'In review' });
  const completed = moveCards([{ issueNumber: 272, statusName: 'Done' }], writeExec);
  assert.deepEqual(completed, [{ issueNumber: 272, statusName: 'Done', skipped: false, cleared: false }]);
  assert.ok(writeCalls.some((c) => c[0] === 'project'), 'a real status difference must still write');
});

test('moveCards throws (fail-loud) on a per-pair failure, naming already-completed moves', () => {
  const { exec } = recordingExec({ 453: 'item-453' }); // 454 has no item id → item-edit reads undefined but that's fine, failure comes from unknown status
  const pairs = [
    { issueNumber: 453, statusName: 'Done' },
    { issueNumber: 454, statusName: 'Nonexistent Status' },
  ];
  assert.throws(() => moveCards(pairs, exec), /#453 → Done.*unknown Status "Nonexistent Status"/s);
});

// #464 review: the wrapped per-pair error must carry the original as `cause` so
// ghExec's quota classification and the real stack stay diagnosable.
test('moveCards preserves the underlying error as cause on a per-pair failure', () => {
  const { exec } = recordingExec({ 453: 'item-453' });
  try {
    moveCards([{ issueNumber: 453, statusName: 'Nonexistent Status' }], exec);
    assert.fail('expected moveCards to throw');
  } catch (err) {
    assert.ok(err.cause instanceof Error, 'cause missing');
    assert.match(err.cause.message, /unknown Status "Nonexistent Status"/);
  }
});

// #464 review: moveCards validates its own inputs — the exported moveCard() is an
// in-process entry point, and issueNumber is interpolated into the GraphQL query,
// so an unvalidated value must fail before any query is built.
test('moveCards rejects a non-integer issue number and an empty status before querying', () => {
  const { exec, calls } = recordingExec({});
  assert.throws(
    () => moveCards([{ issueNumber: '461; }', statusName: 'In progress' }], exec),
    /invalid issue number/,
  );
  assert.throws(
    () => moveCards([{ issueNumber: 461, statusName: '   ' }], exec),
    /invalid status name/,
  );
  // Only the shared status-field query may have run — never an issue resolve.
  assert.ok(calls.every((c) => !c.join(' ').includes('projectItems')), 'issue resolve ran on invalid input');
});

const NO_PARKED_LANE = '--lane needs a parked lane, but scripts/lib/board-config.mjs sets PARKED_LANE = null';

test('moveLanes with no parked lane configured fails loud naming board-config.mjs before any gh call', () => {
  const { exec, calls } = recordingExec({ 12: 'item-12' });
  assert.throws(() => moveLanes([{ issueNumber: 12, statusName: 'none' }], exec), { message: NO_PARKED_LANE });
  assert.deepEqual(calls, []);
});

// Only the real process shows the CLI wires `--lane` to moveLanes and reports its refusal:
// any `gh` call fails the stand-in loud (exit 2) and is logged, so a lane write that
// reached GitHub before the refusal shows in the calls file.
const fakeGh = installFakeGh('board-move-cli-', `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_CALLS, args.join(' ') + '\\n');
process.stderr.write('unexpected gh invocation: ' + args.join(' '));
process.exitCode = 2;
`);
after(() => fakeGh.cleanup());

test('board-move --lane with no parked lane configured exits 1 naming board-config.mjs and never calls gh', () => {
  const callsFile = fakeGh.newCallsFile();
  writeFileSync(callsFile, '');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../board-move.mjs', import.meta.url)), '--lane', '12:none'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: fakeGh.env({ FAKE_GH_CALLS: callsFile }),
  });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, `board-move: ${NO_PARKED_LANE}\n`);
  assert.equal(readFileSync(callsFile, 'utf8'), '');
});
