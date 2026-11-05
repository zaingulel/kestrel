import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GITHUB_TEST_CONFIG, NEEDS_PARSER, copyToolkit, flagLiterals } from './board-toolkit-copy.mjs';

const toolkit = copyToolkit(GITHUB_TEST_CONFIG);
after(() => toolkit.cleanup());

const { BOARD_OWNER, BOARD_OWNER_TYPE, BOARD_PROJECT_NUMBER } = await toolkit.load('lib/board-config.mjs');
const { addIssueToBoard } = await toolkit.load('lib/board-add.mjs');
const { issueItemReply } = await toolkit.load('lib/board-fixtures.mjs');
const { main: boardAddMain, BOARD_ADD_HELP } = await toolkit.load('board-add.mjs');

// Shapes mirror the real `gh api graphql` payloads for project 2. Expected ids are
// independent literals, never re-derived from the production code.
const PROJECT_ID = 'PVT_kwHOA50uGs4BcfoO';
const ISSUE_NODE_ID = 'I_kwDOissue543';
const STATUS_OPTIONS = [
  { id: 'opt-backlog', name: 'Backlog' },
  { id: 'opt-ready', name: 'Ready' },
  { id: 'opt-inprogress', name: 'In progress' },
  { id: 'opt-inreview', name: 'In review' },
  { id: 'opt-done', name: 'Done' },
];
const WORKSTREAM_OPTIONS = [
  { id: 'ws-platform', name: 'Platform' },
  { id: 'ws-selfimprovement', name: 'Self-improvement loop' },
  { id: 'ws-product', name: 'Product' },
];

function fieldJson(fieldId, options) {
  return { data: { [BOARD_OWNER_TYPE]: { projectV2: { id: PROJECT_ID, field: { id: fieldId, options } } } } };
}

function projectItemFieldsJson(status, workstream) {
  const values = [
    ...(status == null ? [] : [{ name: status, field: { name: 'Status' } }]),
    ...(workstream == null ? [] : [{ name: workstream, field: { name: 'Workstream' } }]),
  ];
  return { data: { node: { fieldValues: { totalCount: values.length, nodes: values } } } };
}

// Records every exec() call so the exact call sequence can be asserted. `failOn` is
// a substring of the query that should blow up (simulating a gh failure mid-run) and
// `failMessage` the message it throws; `nodeIdJson` / `addJson` override the two
// fail-loud parse points, and `itemFieldsJson` supplies the post-failure field re-read.
function recordingExec({
  itemId = 'PVTI_item543',
  failOn = null,
  failMessage = 'gh: GraphQL mutation rejected',
  nodeIdJson,
  addJson,
  itemFieldsJson,
} = {}) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    const query = args[3];
    if (failOn && query.includes(failOn)) throw new Error(failMessage);
    if (query.includes('issue(number:')) {
      return JSON.stringify(nodeIdJson ?? issueItemReply([], { issueId: ISSUE_NODE_ID }));
    }
    if (query.includes('field(name:"Status")')) return JSON.stringify(fieldJson('PVTSSF_status', STATUS_OPTIONS));
    if (query.includes('field(name:"Workstream")')) {
      return JSON.stringify(fieldJson('PVTSSF_workstream', WORKSTREAM_OPTIONS));
    }
    if (query.includes('addProjectV2ItemById')) {
      return JSON.stringify(addJson ?? { data: { addProjectV2ItemById: { item: { id: itemId } } } });
    }
    if (query.includes('node(id:')) {
      if (itemFieldsJson === undefined) throw new Error('unexpected exec call: itemFieldsJson is not configured');
      return JSON.stringify(itemFieldsJson);
    }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      return JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } } });
    }
    throw new Error(`unexpected exec call: ${query}`);
  };
  return { exec, calls };
}

const ran = (calls, needle) => calls.some((c) => c[3].includes(needle));

// The whole point of the seam: a card must never land on the board unfielded (the
// #357-#361 drift), so BOTH updateProjectV2ItemFieldValue mutations must fire.
test('addIssueToBoard adds the card and sets BOTH Status and Workstream, in that call order', () => {
  const { exec, calls } = recordingExec();
  const result = addIssueToBoard(
    { issueNumber: 543, statusName: 'Ready', workstreamName: 'Self-improvement loop' },
    exec,
  );

  assert.deepEqual(result, {
    issueNumber: 543,
    itemId: 'PVTI_item543',
    statusName: 'Ready',
    workstreamName: 'Self-improvement loop',
  });
  assert.equal(calls.length, 6);
  for (const call of calls) assert.deepEqual(call.slice(0, 3), ['api', 'graphql', '-f']);
  assert.match(calls[0][3], /issue\(number:543\) \{ id projectItems/);
  assert.match(calls[1][3], /field\(name:"Status"\)/);
  assert.match(calls[2][3], /field\(name:"Workstream"\)/);
  assert.match(calls[3][3], /addProjectV2ItemById/);
  assert.match(calls[3][3], new RegExp(`projectId:"${PROJECT_ID}"`));
  assert.match(calls[3][3], new RegExp(`contentId:"${ISSUE_NODE_ID}"`));
  // Both field values, with the option ids resolved from the two field reads.
  assert.match(calls[4][3], /updateProjectV2ItemFieldValue/);
  assert.match(calls[4][3], /itemId:"PVTI_item543".*fieldId:"PVTSSF_status".*singleSelectOptionId:"opt-ready"/s);
  assert.match(calls[5][3], /updateProjectV2ItemFieldValue/);
  assert.match(
    calls[5][3],
    /itemId:"PVTI_item543".*fieldId:"PVTSSF_workstream".*singleSelectOptionId:"ws-selfimprovement"/s,
  );
});

// addProjectV2ItemById returns the EXISTING item for an issue already on the board,
// so a re-run must still set both fields rather than skip them.
test('addIssueToBoard is idempotent: an issue already on the board still gets both fields set', () => {
  const { exec, calls } = recordingExec({ itemId: 'PVTI_alreadythere', nodeIdJson: issueItemReply([{ id: 'PVTI_read', isArchived: false, project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } }, value: null }], { issueId: ISSUE_NODE_ID }) });
  const result = addIssueToBoard(
    { issueNumber: 543, statusName: 'In progress', workstreamName: 'Platform' },
    exec,
  );

  assert.equal(result.itemId, 'PVTI_alreadythere');
  assert.equal(calls.length, 6);
  assert.equal(calls.filter((call) => call[3].includes('addProjectV2ItemById')).length, 1);
  const updates = calls.filter((c) => c[3].includes('updateProjectV2ItemFieldValue'));
  assert.equal(updates.length, 2);
  assert.match(updates[0][3], /itemId:"PVTI_alreadythere".*singleSelectOptionId:"opt-inprogress"/s);
  assert.match(updates[1][3], /itemId:"PVTI_alreadythere".*singleSelectOptionId:"ws-platform"/s);
});

// The board's auto-add can add the issue between our lookup and our add, and GitHub then
// rejects the add with "Content already exists in this project" instead of returning
// the existing item: the item is on the board, so read it back and set its fields.
const RACE_ERROR = 'gh: Content already exists in this project';

function raceItem(id, isArchived) {
  return { id, isArchived, project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } }, value: null };
}

test("addIssueToBoard recovers the item when the board's auto-add already added the issue", () => {
  const { exec, calls } = recordingExec({
    failOn: 'addProjectV2ItemById',
    failMessage: RACE_ERROR,
    nodeIdJson: issueItemReply([raceItem('PVTI_raced', false)], { issueId: ISSUE_NODE_ID }),
  });
  const result = addIssueToBoard({ issueNumber: 543, statusName: 'Ready', workstreamName: 'Platform' }, exec);

  assert.equal(result.itemId, 'PVTI_raced');
  assert.equal(calls.filter((call) => call[3].includes('issue(number:543)')).length, 2);
  assert.equal(calls.filter((call) => call[3].includes('addProjectV2ItemById')).length, 1);
  const updates = calls.filter((call) => call[3].includes('updateProjectV2ItemFieldValue'));
  assert.equal(updates.length, 2);
  assert.match(updates[0][3], /itemId:"PVTI_raced".*singleSelectOptionId:"opt-ready"/s);
  assert.match(updates[1][3], /itemId:"PVTI_raced".*singleSelectOptionId:"ws-platform"/s);
});

test('addIssueToBoard fails loudly when GitHub says the item exists but the re-read finds none', () => {
  const { exec, calls } = recordingExec({
    failOn: 'addProjectV2ItemById',
    failMessage: RACE_ERROR,
    nodeIdJson: issueItemReply([], { issueId: ISSUE_NODE_ID }),
  });
  assert.throws(
    () => addIssueToBoard({ issueNumber: 543, statusName: 'Ready', workstreamName: 'Platform' }, exec),
    (error) => {
      assert.match(error.message, /#543/);
      assert.match(error.message, /Content already exists in this project/);
      assert.match(error.message, /re-read found no item/);
      return true;
    },
  );
  assert.equal(ran(calls, 'updateProjectV2ItemFieldValue'), false, 'updated a field with no item');
});

test('addIssueToBoard fails loudly when the re-read finds the item archived', () => {
  const { exec, calls } = recordingExec({
    failOn: 'addProjectV2ItemById',
    failMessage: RACE_ERROR,
    nodeIdJson: issueItemReply([raceItem('PVTI_archived', true)], { issueId: ISSUE_NODE_ID }),
  });
  assert.throws(
    () => addIssueToBoard({ issueNumber: 543, statusName: 'Ready', workstreamName: 'Platform' }, exec),
    (error) => {
      assert.match(error.message, /PVTI_archived/);
      assert.match(error.message, /archived item PVTI_archived/);
      assert.match(error.message, /unarchive it/);
      return true;
    },
  );
  assert.equal(ran(calls, 'updateProjectV2ItemFieldValue'), false, 'updated a field on an archived item');
});

test('addIssueToBoard rethrows any other add-item error unchanged', () => {
  const { exec, calls } = recordingExec({ failOn: 'addProjectV2ItemById' });
  assert.throws(
    () => addIssueToBoard({ issueNumber: 543, statusName: 'Ready', workstreamName: 'Platform' }, exec),
    /gh: GraphQL mutation rejected/,
  );
  assert.equal(calls.filter((call) => call[3].includes('issue(number:543)')).length, 1);
  assert.equal(ran(calls, 'updateProjectV2ItemFieldValue'), false, 'updated a field after a rejected add');
});

test('addIssueToBoard rejects a missing issue node id before mutation', () => {
  const unreadableIssue = issueItemReply();
  unreadableIssue.data.repository.issue = null;
  const missingId = issueItemReply();
  delete missingId.data.repository.issue.id;
  for (const [reply, expected] of [
    [unreadableIssue, /no readable issue/],
    [missingId, /no node id for issue #543/],
    [issueItemReply([], { issueId: '' }), /no node id for issue #543/],
    [issueItemReply([], { issueId: null }), /no node id for issue #543/],
  ]) {
    const { exec, calls } = recordingExec({ nodeIdJson: reply });
    assert.throws(() => addIssueToBoard({ issueNumber: 543, statusName: 'Ready', workstreamName: 'Platform' }, exec), expected);
    assert.equal(ran(calls, 'addProjectV2ItemById'), false);
    assert.equal(ran(calls, 'updateProjectV2ItemFieldValue'), false);
  }
});

test('addIssueToBoard throws (fail-loud) on a malformed add-item response, before any field update', () => {
  const { exec, calls } = recordingExec({ addJson: { data: { addProjectV2ItemById: { item: {} } } } });
  assert.throws(
    () => addIssueToBoard({ issueNumber: 543, statusName: 'Ready', workstreamName: 'Platform' }, exec),
    /add-item response has no item id for issue #543/,
  );
  assert.equal(ran(calls, 'updateProjectV2ItemFieldValue'), false, 'updated a field with no item id');
});

test('board-add reports authoritative outcomes after an unknown field mutation result', () => {
  // These two observed states are the #801 acceptance oracle: a lost response can
  // follow a landed mutation, whereas a rejected mutation leaves it unset.
  for (const { name, remoteFields, expectedOutcome } of [
    {
      name: 'landed before its response was lost',
      remoteFields: projectItemFieldsJson('Ready', null),
      expectedOutcome: /observed Status = Ready, Workstream is unset/,
    },
    {
      name: 'rejected by GitHub',
      remoteFields: projectItemFieldsJson(null, null),
      expectedOutcome: /observed Status is unset, Workstream is unset/,
    },
  ]) {
    const { exec, calls } = recordingExec({
      failOn: 'fieldId:"PVTSSF_status"',
      itemFieldsJson: remoteFields,
    });
    const errors = [];

    const code = boardAddMain(['543', 'Ready', 'Platform'], {
      output: { log: () => {}, error: (message) => errors.push(message) },
      ghExec: exec,
    });

    assert.equal(code, 1, name);
    assert.equal(errors.length, 1, name);
    assert.match(errors[0], expectedOutcome, name);
    assert.match(errors[0], /safely re-run the whole command: node scripts\/board-add\.mjs 543 'Ready' 'Platform'/, name);
    assert.equal(calls.filter((call) => call[3].includes('node(id:')).length, 1, name);
    assert.equal(calls.filter((call) => call[3].includes('fieldId:"PVTSSF_workstream"')).length, 0, name);
  }

  const multiWord = recordingExec({
    failOn: 'fieldId:"PVTSSF_status"',
    itemFieldsJson: projectItemFieldsJson(null, null),
  });
  const multiWordErrors = [];
  const multiWordCode = boardAddMain(['543', 'In review', 'Self-improvement loop'], {
    output: { log: () => {}, error: (message) => multiWordErrors.push(message) },
    ghExec: multiWord.exec,
  });
  assert.equal(multiWordCode, 1);
  assert.match(
    multiWordErrors[0],
    /node scripts\/board-add\.mjs 543 'In review' 'Self-improvement loop'/,
    'the printed recovery command must preserve each multi-word value as one shell argument',
  );

  for (const { name, remoteFields } of [
    {
      name: 'partial GraphQL data with resolver errors',
      remoteFields: {
        data: { node: { fieldValues: { totalCount: 0, nodes: [] } } },
        errors: [{ message: 'field resolver failed' }],
      },
    },
    {
      name: 'missing selected-option name',
      remoteFields: {
        data: { node: { fieldValues: { totalCount: 1, nodes: [{ field: { name: 'Status' } }] } } },
      },
    },
    {
      name: 'duplicate conflicting Status values',
      remoteFields: {
        data: { node: { fieldValues: { totalCount: 2, nodes: [
          { name: 'Ready', field: { name: 'Status' } },
          { name: 'In progress', field: { name: 'Status' } },
        ] } } },
      },
    },
  ]) {
    const malformed = recordingExec({
      failOn: 'fieldId:"PVTSSF_status"',
      itemFieldsJson: remoteFields,
    });
    const malformedErrors = [];
    const malformedCode = boardAddMain(['543', 'Ready', 'Platform'], {
      output: { log: () => {}, error: (message) => malformedErrors.push(message) },
      ghExec: malformed.exec,
    });
    assert.equal(malformedCode, 1, name);
    assert.match(malformedErrors[0], /update outcome is unknown/, name);
    assert.match(malformedErrors[0], /re-read failed/, name);
    assert.doesNotMatch(malformedErrors[0], /observed Status is unset/, name);
  }
});

test('addIssueToBoard throws on an unknown Status or Workstream name, listing the valid options', () => {
  const bad = recordingExec();
  assert.throws(
    () => addIssueToBoard({ issueNumber: 543, statusName: 'Bogus', workstreamName: 'Platform' }, bad.exec),
    // Assert the field label, not just the value: both fields resolve through the shared
    // optionIdFor, so a wrong label here would send the reader to the wrong field — the
    // same defect the Workstream half below is written to catch.
    /unknown Status "Bogus".*Ready, In progress/s,
  );
  const badWorkstream = recordingExec();
  assert.throws(
    () => addIssueToBoard({ issueNumber: 543, statusName: 'Ready', workstreamName: 'Nope' }, badWorkstream.exec),
    // The message must name Workstream, not Status: both fields resolve through the
    // shared optionIdFor, and a Workstream typo labelled "unknown Status" sends the
    // reader to the wrong field.
    /unknown Workstream "Nope".*Platform, Self-improvement loop/s,
  );
  // Neither typo may leave a card behind: the add mutation never ran.
  assert.equal(ran(bad.calls, 'addProjectV2ItemById'), false, 'added a card for an unknown Status');
  assert.equal(ran(badWorkstream.calls, 'addProjectV2ItemById'), false, 'added a card for an unknown Workstream');
});

// issueNumber is interpolated into the GraphQL query string, so an unvalidated value
// must fail before anything is sent — the same precedent moveCards sets.
test('addIssueToBoard rejects a non-positive or non-integer issue number before any exec call', () => {
  for (const issueNumber of ['543; }', 0, -1, 1.5, NaN, undefined]) {
    const { exec, calls } = recordingExec();
    assert.throws(
      () => addIssueToBoard({ issueNumber, statusName: 'Ready', workstreamName: 'Platform' }, exec),
      /invalid issue number/,
    );
    assert.equal(calls.length, 0, `exec ran for issue number ${JSON.stringify(issueNumber)}`);
  }
  // Both name guards are covered, not just one. They are not redundant with optionIdFor:
  // a blank or non-string name is a caller bug and gets a distinct message, where an
  // unrecognised name is a typo and gets the valid-options list instead.
  for (const [statusName, workstreamName, expected, label] of [
    ['  ', 'Platform', /invalid status name/, 'an empty status name'],
    [undefined, 'Platform', /invalid status name/, 'a missing status name'],
    ['Ready', '  ', /invalid workstream name/, 'an empty workstream name'],
    ['Ready', undefined, /invalid workstream name/, 'a missing workstream name'],
  ]) {
    const { exec, calls } = recordingExec();
    assert.throws(() => addIssueToBoard({ issueNumber: 543, statusName, workstreamName }, exec), expected);
    assert.equal(calls.length, 0, `exec ran for ${label}`);
  }
});

// The CLI edge is thin, but it owns the argument contract and the two report lines, and
// nothing else covers them — the sibling verify-issue-publish edge is tested the same way.
test('board-add CLI reports both fields on success and drives the injected executor', () => {
  const { exec, calls } = recordingExec();
  const logs = [];
  const errors = [];

  const code = boardAddMain(['543', 'In progress', 'Platform'], {
    output: { log: (m) => logs.push(m), error: (m) => errors.push(m) },
    ghExec: exec,
  });

  assert.equal(code, 0);
  assert.deepEqual(logs, [
    'board-add: #543 on the board (item PVTI_item543)',
    'board-add: Status = In progress, Workstream = Platform',
  ]);
  assert.equal(errors.length, 0);
  assert.equal(calls.length, 6, 'the CLI must drive the injected executor, not a real gh');
});

test('board-add CLI fails loud on a wrong argument count, without calling GitHub', () => {
  for (const badArgs of [[], ['543'], ['543', 'In progress'], ['543', 'In progress', 'Platform', 'extra']]) {
    const errors = [];
    let called = 0;
    const code = boardAddMain(badArgs, {
      output: { log: () => {}, error: (m) => errors.push(m) },
      ghExec: () => { called += 1; return ''; },
    });
    assert.equal(code, 1, `exit code for ${JSON.stringify(badArgs)}`);
    assert.match(errors[0], /usage: node scripts\/board-add\.mjs <issue#> <Status> <Workstream>/);
    assert.equal(called, 0, `GitHub was called for ${JSON.stringify(badArgs)}`);
  }
});

// Literal: the printed help is the oracle for what an agent reads.
const ADD_USAGE_TEXT = 'usage: node scripts/board-add.mjs <issue#> <Status> <Workstream>\n' +
  '       node scripts/board-add.mjs --help   prints the modes, with no board read';
const ADD_HELP_TEXT = `${ADD_USAGE_TEXT}

  <issue#> <Status> <Workstream>   put the issue on the board with its Status and Workstream set
  --help                           this text, with no board read

It files cards on a GitHub board only; the markdown, Linear, Jira and Azure trackers refuse it.`;

test('board-add --help prints the help on stdout and returns 0 before any gh call', () => {
  let called = 0;
  const logs = [];
  const errors = [];
  const output = { log: (m) => logs.push(m), error: (m) => errors.push(m) };
  const ghExec = () => { called += 1; return ''; };
  assert.equal(boardAddMain(['--help'], { output, ghExec }), 0);
  assert.deepEqual(logs, [ADD_HELP_TEXT]);
  assert.deepEqual(errors, []);
  for (const args of [['--help', '543'], ['543', 'Ready', 'Platform', '--help']]) {
    errors.length = 0;
    assert.equal(boardAddMain(args, { output, ghExec }), 1, JSON.stringify(args));
    assert.deepEqual(errors, [`board-add: ${ADD_USAGE_TEXT}`], JSON.stringify(args));
  }
  assert.equal(called, 0);
});

// The help is the one place an agent learns the argument form, so it must name exactly what the
// command accepts. The flags are read from the real source through a parser.
test('BOARD_ADD_HELP names exactly the modes and arguments board-add accepts', NEEDS_PARSER, () => {
  const accepted = flagLiterals(fileURLToPath(new URL('../board-add.mjs', import.meta.url)));
  assert.deepEqual([...new Set(BOARD_ADD_HELP.match(/--[a-z][a-z-]*=?/g))].sort(), accepted);
});

// The help's form line is driven through main, so a form that gains or loses an argument without its
// help changing fails.
test('the BOARD_ADD_HELP form line runs as written and is a usage error with one argument fewer or more', () => {
  const formLines = BOARD_ADD_HELP.split('\n').filter((line) => line.startsWith('  <issue#>'));
  assert.equal(formLines.length, 1, 'the help has no argument form line');
  const placeholders = { '<issue#>': '543', '<Status>': 'In progress', '<Workstream>': 'Platform' };
  const args = formLines[0].trim().split(/ {2,}/)[0].split(' ').map((token) => placeholders[token]);
  assert.ok(args.every((arg) => arg !== undefined), formLines[0]);

  const run = (given) => {
    const { exec, calls } = recordingExec();
    const errors = [];
    const code = boardAddMain(given, { output: { log: () => {}, error: (m) => errors.push(m) }, ghExec: exec });
    return { code, errors, calls };
  };
  const full = run(args);
  assert.equal(full.code, 0, full.errors.join('\n'));
  assert.equal(full.calls.length, 6);
  for (const given of [args.slice(0, -1), [...args, 'extra']]) {
    const refused = run(given);
    assert.equal(refused.code, 1, JSON.stringify(given));
    assert.deepEqual(refused.errors, [`board-add: ${ADD_USAGE_TEXT}`], JSON.stringify(given));
    assert.deepEqual(refused.calls, [], JSON.stringify(given));
  }
});

// Number('not-a-number') is NaN, which must be rejected by addIssueToBoard's guard
// rather than interpolated into a GraphQL query string.
test('board-add CLI rejects a non-numeric issue number before calling GitHub', () => {
  const errors = [];
  let called = 0;
  const code = boardAddMain(['not-a-number', 'In progress', 'Platform'], {
    output: { log: () => {}, error: (m) => errors.push(m) },
    ghExec: () => { called += 1; return ''; },
  });
  assert.equal(code, 1);
  assert.match(errors[0], /invalid issue number/);
  assert.equal(called, 0, 'GitHub was called for a non-numeric issue number');
});

test('board-add refuses incomplete issue-item replies before mutation', () => {
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
    [missingNodes, /no projectItems\.nodes\[\] array/],
  ];
  for (const [reply, expected] of cases) {
    const base = recordingExec();
    const calls = [];
    const exec = (args) => {
      calls.push(args);
      return args[3].includes('issue(number:') ? typeof reply === 'string' ? reply : JSON.stringify(reply) : base.exec(args);
    };
    const errors = [];
    assert.equal(boardAddMain(['999', 'Ready', 'Platform'], { ghExec: exec, output: { log: () => {}, error: (message) => errors.push(message) } }), 1);
    assert.match(errors.join('\n'), expected);
    assert.equal(ran(calls, 'addProjectV2ItemById'), false);
    assert.equal(ran(calls, 'updateProjectV2ItemFieldValue'), false);
  }
});
