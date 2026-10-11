import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_OWNER, BOARD_REPOSITORY } from './board-config.mjs';
import { issueNodeIdQuery, parseIssueNodeId, addIssueToBoard } from './board-add.mjs';
import { main as boardAddMain } from '../board-add.mjs';

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
  return { data: { user: { projectV2: { id: PROJECT_ID, field: { id: fieldId, options } } } } };
}

function projectItemFieldsJson(status, workstream) {
  const values = [
    ...(status == null ? [] : [{ name: status, field: { name: 'Status' } }]),
    ...(workstream == null ? [] : [{ name: workstream, field: { name: 'Workstream' } }]),
  ];
  return { data: { node: { fieldValues: { totalCount: values.length, nodes: values } } } };
}

// Records every exec() call so the exact call sequence can be asserted. `failOn` is
// a substring of the query that should blow up (simulating a gh failure mid-run);
// `nodeIdJson` / `addJson` override the two fail-loud parse points, and
// `itemFieldsJson` supplies the post-failure field re-read.
function recordingExec({ itemId = 'PVTI_item543', failOn = null, nodeIdJson, addJson, itemFieldsJson } = {}) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    const query = args[3];
    if (failOn && query.includes(failOn)) throw new Error('gh: GraphQL mutation rejected');
    if (query.includes('issue(number:')) {
      return JSON.stringify(nodeIdJson ?? { data: { repository: { issue: { id: ISSUE_NODE_ID } } } });
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

test('issueNodeIdQuery asks for the issue node id on the right repository', () => {
  const query = issueNodeIdQuery(543);
  assert.match(query, new RegExp(`repository\\(owner:"${BOARD_OWNER}", name:"${BOARD_REPOSITORY}"\\)`));
  assert.match(query, /issue\(number:543\) \{ id \}/);
});

test('parseIssueNodeId returns the id and throws (fail-loud) on a missing or empty one', () => {
  assert.equal(parseIssueNodeId({ data: { repository: { issue: { id: ISSUE_NODE_ID } } } }, 543), ISSUE_NODE_ID);
  assert.throws(() => parseIssueNodeId({ data: { repository: { issue: null } } }, 543), /no node id for issue #543/);
  assert.throws(() => parseIssueNodeId({ data: { repository: { issue: { id: '' } } } }, 543), /no node id for issue #543/);
});

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
  assert.match(calls[0][3], /issue\(number:543\) \{ id \}/);
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
  const { exec, calls } = recordingExec({ itemId: 'PVTI_alreadythere' });
  const result = addIssueToBoard(
    { issueNumber: 543, statusName: 'In progress', workstreamName: 'Platform' },
    exec,
  );

  assert.equal(result.itemId, 'PVTI_alreadythere');
  assert.equal(calls.length, 6);
  const updates = calls.filter((c) => c[3].includes('updateProjectV2ItemFieldValue'));
  assert.equal(updates.length, 2);
  assert.match(updates[0][3], /itemId:"PVTI_alreadythere".*singleSelectOptionId:"opt-inprogress"/s);
  assert.match(updates[1][3], /itemId:"PVTI_alreadythere".*singleSelectOptionId:"ws-platform"/s);
});

test('addIssueToBoard throws (fail-loud) on a malformed issue-node-id response, before adding anything', () => {
  const { exec, calls } = recordingExec({ nodeIdJson: { data: { repository: { issue: {} } } } });
  assert.throws(
    () => addIssueToBoard({ issueNumber: 543, statusName: 'Ready', workstreamName: 'Platform' }, exec),
    /no node id for issue #543/,
  );
  assert.equal(ran(calls, 'addProjectV2ItemById'), false, 'added a card despite an unresolved issue');
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
