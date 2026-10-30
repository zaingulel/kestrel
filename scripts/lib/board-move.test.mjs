import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { installFakeGh } from './fake-gh.mjs';
import { GITHUB_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';

const toolkit = copyToolkit(GITHUB_TEST_CONFIG);
after(() => toolkit.cleanup());

const {
  parseSingleSelectField,
  optionIdFor,
  lookupIssueBoardItem,
  parseBatchArgs,
  moveCards,
  moveLanes,
} = await toolkit.load('lib/board-move.mjs');
const { main: boardMoveMain } = await toolkit.load('board-move.mjs');
const { BOARD_OWNER, BOARD_REPOSITORY, BOARD_OWNER_TYPE, BOARD_PROJECT_NUMBER } = await toolkit.load('lib/board-config.mjs');
const { issueItemReply } = await toolkit.load('lib/board-fixtures.mjs');

// Shapes mirror the real `gh api graphql` payloads (verified live against the board
// while fixing #461). Expected ids are independent literals.
const STATUS_FIELD_JSON = {
  data: {
    [BOARD_OWNER_TYPE]: {
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

test('parseSingleSelectField returns projectId + fieldId + options', () => {
  assert.deepEqual(parseSingleSelectField(STATUS_FIELD_JSON), {
    projectId: 'PVT_kwHOA50uGs4BcfoO',
    fieldId: 'PVTSSF_status',
    options: STATUS_FIELD_JSON.data[BOARD_OWNER_TYPE].projectV2.field.options,
  });
});

test('parseSingleSelectField throws (fail-loud) when the project id is missing', () => {
  assert.throws(() => parseSingleSelectField({ data: { [BOARD_OWNER_TYPE]: { projectV2: {} } } }), /no project id/);
});

test('parseSingleSelectField throws (fail-loud) when the Status field is missing', () => {
  assert.throws(
    () => parseSingleSelectField({ data: { [BOARD_OWNER_TYPE]: { projectV2: { id: 'PVT_x' } } } }),
    /no "Status" field/,
  );
});

// board-add.mjs reads Workstream through this same parser, so the non-default
// fieldName path needs its own coverage: without it the parameter is only ever
// exercised on its default and a Workstream failure could name the wrong field.
test('parseSingleSelectField names a non-default field in both fail-loud messages', () => {
  assert.throws(
    () => parseSingleSelectField({ data: { [BOARD_OWNER_TYPE]: { projectV2: {} } } }, 'Workstream'),
    /workstream-field JSON has no project id/,
  );
  assert.throws(
    () => parseSingleSelectField({ data: { [BOARD_OWNER_TYPE]: { projectV2: { id: 'PVT_x' } } } }, 'Workstream'),
    /no "Workstream" field on the project/,
  );
});

test('optionIdFor is case-insensitive and handles multi-word statuses', () => {
  const options = STATUS_FIELD_JSON.data[BOARD_OWNER_TYPE].projectV2.field.options;
  assert.equal(optionIdFor(options, 'Done'), 'opt-done');
  assert.equal(optionIdFor(options, 'done'), 'opt-done');
  assert.equal(optionIdFor(options, 'In review'), 'opt-inreview');
  assert.equal(optionIdFor(options, '  in progress '), 'opt-inprogress');
});

test('optionIdFor throws on an unknown status, naming the valid options', () => {
  const options = STATUS_FIELD_JSON.data[BOARD_OWNER_TYPE].projectV2.field.options;
  assert.throws(() => optionIdFor(options, 'Bogus'), /unknown Status "Bogus".*Done/s);
});

test('lookupIssueBoardItem resolves complete replies and requests the configured issue and field', () => {
  for (const value of [{ name: 'Done' }, null]) {
    const nodes = [
      { id: 'other', isArchived: false, project: { number: BOARD_PROJECT_NUMBER + 1, owner: { login: BOARD_OWNER } }, value: null },
      { id: 'item-a', isArchived: true, project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } }, value },
    ];
    const calls = [];
    const result = lookupIssueBoardItem(453, (args) => {
      calls.push(args);
      return JSON.stringify(issueItemReply(nodes, { issueId: 'I_453' }));
    }, { fieldName: 'Lane' });
    assert.deepEqual(result, { issueId: 'I_453', item: nodes[1] });
    assert.equal(calls.length, 1);
    const query = calls[0][3];
    assert.ok(query.includes(`repository(owner:"${BOARD_OWNER}", name:"${BOARD_REPOSITORY}")`));
    assert.match(query, /issue\(number:453\) \{ id projectItems\(first:20\) \{ totalCount nodes \{ id isArchived project/);
    assert.match(query, /value: fieldValueByName\(name: "Lane"\)/);
  }
  for (const nodes of [[], [{ id: 'other', isArchived: false, project: { number: BOARD_PROJECT_NUMBER + 1, owner: { login: BOARD_OWNER } }, value: null }]]) {
    assert.deepEqual(lookupIssueBoardItem(453, (args) => {
      assert.doesNotMatch(args[3], /fieldValueByName/);
      return issueItemReply(nodes);
    }), { issueId: 'I_fixture', item: null });
  }
});

test('lookupIssueBoardItem matches the configured owner and refuses a project with no owner login', () => {
  const elsewhere = [{ id: 'elsewhere', isArchived: false, project: { number: BOARD_PROJECT_NUMBER, owner: { login: 'someone-else' } }, value: null }];
  assert.deepEqual(lookupIssueBoardItem(453, () => issueItemReply(elsewhere)), { issueId: 'I_fixture', item: null });
  const ownerless = [{ id: 'ownerless', isArchived: false, project: { number: BOARD_PROJECT_NUMBER }, value: null }];
  assert.throws(() => lookupIssueBoardItem(453, () => issueItemReply(ownerless)), /no owner login/);
});

test('moveCards preserves the configured add advice for a complete absent reply', () => {
  assert.throws(() => moveCards([{ issueNumber: 999, statusName: 'Ready' }], (args) =>
    args[3]?.includes('projectV2(number:') ? STATUS_FIELD_JSON : issueItemReply()), (error) => {
    assert.equal(error.cause.message, 'issue #999 is not on the board — add it with Status and Workstream: node scripts/board-add.mjs 999 <Status> <Workstream>');
    return true;
  });
});

test('moveCards refuses a matching item without an id', () => {
  assert.throws(() => moveCards([{ issueNumber: 453, statusName: 'Ready' }], (args) =>
    args[3]?.includes('projectV2(number:') ? STATUS_FIELD_JSON
      : issueItemReply([{ isArchived: false, project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } }, value: null }])), /board item for #453 has no id/);
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

test('parseBatchArgs under linear takes "<ID>:<Status>" pairs and refuses a numeric or lowercase issue', () => {
  assert.deepEqual(parseBatchArgs(['ENG-12:Done', 'FAB-3:In review'], 'Status', 'linear'), [
    { issueNumber: 'ENG-12', statusName: 'Done' },
    { issueNumber: 'FAB-3', statusName: 'In review' },
  ]);
  for (const arg of ['453:Done', 'eng-12:Done', 'ENG-0:Done', 'ENG-12x:Done', 'ENG:Done']) {
    assert.throws(() => parseBatchArgs([arg], 'Status', 'linear'), {
      message: `malformed batch pair "${arg}" — issue must be a Linear issue ID such as ENG-123`,
    }, arg);
  }
  assert.throws(() => parseBatchArgs(['ENG-12:'], 'Status', 'linear'), { message: 'malformed batch pair "ENG-12:" — status must not be empty' });
  assert.throws(() => parseBatchArgs(['ENG-12:Done']), { message: 'malformed batch pair "ENG-12:Done" — issue number must be a positive integer' });
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
      return JSON.stringify(issueItemReply([{
        id: itemIdByIssue[issueNumber],
        isArchived: false,
        project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } },
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

// #464 review: moveCards validates its own inputs — in-process callers hand values
// in directly, and issueNumber is interpolated into the GraphQL query,
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
  const run = spawnSync(process.execPath, [toolkit.script('board-move.mjs'), '--lane', '12:none'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: fakeGh.env({ FAKE_GH_CALLS: callsFile }),
  });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, `board-move: ${NO_PARKED_LANE}\n`);
  assert.equal(readFileSync(callsFile, 'utf8'), '');
});

function outputSink() {
  const sink = { stdout: '', stderr: '' };
  sink.log = (line) => { sink.stdout += `${line}\n`; };
  sink.error = (line) => { sink.stderr += `${line}\n`; };
  return sink;
}

test('board-move single-card form moves the card, prints its line on stdout and returns 0', () => {
  const { exec, calls } = recordingExec({ 453: 'item-453' });
  const sink = outputSink();

  assert.equal(boardMoveMain(['453', 'In', 'progress'], { ghExec: exec, output: sink }), 0);
  assert.equal(sink.stdout, 'board-move: #453 → In progress\n');
  assert.equal(sink.stderr, '');
  const edit = calls.find((args) => args[0] === 'project' && args[1] === 'item-edit');
  assert.ok(edit, 'no item-edit call recorded');
  assert.equal(edit[edit.indexOf('--id') + 1], 'item-453');
  assert.equal(edit[edit.indexOf('--single-select-option-id') + 1], 'opt-inprogress');
});

test('board-move --batch moves every pair, prints one line each on stdout and returns 0', () => {
  const { exec } = recordingExec({ 453: 'item-453', 454: 'item-454' });
  const sink = outputSink();

  assert.equal(boardMoveMain(['--batch', '453:Done', '454:In review'], { ghExec: exec, output: sink }), 0);
  assert.equal(sink.stdout, 'board-move: #453 → Done\nboard-move: #454 → In review\n');
  assert.equal(sink.stderr, '');
});

// Literal, not imported from scripts/board-move.mjs: the printed text is the oracle, so a
// change to any usage line must fail this test.
const USAGE_TEXT = 'usage: node scripts/board-move.mjs <issue#> <Status>   e.g. board-move.mjs 272 Done\n' +
  '       node scripts/board-move.mjs --batch <issue#>:<Status> [...]   e.g. board-move.mjs --batch 453:Done 454:"In review"\n' +
  '       node scripts/board-move.mjs --lane <issue#>:<option|none> [...]   e.g. board-move.mjs --lane 12:none\n' +
  '       on a Linear or Jira board <issue#> is the issue ID   e.g. board-move.mjs ENG-12 Ready\n' +
  '       on an Azure board use AB-<positive int32>   e.g. board-move.mjs AB-299 Ready';

test('board-move rejects bad arguments before any gh call: usage problems return 2 and a malformed batch pair returns 1', () => {
  for (const args of [[], ['abc', 'Done'], ['453'], ['--batch']]) {
    const { exec, calls } = recordingExec({});
    const sink = outputSink();
    assert.equal(boardMoveMain(args, { ghExec: exec, output: sink }), 2, JSON.stringify(args));
    assert.equal(sink.stdout, '');
    assert.equal(sink.stderr, `${USAGE_TEXT}\n`, JSON.stringify(args));
    assert.deepEqual(calls, []);
  }
  const { exec, calls } = recordingExec({});
  const sink = outputSink();
  assert.equal(boardMoveMain(['--batch', 'nonsense'], { ghExec: exec, output: sink }), 1);
  assert.equal(sink.stdout, '');
  assert.equal(sink.stderr, 'board-move: malformed batch pair "nonsense" — expected "<issue#>:<Status>"\n');
  assert.deepEqual(calls, []);
});

test('board-move selects only the configured Project among historical memberships', () => {
  const statusField = structuredClone(STATUS_FIELD_JSON);
  statusField.data[BOARD_OWNER_TYPE].projectV2.id = 'PVT_configured_project';
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    if (args[0] !== 'api') return '';
    if (args[3].includes('projectV2(number:')) return JSON.stringify(statusField);
    return JSON.stringify(issueItemReply([
      { id: 'historical-item', isArchived: true, project: { number: BOARD_PROJECT_NUMBER, owner: { login: 'someone-else' } }, value: { name: 'Done' } },
      { id: 'configured-item', isArchived: false, project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } }, value: { name: 'Ready' } },
    ]));
  };
  const sink = outputSink();
  assert.equal(boardMoveMain(['999', 'Done'], { ghExec: exec, output: sink }), 0);
  assert.equal(sink.stdout, 'board-move: #999 → Done\n');
  assert.equal(sink.stderr, '');
  assert.deepEqual(calls.filter((args) => args[0] === 'project'), [[
    'project', 'item-edit', '--id', 'configured-item', '--project-id', 'PVT_configured_project',
    '--field-id', 'PVTSSF_status', '--single-select-option-id', 'opt-done',
  ]]);
});

test('board-move refuses incomplete issue-item replies with their cause and no write', () => {
  const missingNodes = issueItemReply();
  delete missingNodes.data.repository.issue.projectItems.nodes;
  const missingCount = issueItemReply();
  delete missingCount.data.repository.issue.projectItems.totalCount;
  const unreadableIssue = issueItemReply();
  unreadableIssue.data.repository.issue = null;
  const cases = [
    [issueItemReply([{ id: 'other', isArchived: false, project: { number: 99, owner: { login: BOARD_OWNER } } }], { totalCount: 21 }), /has 21 project items but only 1 fetched/],
    [missingCount, /no non-negative integer projectItems\.totalCount/],
    [unreadableIssue, /no readable issue/],
    ['not json at all', /not valid JSON/],
    [issueItemReply([{ id: 'bad', isArchived: false, project: null }]), /non-integer project number/],
    [issueItemReply([{ id: 'bad', project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } } }]), /non-boolean isArchived/],
    [issueItemReply([
      { id: 'one', isArchived: false, project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } } },
      { id: 'two', isArchived: false, project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } } },
    ]), /has 2 items on project .*; expected at most one/],
    [issueItemReply([
      { id: 'configured', isArchived: false, project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } } },
      { id: 'ownerless', isArchived: false, project: { number: BOARD_PROJECT_NUMBER } },
    ]), /no owner login/],
    [missingNodes, /no projectItems\.nodes\[\] array/],
  ];
  for (const [reply, expected] of cases) {
    const calls = [];
    const exec = (args) => {
      calls.push(args);
      return args[3]?.includes('projectV2(number:') ? JSON.stringify(STATUS_FIELD_JSON) : typeof reply === 'string' ? reply : JSON.stringify(reply);
    };
    assert.throws(() => moveCards([{ issueNumber: 999, statusName: 'Ready' }], exec), (error) => {
      assert.match(error.cause.message, expected);
      assert.doesNotMatch(error.message, /is not on the board/);
      return true;
    });
    const sink = outputSink();
    assert.equal(boardMoveMain(['999', 'Ready'], { ghExec: exec, output: sink }), 1);
    assert.match(sink.stderr, expected);
    assert.doesNotMatch(sink.stderr, /is not on the board/);
    assert.equal(calls.some((args) => args[0] === 'project'), false);
  }
});
