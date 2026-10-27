// issue-publish.test.mjs — mutation-proof contract tests for issue publication.
// Run: node --test scripts/lib/issue-publish.test.mjs

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { installFakeGh } from './fake-gh.mjs';
import { GITHUB_TEST_CONFIG, LINEAR_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';

const toolkit = copyToolkit(GITHUB_TEST_CONFIG);
after(() => toolkit.cleanup());

const { BOARD_OWNER, BOARD_PROJECT_NUMBER, BOARD_REPOSITORY, KIND_LABELS } = await toolkit.load('lib/board-config.mjs');
const { fetchBoard } = await toolkit.load('lib/board.mjs');
const { leanBoardPage, leanNode, issueItemReply } = await toolkit.load('lib/board-fixtures.mjs');
const {
  boardCardsByNumber,
  parseIssuePublishArgs,
  verifyIssuePublication,
} = await toolkit.load('lib/issue-publish.mjs');
const { main } = await toolkit.load('verify-issue-publish.mjs');

const linearToolkit = copyToolkit(LINEAR_TEST_CONFIG);
after(() => linearToolkit.cleanup());
const { main: linearMain } = await linearToolkit.load('verify-issue-publish.mjs');
const { verifyLinearPublication } = await linearToolkit.load('lib/issue-publish.mjs');

const BOARD = [
  { content: { number: 475 }, status: 'Ready', routing: 'Platform', labels: [KIND_LABELS.epic, 'area:board'] },
  { content: { number: 476 }, status: 'Ready', routing: 'Product', labels: [KIND_LABELS.task, 'area:board'] },
  { content: { number: 477 }, status: 'Backlog', routing: 'Go-to-market', labels: ['area:board', KIND_LABELS.bug] },
];

// `totalCount` defaults to the returned numbers so a fixture is complete unless a
// test deliberately makes it truncated.
function graphChildren(numbers, totalCount = numbers.length) {
  return JSON.stringify({
    data: {
      repository: {
        issue: { subIssues: { totalCount, nodes: numbers.map((number) => ({ number })) } },
      },
    },
  });
}

// The projects the ISSUE side reports an item on. The absence path probes that side before
// it claims anything, so every stub has to answer the probe as well as the children query.
function graphProbe(projectNumbers = [], totalCount = projectNumbers.length) {
  return JSON.stringify(issueItemReply(projectNumbers.map((number, i) => ({
    id: `item-${i}`, isArchived: false, project: { number, owner: { login: BOARD_OWNER } }, value: null,
  })), { totalCount }));
}

function verify(args, { board = BOARD, graph = graphChildren([476, 477]) } = {}) {
  const calls = [];
  const ghExec = (command) => {
    calls.push(['ghExec', command]);
    const query = command.find((arg) => arg.startsWith('query='));
    return query.includes('projectItems') ? graphProbe() : graph;
  };
  const report = verifyIssuePublication(args, {
    fetchBoard: (receivedGhExec) => {
      calls.push(['fetchBoard', receivedGhExec]);
      return board;
    },
    ghExec,
  });
  return { report, calls, ghExec };
}

test('parseIssuePublishArgs under linear takes Linear issue IDs and refuses numbers and duplicates', () => {
  assert.deepEqual(parseIssuePublishArgs(['ENG-1', 'ENG-10', 'FAB-2'], 'linear'), { subjectNumber: 'ENG-1', childNumbers: ['ENG-10', 'FAB-2'] });
  assert.deepEqual(parseIssuePublishArgs(['ENG-7'], 'linear'), { subjectNumber: 'ENG-7', childNumbers: [] });
  for (const args of [['7'], ['ENG-1', '8'], ['eng-1'], ['ENG-0'], ['ENG-1x']]) {
    assert.throws(() => parseIssuePublishArgs(args, 'linear'), { message: /^expected a Linear issue ID such as ENG-123, received "/ }, JSON.stringify(args));
  }
  assert.throws(() => parseIssuePublishArgs(['ENG-1', 'ENG-2', 'ENG-1'], 'linear'), { message: 'duplicate issue ID ENG-1' });
  assert.throws(() => parseIssuePublishArgs(['ENG-1']), { message: 'expected a positive issue number, received "ENG-1"' });
});

// The Linear-tracked copy runs the check through its CLI with a fake executor that answers as Linear would:
// `issues` leaves archived issues out unless `includeArchived: true`, so the board read never holds an archived
// card, and `Issue.archivedAt` is null for an issue that is not archived.
const linearState = (id, name, type) => ({ id, name, type });
const LINEAR_TODO = linearState('s-todo', 'Todo', 'unstarted');
const LINEAR_TEAM = {
  teams: {
    nodes: [{
      id: 'team-eng',
      key: 'ENG',
      states: {
        nodes: [
          linearState('s-backlog', 'Backlog', 'backlog'), LINEAR_TODO, linearState('s-progress', 'In Progress', 'started'),
          linearState('s-awaiting', 'Awaiting Push', 'started'), linearState('s-review', 'In Review', 'started'),
          linearState('s-done', 'Done', 'completed'), linearState('s-triage', 'Triage', 'triage'),
        ],
        pageInfo: { hasNextPage: false },
      },
      gitAutomationStates: {
        nodes: [
          { event: 'draft', state: null, targetBranch: null },
          { event: 'start', state: { id: 's-review' }, targetBranch: null },
          { event: 'merge', state: { id: 's-done' }, targetBranch: null },
        ],
        pageInfo: { hasNextPage: false },
      },
    }],
  },
};
const linearList = (nodes, pageInfo = { hasNextPage: false }) => ({ nodes, pageInfo });
const linearIssue = (identifier, issueState, labels) => ({
  id: `id-${identifier}`, identifier, title: identifier, state: issueState, assignee: null,
  labels: linearList(labels.map((name) => ({ name }))), inverseRelations: linearList([]), attachments: linearList([]),
});

// The epic ENG-1 with the active child ENG-3 and the child ENG-2, closed and archived, which the board read lacks.
function linearPublication({ active = [linearIssue('ENG-1', LINEAR_TODO, [KIND_LABELS.epic]), linearIssue('ENG-3', LINEAR_TODO, [KIND_LABELS.task, 'area:board'])], direct = {} } = {}) {
  const children = [{ identifier: 'ENG-3', archived: false }, { identifier: 'ENG-2', archived: true }];
  const directReads = {
    'ENG-2': { identifier: 'ENG-2', team: { key: 'ENG' }, archivedAt: '2026-01-05T00:00:00.000Z', state: { type: 'completed' }, labels: linearList([{ name: KIND_LABELS.bug }]) },
    ...direct,
  };
  const calls = [];
  const exec = (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('teams(')) return LINEAR_TEAM;
    if (query.includes('filter: { parent:')) return { issues: linearList([]) };
    if (query.includes('issues(')) return { issues: linearList(active) };
    if (query.includes('children(')) {
      assert.equal(variables.id, 'ENG-1');
      const archivedIncluded = query.includes('includeArchived: true');
      return { issue: { children: linearList(children.filter((child) => archivedIncluded || !child.archived).map(({ identifier }) => ({ identifier }))) } };
    }
    if (query.includes('archivedAt')) return { issue: directReads[variables.id] };
    throw new Error(`unanticipated Linear request: ${query}`);
  };
  return { exec, calls };
}

function runLinearCheck(args, fixture) {
  const stdout = [];
  const stderr = [];
  const status = linearMain(args, { linearExec: fixture.exec, output: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) } });
  return { status, stdout, stderr };
}

test('issue-publish under linear verifies board presence, Status, one kind label and the exact child set by identifier, archived children included, and verifies an archived closed card by a direct read that refuses a label list with another page', () => {
  const epic = linearPublication();
  const verified = runLinearCheck(['ENG-1', 'ENG-2', 'ENG-3'], epic);
  assert.equal(verified.status, 0, verified.stderr.join('\n'));
  assert.deepEqual(verified.stdout, [
    'issue-publish: board presence verified for ENG-1, ENG-2, ENG-3.',
    'issue-publish: Statuses verified for ENG-1, ENG-2, ENG-3.',
    'issue-publish: exactly one kind label verified for ENG-1, ENG-2, ENG-3.',
    'issue-publish: closed cards archived in Linear, verified by a direct read: ENG-2.',
    'issue-publish: child set verified: ENG-1 has exactly the 2 supplied child issues.',
  ]);
  assert.deepEqual(epic.calls.filter(({ query }) => query.includes('archivedAt')).map(({ variables }) => variables), [{ id: 'ENG-2' }]);

  const standalone = runLinearCheck(['ENG-1'], linearPublication());
  assert.equal(standalone.status, 0, standalone.stderr.join('\n'));
  assert.equal(standalone.stdout.at(-1), 'issue-publish: ENG-1 verified as a standalone issue; it has 2 child issues (none supplied; pass them as arguments to verify an Epic).');

  const refusals = [
    [['ENG-1', 'ENG-3'], {}, 'Epic ENG-1 child mismatch: supplied but not native children: none; native children but not supplied: ENG-2'],
    [['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4'], { active: [linearIssue('ENG-1', LINEAR_TODO, [KIND_LABELS.epic]), linearIssue('ENG-3', LINEAR_TODO, [KIND_LABELS.task]), linearIssue('ENG-4', LINEAR_TODO, [KIND_LABELS.task])] }, 'Epic ENG-1 child mismatch: supplied but not native children: ENG-4; native children but not supplied: none'],
    [['ENG-1'], { active: [linearIssue('ENG-1', linearState('s-triage', 'Triage', 'triage'), [KIND_LABELS.epic])] }, 'requested issue ENG-1 has no non-empty Status'],
    [['ENG-1'], { active: [linearIssue('ENG-1', LINEAR_TODO, [KIND_LABELS.epic, KIND_LABELS.task])] }, `requested issue ENG-1 needs exactly one kind label (${Object.values(KIND_LABELS).join(', ')}) but has 2 (labels found: ${KIND_LABELS.epic}, ${KIND_LABELS.task})`],
    [['ENG-1'], { active: [], direct: { 'ENG-1': { identifier: 'ENG-1', team: { key: 'ENG' }, archivedAt: null, state: LINEAR_TODO, labels: linearList([{ name: KIND_LABELS.epic }]) } } }, 'requested issue ENG-1 is not in this board read, which lagged the card; re-run this check rather than adding the card again.'],
    [['ENG-1', 'ENG-2', 'ENG-3'], { direct: { 'ENG-2': { identifier: 'ENG-2', team: { key: 'ENG' }, archivedAt: '2026-01-05T00:00:00.000Z', state: { type: 'started' }, labels: linearList([{ name: KIND_LABELS.bug }]) } } }, 'requested issue ENG-2 is archived while still open; unarchive it, never add a second.'],
    [['ENG-1', 'ENG-2', 'ENG-3'], { direct: { 'ENG-2': { identifier: 'ENG-2', team: { key: 'ENG' }, archivedAt: '2026-01-05T00:00:00.000Z', state: { type: 'completed' }, labels: linearList([{ name: 'area:board' }], { hasNextPage: true }) } } }, 'ENG-2\'s labels run past one page, so its kind label cannot be checked'],
  ];
  for (const [args, fixture, message] of refusals) {
    const refused = runLinearCheck(args, linearPublication(fixture));
    assert.equal(refused.status, 1, message);
    assert.deepEqual(refused.stdout, []);
    assert.deepEqual(refused.stderr, [`issue-publish: ${message}`]);
  }
});

test('issue-publish under linear refuses an archived card that Linear answers under another identifier', () => {
  // Linear resolves a former identifier of an issue that moved team, so the direct read answers as ENG-30.
  const moved = { identifier: 'ENG-30', team: { key: 'ENG' }, archivedAt: '2026-01-05T00:00:00.000Z', state: { type: 'completed' }, labels: linearList([{ name: KIND_LABELS.bug }]) };

  assert.throws(
    () => verifyLinearPublication(['ENG-1', 'ENG-2', 'ENG-3'], linearPublication({ direct: { 'ENG-2': moved } }).exec),
    { message: 'requested issue ENG-2 is ENG-30 in Linear now, so this read is not the requested card; check the identifier rather than adding the card again.' },
  );
});

test('issue-publish: reports exact board presence, Statuses, Workstreams, and the native child set on a valid publication', () => {
  const { report, calls, ghExec } = verify(['475', '476', '477']);

  assert.deepEqual(report, [
    'issue-publish: board presence verified for #475, #476, #477.',
    'issue-publish: Statuses and Workstreams verified for #475, #476, #477.',
    'issue-publish: exactly one kind label verified for #475, #476, #477.',
    'issue-publish: native child set verified: #475 has exactly the 2 supplied child issues.',
  ]);
  assert.equal(calls.filter(([name]) => name === 'fetchBoard').length, 1);
  assert.equal(calls.filter(([name]) => name === 'ghExec').length, 1);
  assert.equal(calls[0][1], ghExec);
  const graphCommand = calls.find(([name]) => name === 'ghExec')[1];
  // Sub-issues are generally available: the retired `GraphQL-Features` preview header
  // must not be sent at all, or a future header removal would go unnoticed.
  assert.equal(graphCommand.indexOf('-H'), -1);
  // Pin the SUBJECT number too: without it the children could be fetched for another
  // issue entirely and every assertion here would still pass, so the report would name
  // #475 while describing someone else's children.
  assert.match(
    graphCommand.find((arg) => arg.startsWith('query=')),
    /issue\(number:475\).*subIssues\(first:100\).*totalCount.*nodes\s*\{\s*number\s*\}/s,
  );
});

test('issue-publish: fails when a requested issue is absent from the board', () => {
  assert.throws(
    () => verify(['475', '476', '477'], { board: BOARD.slice(0, 2) }),
    /#477.*absent from the board/,
  );
});

// These cases run through the real board parser. The difference between them exists
// only because `leanBoardQuery` asks GitHub for the content type; a pre-flattened
// fixture would stay green with that removed.
const RESOLVED_NODE = leanNode({
  id: 'PVTI_resolved',
  content: { __typename: 'Issue', number: 475, title: 'Resolved card', labels: [] },
  status: 'Ready',
  routing: 'Platform',
});

// A draft card is numberless by design — the board query asks for `number` only
// `... on Issue` — so its presence must never soften the absent-card verdict.
const DRAFT_NODE = leanNode({
  id: 'PVTI_draft',
  content: { __typename: 'DraftIssue' },
  title: 'draft: pricing page copy',
  status: 'Backlog',
});

// The #572 case: the card was created, but this read could not resolve its content, so it
// arrives with no content and therefore no number. It cannot be matched to the requested
// issue — only its presence is observable, and that is what makes "never added" unsafe.
const UNRESOLVED_NODE = leanNode({
  id: 'PVTI_unresolved',
  content: null,
  status: 'Backlog',
});

function boardRead(nodes, { probeProjects = [], probeResponse, children = [] } = {}) {
  const queries = [];
  const ghExec = (command) => {
    const query = command.find((arg) => arg.startsWith('query='));
    queries.push(query);
    // One slurped page: the array shape the real `--paginate --slurp` walk hands fetchBoard (#1155).
    if (query.includes('projectV2')) return JSON.stringify([leanBoardPage(nodes)]);
    if (query.includes('projectItems')) return probeResponse ?? graphProbe(probeProjects);
    return graphChildren(children);
  };
  return { queries, dependencies: { fetchBoard, ghExec } };
}

// A closed card archived on this board: the issue-side probe answers with its own board item,
// and the board read lists unarchived cards only, so this is the only view of it.
const ARCHIVED_CARD = {
  id: 'PVTI_archived',
  content: { __typename: 'Issue', number: 999, title: 'Finished card', state: 'CLOSED', labels: [KIND_LABELS.task] },
  status: 'Done',
  routing: 'Platform',
};

function archivedItem(card = {}, project = BOARD_PROJECT_NUMBER, owner = BOARD_OWNER) {
  return { ...leanNode({ ...ARCHIVED_CARD, ...card }), isArchived: true, project: { number: project, owner: { login: owner } } };
}

function archivedProbe(card = {}, project = BOARD_PROJECT_NUMBER, owner = BOARD_OWNER) {
  return JSON.stringify(issueItemReply([archivedItem(card, project, owner)]));
}

test('issue-publish: a card that was never added still fails loud as absent from the board', () => {
  const { queries, dependencies } = boardRead([RESOLVED_NODE, DRAFT_NODE]);

  assert.throws(
    () => verifyIssuePublication(['999'], dependencies),
    (error) => {
      assert.match(error.message, /requested issue #999 is absent from the board/);
      // The draft card must not soften the verdict into the propagation wording.
      assert.doesNotMatch(error.message, /did not resolve|Re-run/);
      return true;
    },
  );
  // That separation survives only while the query asks GitHub for the content type: without
  // it a real draft card arrives typeless and reads as unresolved, turning this exact case
  // into the propagation message in production while a canned fixture stayed green.
  assert.match(queries[0], /content\s*\{\s*__typename/);
});

test('issue-publish: a card the board read could not resolve is reported as a lagging read with a re-run action, not as absent', () => {
  const { dependencies } = boardRead([RESOLVED_NODE, UNRESOLVED_NODE]);

  assert.throws(
    () => verifyIssuePublication(['999'], dependencies),
    (error) => {
      assert.match(error.message, /#999/);
      assert.doesNotMatch(error.message, /absent from the board/);
      assert.match(error.message, /1 card\(s\) whose content did not resolve/);
      assert.match(error.message, /Re-run this check before adding the card again/);
      return true;
    },
  );

  // A probe that cannot answer must not discard what the read DID establish: the unresolved
  // cards are still lag evidence, and reporting only the probe failure would hide it.
  assert.throws(
    () => verifyIssuePublication(['999'], boardRead([RESOLVED_NODE, UNRESOLVED_NODE], { probeResponse: 'not json at all' }).dependencies),
    (error) => {
      assert.match(error.message, /1 card\(s\) whose content did not resolve/);
      assert.doesNotMatch(error.message, /could not confirm whether/);
      return true;
    },
  );

  // Naming the softer cause must not soften the exit status: an unconfirmed read still fails.
  const errors = [];
  const status = main(['999'], {
    ...boardRead([RESOLVED_NODE, UNRESOLVED_NODE]).dependencies,
    output: { log: () => { throw new Error('no success line may be printed'); }, error: (line) => errors.push(line) },
  });
  assert.equal(status, 1);
  assert.match(errors.join('\n'), /Re-run this check before adding the card again/);
});

test('issue-publish: an issue whose card the board read omitted entirely is reported as a lagging read, not as absent', () => {
  // The captured production shape (#600): the lagging card is missing from `items` ENTIRELY,
  // so there is no numberless card of any kind and `unresolvedCount` is 0. Nothing in the board
  // read distinguishes this from "never added" — only the issue side can, and it says otherwise.
  const { queries, dependencies } = boardRead([RESOLVED_NODE], { probeProjects: [BOARD_PROJECT_NUMBER] });

  assert.throws(
    () => verifyIssuePublication(['999'], dependencies),
    (error) => {
      assert.match(error.message, /#999 is on the board but not in this board read/);
      assert.match(error.message, /re-run this check rather than adding the card again/);
      assert.doesNotMatch(error.message, /absent from the board/);
      return true;
    },
  );
  // The probe is only trustworthy while it reads the SAME project the board read read (#572).
  // The probe query names no project at all, so its side is proven behaviourally by this pair:
  // an item on the configured project yields the lagging-read verdict above, and an item on any
  // OTHER project must leave the verdict at plain absence below, or the probe would
  // confirm a card nowhere near this board. This assertion pins the board read to the configured
  // project, so both sides are proven against the same configured number. A literal would be
  // blind exactly at the port (#1296): a board query hardcoded to the literal's value stays
  // green under any other configuration.
  assert.match(
    queries.find((q) => q.includes('projectV2')),
    new RegExp(`projectV2\\(number:${BOARD_PROJECT_NUMBER}\\)`),
  );
  assert.throws(
    () => verifyIssuePublication(['999'], boardRead([RESOLVED_NODE], { probeProjects: [BOARD_PROJECT_NUMBER + 1] }).dependencies),
    /requested issue #999 is absent from the board/,
  );
  // Pin the probe's TARGET as well as its project: without it the probe could ask about another
  // issue, or another repository, and every assertion above would still pass — reporting a
  // never-added #999 as a lagging read forever because some OTHER issue is on the board.
  assert.match(queries.find((q) => q.includes('projectItems')), /issue\(number:999\)/);
  assert.match(
    queries.find((q) => q.includes('projectItems')),
    new RegExp(`owner:"${BOARD_OWNER}", name:"${BOARD_REPOSITORY}"`),
  );

  // Positively identifying the cause must not soften the exit status: the check still fails.
  const errors = [];
  const status = main(['999'], {
    ...boardRead([RESOLVED_NODE], { probeProjects: [BOARD_PROJECT_NUMBER] }).dependencies,
    output: { log: () => { throw new Error('no success line may be printed'); }, error: (line) => errors.push(line) },
  });
  assert.equal(status, 1);
  assert.match(errors.join('\n'), /re-run this check rather than adding the card again/);
});

test('issue-publish: an open card archived on the board is reported as archived with an unarchive action, never as a lagging read', () => {
  // The two reads disagree about archived cards BY CONSTRUCTION: `ProjectV2.items` defaults to
  // NOT_ARCHIVED so the board read never lists one, while `Issue.projectItems` includes archived
  // items so the probe always sees it. That is byte-identical to the lagging-read shape, and
  // reported as lag it hands the operator a re-run that can never succeed (#304 live).
  const probeResponse = archivedProbe({ content: { ...ARCHIVED_CARD.content, state: 'OPEN' } });
  const { dependencies } = boardRead([RESOLVED_NODE], { probeResponse });

  assert.throws(
    () => verifyIssuePublication(['999'], dependencies),
    (error) => {
      assert.match(error.message, /#999 is archived on the board while still open/);
      assert.match(error.message, /unarchive the card rather than adding it again/);
      assert.doesNotMatch(error.message, /re-run this check/);
      assert.doesNotMatch(error.message, /absent from the board/);
      return true;
    },
  );

  // Naming the archived cause must not soften the exit status: the check still fails.
  const errors = [];
  const status = main(['999'], {
    ...boardRead([RESOLVED_NODE], { probeResponse }).dependencies,
    output: { log: () => { throw new Error('no success line may be printed'); }, error: (line) => errors.push(line) },
  });
  assert.equal(status, 1);
  assert.match(errors.join('\n'), /unarchive the card rather than adding it again/);
});

test('issue-publish: a closed card archived only on another project still fails as absent from this board', () => {
  const { dependencies } = boardRead([RESOLVED_NODE], { probeResponse: archivedProbe({}, BOARD_PROJECT_NUMBER + 1) });

  assert.throws(
    () => verifyIssuePublication(['999'], dependencies),
    /requested issue #999 is absent from the board/,
  );
});

test('issue-publish: a closed card archived on another owner\'s project of the same number still fails as absent from this board', () => {
  const { dependencies } = boardRead([RESOLVED_NODE], { probeResponse: archivedProbe({}, BOARD_PROJECT_NUMBER, 'someone-else') });

  assert.throws(
    () => verifyIssuePublication(['999'], dependencies),
    /requested issue #999 is absent from the board/,
  );
});

test('issue-publish: a probe reply with two items on this board is refused, never accepted', () => {
  const probeResponse = JSON.stringify(issueItemReply([archivedItem(), archivedItem()]));

  assert.throws(
    () => verifyIssuePublication(['999'], boardRead([RESOLVED_NODE], { probeResponse }).dependencies),
    /could not confirm whether issue #999 is on the board: .*2 items on project/,
  );
});

test('issue-publish: a probe reply whose items outnumber its count is refused, never accepted', () => {
  const probeResponse = JSON.stringify(issueItemReply([archivedItem()], { totalCount: 0 }));

  assert.throws(
    () => verifyIssuePublication(['999'], boardRead([RESOLVED_NODE], { probeResponse }).dependencies),
    /could not confirm whether issue #999 is on the board: .*reports 0 project items but returned 1/,
  );
});

test('issue-publish: an archived board item that cannot be read as this issue\'s card is never accepted', () => {
  // Each case is a closed archived item the parser cannot judge as #999. None may pass, and none
  // may send the operator to unarchive a card they cannot see.
  const cases = [
    [{ content: null }, /resolved to no issue/],
    [{ content: { ...ARCHIVED_CARD.content, number: 1000 } }, /resolved to #1000/],
    [{ content: { ...ARCHIVED_CARD.content, labels: { totalCount: 25, nodes: [] } } }, /has 25 labels but only 0 fetched/],
  ];

  for (const [card, expected] of cases) {
    const { dependencies } = boardRead([RESOLVED_NODE], { probeResponse: archivedProbe(card) });
    assert.throws(
      () => verifyIssuePublication(['999'], dependencies),
      (error) => {
        assert.match(error.message, /#999 is archived on the board, but its board item could not be read/);
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /unarchive/);
        return true;
      },
    );
  }
});

test('issue-publish: an Epic whose children include a closed card archived on the board passes, verified from that card\'s own board item', () => {
  const epic = leanNode({
    id: 'PVTI_epic',
    content: { __typename: 'Issue', number: 475, title: 'Epic card', labels: [KIND_LABELS.epic] },
    status: 'Ready',
    routing: 'Platform',
  });
  const task = leanNode({
    id: 'PVTI_task',
    content: { __typename: 'Issue', number: 476, title: 'Task card', labels: [KIND_LABELS.task] },
    status: 'Ready',
    routing: 'Product',
  });
  const { queries, dependencies } = boardRead([epic, task], { probeResponse: archivedProbe(), children: [476, 999] });

  assert.deepEqual(verifyIssuePublication(['475', '476', '999'], dependencies), [
    'issue-publish: board presence verified for #475, #476, #999.',
    'issue-publish: Statuses and Workstreams verified for #475, #476, #999.',
    'issue-publish: exactly one kind label verified for #475, #476, #999.',
    'issue-publish: closed cards archived on the board, verified from their own board items: #999.',
    'issue-publish: native child set verified: #475 has exactly the 2 supplied child issues.',
  ]);
  // The archived card is judged from the probe's own item, so the probe has to ask for the card
  // fields the board read asks for, on the right issue; without them its item has no Status.
  const probeQuery = queries.find((query) => query.includes('projectItems'));
  assert.match(probeQuery, /issue\(number:999\)/);
  assert.match(
    probeQuery,
    /isArchived project \{ number owner \{ \.\.\. on User \{ login \} \.\.\. on Organization \{ login \} \} \} content \{ __typename \.\.\. on Issue \{ number title state .*labels\(first:20\) \{ totalCount nodes \{ name \} \}.*fieldValues\(first:20\) \{ totalCount/s,
  );
});

test('issue-publish: a closed card archived on the board still needs a Status, a Workstream and exactly one kind label', () => {
  const cases = [
    [{ status: undefined }, /#999 has no non-empty Status/],
    [{ routing: undefined }, /#999 has no non-empty Workstream/],
    [{ content: { ...ARCHIVED_CARD.content, labels: ['area:board'] } }, /#999 needs exactly one kind label .* but has 0/],
  ];

  for (const [card, expected] of cases) {
    const { dependencies } = boardRead([RESOLVED_NODE], { probeResponse: archivedProbe(card) });
    assert.throws(() => verifyIssuePublication(['999'], dependencies), expected);
  }
});

test('issue-publish: a probe that cannot prove it read every project item never yields a confirmed absence', () => {
  // The probe answers "is this card on the board at all?", so an incomplete probe read is the
  // one input that must never reach a verdict: a board item beyond the page, or a response whose
  // completeness cannot be established, would otherwise be reported as a publication failure —
  // the exact wrong cause #572 exists to remove, reintroduced one layer down.
  const missingCount = issueItemReply();
  delete missingCount.data.repository.issue.projectItems.totalCount;
  const unreadableIssue = issueItemReply();
  unreadableIssue.data.repository.issue = null;
  const incomplete = [
    // Truncated: the board item could be the one on page two.
    [graphProbe([99], 21), /has 21 project items but only 1 fetched.*raise the projectItems first: cap in issueItemQuery/],
    // No totalCount: every comparison against it is false, so a bare truncation check passes
    // an unproven read. An empty nodes[] would then read as a confirmed absence.
    [JSON.stringify(missingCount), /no non-negative integer projectItems\.totalCount/],
    // No readable issue in the response. Reported as a shape defect, never as "the issue does
    // not exist": a null repository or a null `data` produces this same payload for an issue
    // that is sitting right there, and asserting the world fact would be confidently wrong.
    [JSON.stringify(unreadableIssue), /board item probe GraphQL response has no readable issue/],
    ['not json at all', /board item probe GraphQL response is not valid JSON/],
    // A node the parser cannot read is not a definite negative: read loosely, `{project: null}`
    // reads as "not on this project" and yields a confirmed absence from an unreadable page.
    [
      JSON.stringify(issueItemReply([{ id: 'bad', isArchived: false, project: null, value: null }])),
      /board item probe GraphQL response has a non-integer project number/,
    ],
    // The archived verdict is read off the matching node, so a non-boolean `isArchived` cannot
    // be defaulted into "not archived" — that is the archived card reported as a lagging read.
    [
      JSON.stringify(issueItemReply([{ id: 'bad', project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } }, value: null }])),
      /board item probe GraphQL response has a non-boolean isArchived/,
    ],
  ];

  for (const [probeResponse, expected] of incomplete) {
    assert.throws(
      () => verifyIssuePublication(['999'], boardRead([RESOLVED_NODE], { probeResponse }).dependencies),
      (error) => {
        assert.match(error.message, /could not confirm whether issue #999 is on the board/);
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /absent from the board/);
        return true;
      },
    );
  }
});

test('issue-publish: fails when a requested board card has a missing or blank Workstream', () => {
  for (const routing of [null, '   ']) {
    const board = structuredClone(BOARD);
    board[1].routing = routing;
    assert.throws(
      () => verify(['475', '476', '477'], { board }),
      /#476.*non-empty Workstream/,
    );
  }
});

test('issue-publish: fails when a requested board card has a missing or blank Status', () => {
  for (const status of [null, '   ']) {
    const board = structuredClone(BOARD);
    board[1].status = status;
    assert.throws(
      () => verify(['475', '476', '477'], { board }),
      /#476.*non-empty Status/,
    );
  }
});

function boardWithLabels(number, labels) {
  const board = structuredClone(BOARD);
  board.find((card) => card.content.number === number).labels = labels;
  return board;
}

const KIND_NAMES = Object.values(KIND_LABELS).join(', ');

test('issue-publish: fails an issue with no kind label, naming the issue and the labels found', () => {
  assert.throws(
    () => verify(['475', '476', '477'], { board: boardWithLabels(476, ['area:board']) }),
    { message: `requested issue #476 needs exactly one kind label (${KIND_NAMES}) but has 0 (labels found: area:board)` },
  );
  assert.throws(
    () => verify(['475', '476', '477'], { board: boardWithLabels(476, []) }),
    { message: `requested issue #476 needs exactly one kind label (${KIND_NAMES}) but has 0 (labels found: none)` },
  );
  // A prefixed kind label is not a kind.
  assert.throws(
    () => verify(['475', '476', '477'], { board: boardWithLabels(476, [`x:${KIND_LABELS.task}`, 'area:board']) }),
    { message: `requested issue #476 needs exactly one kind label (${KIND_NAMES}) but has 0 (labels found: x:${KIND_LABELS.task}, area:board)` },
  );

  // Through the real board parser and the command: the labels the check reads are the ones
  // the board read delivers, and the failure reaches the exit status and the error stream.
  const unlabelled = leanNode({
    id: 'PVTI_unlabelled',
    content: { __typename: 'Issue', number: 480, title: 'Unlabelled card', labels: ['area:board'] },
    status: 'Ready',
    routing: 'Platform',
  });
  const errors = [];
  const status = main(['480'], {
    ...boardRead([unlabelled]).dependencies,
    output: { log: () => { throw new Error('no success line may be printed'); }, error: (line) => errors.push(line) },
  });
  assert.equal(status, 1);
  assert.deepEqual(errors, [
    `issue-publish: requested issue #480 needs exactly one kind label (${KIND_NAMES}) but has 0 (labels found: area:board)`,
  ]);
});

test('issue-publish: fails an issue with two kind labels, naming the issue and the labels found', () => {
  assert.throws(
    () => verify(['475', '476', '477'], { board: boardWithLabels(477, [KIND_LABELS.bug, 'area:board', KIND_LABELS.task]) }),
    { message: `requested issue #477 needs exactly one kind label (${KIND_NAMES}) but has 2 (labels found: ${KIND_LABELS.bug}, area:board, ${KIND_LABELS.task})` },
  );
});

test('issue-publish: fails an issue whose label list holds a name that is not text', () => {
  assert.throws(
    () => verify(['475', '476', '477'], { board: boardWithLabels(476, [KIND_LABELS.task, null]) }),
    { message: 'requested issue #476 has a label whose name is not text' },
  );
});

test('issue-publish: passes an issue with exactly one kind label among other labels', () => {
  const { report } = verify(['475'], {
    board: boardWithLabels(475, ['area:board', KIND_LABELS.feature, 'priority:high']),
    graph: graphChildren([]),
  });

  assert.equal(report[2], 'issue-publish: exactly one kind label verified for #475.');
});

test('issue-publish: fails loud when duplicate board cards share a requested issue number', () => {
  const board = structuredClone(BOARD);
  board.splice(1, 0, { content: { number: 476 }, routing: 'Product' });
  board[2].routing = 'Go-to-market';
  assert.throws(
    () => verify(['475', '476', '477'], { board }),
    /duplicate board cards.*#476/,
  );
});

test('issue-publish: indexes only numbered board cards, so several numberless draft cards never collapse into one entry', () => {
  // `normalizeItem` gives every draft card `number: null`. Keyed by that, they all overwrite
  // each other under a single `null` entry — an index that silently claims one card where the
  // board holds several.
  //
  // The guard has TWO branches — not a safe integer, and not positive — so `null` alone exercises
  // only the first: dropping `card.number <= 0` would leave a null-only fixture green. Each value
  // below is a distinct branch, and each is a key a Map would happily accept.
  const board = [
    ...structuredClone(BOARD),
    { title: 'draft: pricing page copy', status: 'Backlog', routing: 'Go-to-market' },
    { title: 'draft: onboarding walkthrough', status: 'Backlog', routing: 'Product' },
    { content: { number: 0 }, title: 'zero', status: 'Backlog', routing: 'Platform' },
    { content: { number: -5 }, title: 'negative', status: 'Backlog', routing: 'Platform' },
    { content: { number: 1.5 }, title: 'fractional', status: 'Backlog', routing: 'Platform' },
    { content: { number: Number.MAX_SAFE_INTEGER + 1 }, title: 'unsafe', status: 'Backlog', routing: 'Platform' },
  ];

  const { cards } = boardCardsByNumber(board);

  for (const rejected of [null, 0, -5, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(cards.has(rejected), false, `${rejected} must never be indexed`);
  }
  assert.equal(cards.size, 3);
  assert.deepEqual([...cards.keys()], [475, 476, 477]);
  assert.equal(cards.get(476).routing, 'Product');
  assert.equal(cards.get(477).status, 'Backlog');

  // Skipping the unindexable must not soften the guard on real numbers.
  const duplicated = [...board, { content: { number: 476 }, status: 'Ready', routing: 'Platform' }];
  assert.throws(() => boardCardsByNumber(duplicated), /duplicate board cards for issue #476/);
});

test('issue-publish: fails when the Epic has an extra native child beyond the supplied children', () => {
  assert.throws(
    () => verify(['475', '476', '477'], { graph: graphChildren([476, 477, 478]) }),
    /Epic #475.*supplied but not native children: none.*native children but not supplied: #478/s,
  );
});

test('issue-publish: fails when the supplied children match the native child count but not the native numbers', () => {
  // The count matches (2 and 2), so only a set comparison can catch this: #477 was
  // boarded but never natively linked, and unrelated #999 quietly keeps the count equal.
  assert.throws(
    () => verify(['475', '476', '477'], { graph: graphChildren([999, 476]) }),
    (error) => {
      assert.match(error.message, /Epic #475/);
      assert.match(error.message, /supplied but not native children: #477/);
      assert.match(error.message, /native children but not supplied: #999/);
      return true;
    },
  );
});

test('issue-publish: fails loud when the native child page is truncated rather than comparing a partial set', () => {
  assert.throws(
    () => verify(['475', '476', '477'], { graph: graphChildren([476, 477], 130) }),
    /#475 reports 130 native child issues.*read only one page of 2/s,
  );
});

test('issue-publish: fails loud when a native child number is repeated rather than reporting success', () => {
  // totalCount (2) matches the node count, and the symmetric difference against the one
  // supplied child is empty in both directions — only a duplicate guard catches this.
  assert.throws(
    () => verify(['475', '476'], { graph: graphChildren([476, 476]) }),
    /native children GraphQL response.*duplicate.*476/s,
  );
});

test('issue-publish: fails loud on a malformed native-child GraphQL response', () => {
  for (const graph of [
    JSON.stringify({ data: { repository: { issue: {} } } }),
    JSON.stringify({ data: { repository: { issue: { subIssues: { totalCount: 1 } } } } }),
  ]) {
    assert.throws(
      () => verify(['475', '476', '477'], { graph }),
      /native children GraphQL response/,
    );
  }
});

test('issue-publish: fails loud when a native child number is not a positive integer', () => {
  for (const nodes of [['476'], [0]]) {
    assert.throws(
      () => verify(['475', '476'], { graph: graphChildren(nodes) }),
      /native children GraphQL response has a non-positive-integer child number/,
    );
  }
});

test('issue-publish: rejects duplicate, malformed, and non-positive arguments before GitHub calls', () => {
  let githubCalls = 0;
  const noGithub = {
    fetchBoard: () => { githubCalls += 1; throw new Error('board call must not happen'); },
    ghExec: () => { githubCalls += 1; throw new Error('GraphQL call must not happen'); },
  };

  assert.throws(() => verifyIssuePublication(['475', '476', '476'], noGithub), /duplicate issue number #476/);
  assert.throws(() => verifyIssuePublication(['475', 'nope'], noGithub), /positive issue number/);
  assert.throws(() => verifyIssuePublication(['0', '476'], noGithub), /positive issue number/);
  assert.throws(() => verifyIssuePublication([], noGithub), /expected an issue number, optionally followed by child numbers/);
  assert.equal(githubCalls, 0);
});

test('issue-publish: verifies a standalone issue and reports its zero native child count', () => {
  const { report } = verify(['475'], { graph: graphChildren([]) });

  assert.deepEqual(report, [
    'issue-publish: board presence verified for #475.',
    'issue-publish: Statuses and Workstreams verified for #475.',
    'issue-publish: exactly one kind label verified for #475.',
    'issue-publish: #475 verified as a standalone issue; it has 0 native child issues (none supplied; pass them as arguments to verify an Epic).',
  ]);
});

test('issue-publish: reports rather than asserts a nonzero native child count for a standalone issue', () => {
  const { report, calls } = verify(['475'], { graph: graphChildren([476, 477, 478]) });

  assert.match(report[3], /standalone issue/);
  assert.match(report[3], /3 native child issues/);
  // The reported count is only honest if it came from the issue being named. Pin the
  // subject number in the query, or a count fetched for a different issue reads as this
  // issue's — the exact confidently-wrong output this line exists to prevent.
  const graphCommand = calls.find(([name]) => name === 'ghExec')[1];
  assert.match(graphCommand.find((arg) => arg.startsWith('query=')), /issue\(number:475\)/);
});

test('issue-publish: reports a standalone count from totalCount even when more children exist than one page read', () => {
  // The standalone branch compares nothing, so a truncated page cannot mislead it:
  // totalCount is the honest answer whatever the page held. The Epic path below is
  // where truncation must still fail loud.
  const { report } = verify(['475'], { graph: graphChildren([476, 477], 130) });

  assert.match(report[3], /standalone issue/);
  assert.match(report[3], /130 native child issues/);
});

test('issue-publish: still fails loud for an Epic with the truncated shape a standalone tolerates', () => {
  assert.throws(
    () => verify(['475', '476', '477'], { graph: graphChildren([476, 477], 130) }),
    /#475 reports 130 native child issues.*read only one page of 2/s,
  );
});

test('issue-publish: fails when a standalone issue is absent from the board or has no Workstream', () => {
  assert.throws(
    () => verify(['478'], { graph: graphChildren([]) }),
    /#478.*absent from the board/,
  );

  const board = structuredClone(BOARD);
  board[0].routing = '   ';
  assert.throws(
    () => verify(['475'], { board, graph: graphChildren([]) }),
    /#475.*no non-empty Workstream/,
  );
});

// Logs every invocation and fails loud, so the calls file proves GitHub was never reached.
const fakeGh = installFakeGh('issue-publish-cli-', `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_GH_CALLS, process.argv.slice(2).join(' ') + '\\n');
process.exitCode = 2;
`);
after(() => fakeGh.cleanup());

test('issue-publish: CLI exits non-zero for invalid arguments without invoking GitHub', () => {
  const callsFile = fakeGh.newCallsFile();
  writeFileSync(callsFile, '');
  const result = spawnSync(process.execPath, [toolkit.script('verify-issue-publish.mjs'), '475', '0'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: fakeGh.env({ FAKE_GH_CALLS: callsFile }),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /positive issue number/);
  assert.equal(readFileSync(callsFile, 'utf8'), '');
});
