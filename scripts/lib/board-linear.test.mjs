// board-linear.test.mjs — tests of the Linear board reader.
// Run: node --test scripts/lib/board-linear.test.mjs
//
// Every test runs a copy of the reader wired to LINEAR_TEST_CONFIG (team ENG, example-owner/example-repo),
// never this install's own board-config.mjs. Expected values come from Linear's schema: `issues` pages
// by `first`/`after` and leaves archived issues out unless `includeArchived: true` ("Should archived
// resources be included (default: false)"), a relation's `issue` is the issue it originates from, so
// "A blocks B" is on B's `inverseRelations`, and `Comment.createdAt` orders comments. The sub-issue
// counts are GitHub's `subIssuesSummary` counts, archived children included. The executor is a fake
// that answers as Linear would for each query. The team's automation rules follow the schema's
// `GitAutomationState`: a null `state` is "no action" and overrides any default rule, and a null
// `targetBranch` marks the default rule. A connection with `hasNextPage: true` holds more than it returned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINEAR_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';

async function loadReader(t, config = LINEAR_TEST_CONFIG) {
  const toolkit = copyToolkit(config);
  t.after(toolkit.cleanup);
  return toolkit.load('lib/board-linear.mjs');
}

const state = (id, name, type) => ({ id, name, type });
const BACKLOG = state('s-backlog', 'Backlog', 'backlog');
const TODO = state('s-todo', 'Todo', 'unstarted');
const PROGRESS = state('s-progress', 'In Progress', 'started');
const DONE = state('s-done', 'Done', 'completed');
const CANCELED = state('s-canceled', 'Canceled', 'canceled');
const DUPLICATE = state('s-duplicate', 'Duplicate', 'duplicate');
const TRIAGE = state('s-triage', 'Triage', 'triage');

const TEAM_STATES = [
  BACKLOG, TODO, PROGRESS, state('s-awaiting', 'Awaiting Push', 'started'), state('s-review', 'In Review', 'started'),
  DONE, CANCELED, DUPLICATE, TRIAGE,
];

// The default automation rules a Linear team must hold: an opened pull request starts review and a merged
// one is done. A draft pull request moves nothing because the team holds no draft rule, which Linear's
// settings show as "No action" (Linear refuses a default rule with no state).
const rule = (event, stateId, targetBranch = null) => ({ event, state: stateId && { id: stateId }, targetBranch });
const VALID_RULES = [rule('start', 's-review'), rule('merge', 's-done')];

function teamWith({ states = TEAM_STATES, rules = VALID_RULES, statesPage = { hasNextPage: false }, rulesPage = { hasNextPage: false } } = {}) {
  return {
    teams: {
      nodes: [{
        id: 'team-eng',
        key: 'ENG',
        states: { nodes: states, pageInfo: statesPage },
        gitAutomationStates: { nodes: rules, pageInfo: rulesPage },
      }],
    },
  };
}

const TEAM = teamWith();

const noMore = { hasNextPage: false };
const list = (nodes) => ({ nodes, pageInfo: noMore });

function issue(identifier, title, issueState, { assignee = null, parent = null, labels = [], relations = [], urls = [] } = {}) {
  return {
    id: `id-${identifier}`,
    identifier,
    title,
    state: issueState,
    assignee: assignee && { displayName: assignee },
    parent: parent && { identifier: parent },
    labels: list(labels.map((name) => ({ name }))),
    inverseRelations: list(relations.map(([type, from, fromState]) => ({ type, issue: { identifier: from, state: { type: fromState } } }))),
    attachments: list(urls.map(([url, linkKind]) => ({ url, metadata: { linkKind } }))),
  };
}

const PULL = 'https://github.com/example-owner/example-repo/pull';

// The board's active issues: the epic ENG-1 with its active child ENG-3, which carries a blocker of each
// state, a related issue that blocks nothing and five attachments of which two are this repository's pull
// requests: one Linear marks as closing and one it marks as only contributing.
const ACTIVE = [
  issue('ENG-1', 'Epic', TODO, { labels: ['epic'] }),
  issue('ENG-3', 'Active child', TODO, {
    assignee: 'alice',
    parent: 'ENG-1',
    labels: ['task', 'bug'],
    relations: [['blocks', 'ENG-4', 'started'], ['blocks', 'ENG-5', 'canceled'], ['related', 'ENG-8', 'started']],
    urls: [
      [`${PULL}/12`, 'closes'],
      [`${PULL}/16`, 'contributes'],
      ['https://github.com/example-owner/other-repo/pull/13', 'closes'],
      ['https://example.com/example-owner/example-repo/pull/14', 'closes'],
      [`${PULL}/15/files`, 'closes'],
    ],
  }),
  issue('ENG-4', 'Started', PROGRESS),
  issue('ENG-5', 'Canceled', CANCELED),
  issue('ENG-6', 'Duplicate', DUPLICATE),
  issue('ENG-7', 'Triage', TRIAGE),
  issue('ENG-8', 'Backlog', BACKLOG),
];

// Linear leaves ENG-2, the epic's archived completed child, out of every read but the children query
// that asks for `includeArchived: true`.
function board({ issues = ACTIVE, pageSize = issues.length } = {}) {
  const calls = [];
  const exec = (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('teams(')) return TEAM;
    if (query.includes('filter: { parent:')) {
      const archived = { identifier: 'ENG-2', parent: { identifier: 'ENG-1' }, state: { type: 'completed' } };
      const active = { identifier: 'ENG-3', parent: { identifier: 'ENG-1' }, state: { type: 'unstarted' } };
      return { issues: list(query.includes('includeArchived: true') ? [archived, active] : [active]) };
    }
    const start = variables.after === null ? 0 : Number(variables.after);
    const end = start + pageSize;
    return { issues: { nodes: issues.slice(start, end), pageInfo: { hasNextPage: end < issues.length, endCursor: String(end) } } };
  };
  return { exec, calls };
}

test('readLinearBoard maps states to columns, canceled and duplicate to Done, an unmapped state to no Status, blockers from inverse blocks relations, closing pull requests from this repository\'s pull request attachments that Linear marks as closing only, and sub-issue counts from every child, archived ones included', async (t) => {
  const { readLinearBoard } = await loadReader(t);
  const { exec, calls } = board({ pageSize: 3 });

  const { items } = readLinearBoard(exec);

  const byId = new Map(items.map((item) => [item.content.number, item]));
  assert.deepEqual([...byId.keys()], ['ENG-1', 'ENG-3', 'ENG-4', 'ENG-5', 'ENG-6', 'ENG-7', 'ENG-8']);
  assert.deepEqual(items.map((item) => [item.content.number, item.status, item.content.state]), [
    ['ENG-1', 'Ready', 'OPEN'],
    ['ENG-3', 'Ready', 'OPEN'],
    ['ENG-4', 'In progress', 'OPEN'],
    ['ENG-5', 'Done', 'CLOSED'],
    ['ENG-6', 'Done', 'CLOSED'],
    ['ENG-7', null, 'OPEN'],
    ['ENG-8', 'Backlog', 'OPEN'],
  ]);
  const active = byId.get('ENG-3');
  assert.deepEqual(active.blockers, [{ number: 'ENG-4', state: 'OPEN' }, { number: 'ENG-5', state: 'CLOSED' }]);
  assert.deepEqual(active.closingPullRequests, [{ number: 12 }]);
  assert.ok(calls.some(({ query }) => query.includes('attachments(first: 20) { nodes { url metadata }')), 'the issues query asks for the attachment metadata');
  assert.deepEqual(active.assignees, ['alice']);
  assert.deepEqual(active.labels, ['task', 'bug']);
  assert.equal(active.routing, null);
  assert.deepEqual(byId.get('ENG-1').content.subIssuesSummary, { total: 2, completed: 1 });
  assert.deepEqual(byId.get('ENG-4').content.subIssuesSummary, { total: 0, completed: 0 });
  assert.deepEqual(byId.get('ENG-1').assignees, []);
  // The seven issues came in three pages, each asked for after the cursor the last one gave.
  assert.deepEqual(calls.filter(({ query }) => !query.includes('teams(') && !query.includes('filter: { parent:')).map(({ variables }) => variables.after), [null, '3', '6']);
});

const COMMENT_PAGES = {
  'ENG-5': [
    { nodes: [{ id: 'c2', createdAt: '2026-01-02T00:00:00.000Z', body: 'Claim: second' }, { id: 'c1', createdAt: '2026-01-01T00:00:00.000Z', body: 'first' }], pageInfo: { hasNextPage: true, endCursor: 'p1' } },
    { nodes: [{ id: 'c3', createdAt: '2026-01-02T00:00:00.000Z', body: 'third' }], pageInfo: noMore },
  ],
  'ENG-9': [{ nodes: [], pageInfo: noMore }],
};

test('linearCardDetails reads every comment page and returns the comments oldest first', async (t) => {
  const { linearCardDetails } = await loadReader(t);
  const calls = [];
  const exec = (query, variables) => {
    calls.push(variables);
    const pages = COMMENT_PAGES[variables.id];
    const page = pages[variables.after === null ? 0 : 1];
    const described = variables.id === 'ENG-5' ? { description: 'Card body', parent: { identifier: 'ENG-1' } } : { description: null, parent: null };
    return { issue: { identifier: variables.id, ...described, comments: page } };
  };

  const details = linearCardDetails(exec, ['ENG-5', 'ENG-9']);

  assert.deepEqual(details.get('ENG-5'), {
    number: 'ENG-5',
    body: 'Card body',
    parent: 'ENG-1',
    // Newest first on the first page; c2 and c3 share a time, so the id orders them.
    comments: ['first', 'Claim: second', 'third'],
    commentCount: 3,
    commentsUnavailable: null,
  });
  assert.deepEqual(details.get('ENG-9'), { number: 'ENG-9', body: '', parent: null, comments: [], commentCount: 0, commentsUnavailable: null });
  assert.deepEqual(calls, [{ id: 'ENG-5', after: null }, { id: 'ENG-5', after: 'p1' }, { id: 'ENG-9', after: null }]);
});

// The config text with one export replaced by a value, or dropped when no value is given.
function configWith(name, value) {
  const line = new RegExp(`^export const ${name} = .*\\n`, 'm');
  assert.match(LINEAR_TEST_CONFIG, line);
  return LINEAR_TEST_CONFIG.replace(line, value === undefined ? '' : `export const ${name} = ${JSON.stringify(value)};\n`);
}

// Runs a read that must refuse and returns what it threw; a read that returns is the failure.
function refusalOf(read, label) {
  let refusal;
  assert.throws(read, (error) => { refusal = error; return true; }, label);
  return refusal;
}

// Runs a read that must come back whole and returns its result; a read that throws is the failure.
function resultOf(read, label) {
  let result;
  assert.doesNotThrow(() => { result = read(); }, label);
  return result;
}

const STARTER_STATES = { 'Backlog': 'Backlog', 'Ready': 'Todo', 'In progress': 'In Progress', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', 'Done': 'Done' };

test('readLinearTeam refuses a missing or malformed LINEAR_TEAM or LINEAR_STATES, a routing field or a parked lane, naming board-config.mjs', async (t) => {
  const withoutDone = Object.fromEntries(Object.entries(STARTER_STATES).filter(([column]) => column !== 'Done'));
  const cases = [
    ['a missing LINEAR_TEAM', configWith('LINEAR_TEAM')],
    ['a lowercase LINEAR_TEAM', configWith('LINEAR_TEAM', 'eng')],
    ['a LINEAR_TEAM with a number', configWith('LINEAR_TEAM', 'ENG-1')],
    ['a missing LINEAR_STATES', configWith('LINEAR_STATES')],
    ['a LINEAR_STATES without a column', configWith('LINEAR_STATES', withoutDone)],
    ['a LINEAR_STATES with an extra column', configWith('LINEAR_STATES', { ...STARTER_STATES, Parked: 'Parked' })],
    ['a LINEAR_STATES naming one state twice', configWith('LINEAR_STATES', { ...STARTER_STATES, Backlog: 'Todo' })],
    ['a LINEAR_STATES with an empty state name', configWith('LINEAR_STATES', { ...STARTER_STATES, Done: '' })],
    ['a routing field', configWith('ROUTING_FIELD', 'Workstream')],
    ['a parked lane', configWith('PARKED_LANE', 'Parked')],
  ];

  for (const [label, config] of cases) {
    const { readLinearTeam } = await loadReader(t, config);
    assert.match(refusalOf(() => readLinearTeam(() => TEAM), label).message, /board-config\.mjs/, label);
  }
});

test('readLinearTeam refuses a mapped state that is missing, duplicated or of the wrong type, and a team whose states or rules run past one page', async (t) => {
  const { readLinearTeam } = await loadReader(t);
  const without = (name) => TEAM_STATES.filter((candidate) => candidate.name !== name);
  const retyped = (name, type) => TEAM_STATES.map((candidate) => (candidate.name === name ? { ...candidate, type } : candidate));
  const more = { hasNextPage: true, endCursor: 'more' };
  const cases = [
    ['a missing state', { states: without('Todo') }],
    ['a duplicated state', { states: [...TEAM_STATES, state('s-progress-2', 'In Progress', 'started')] }],
    ['Ready mapped to a started state', { states: retyped('Todo', 'started') }],
    ['In review mapped to an unstarted state', { states: retyped('In Review', 'unstarted') }],
    ['Done mapped to a canceled state', { states: retyped('Done', 'canceled') }],
    ['states past one page', { statesPage: more }],
    ['rules past one page', { rulesPage: more }],
  ];

  for (const [label, team] of cases) {
    refusalOf(() => readLinearTeam(() => teamWith(team)), label);
  }
});

test('readLinearTeam asks Linear for at most two teams, so the team read stays inside Linear\'s complexity limit and still sees a second team', async (t) => {
  const { readLinearTeam } = await loadReader(t);
  const queries = [];
  const twoTeams = { teams: { nodes: [...TEAM.teams.nodes, ...TEAM.teams.nodes] } };

  const { message } = refusalOf(() => readLinearTeam((query) => { queries.push(query); return twoTeams; }), 'an answer of two teams');

  // Without a bound Linear counts its default 50 teams against the states and rules a team holds, and refuses the read as too complex.
  assert.equal(queries.length, 1);
  assert.match(queries[0], /teams\(first: 2,/);
  assert.match(message, /returned 2 teams .*, not one/);
});

test('readLinearTeam refuses a draft rule that moves cards, a start rule not to In review, a merge rule not to Done, a missing start or merge rule and any regex target-branch rule, listing every mismatch', async (t) => {
  const { readLinearTeam } = await loadReader(t);
  const regexRule = { branchPattern: 'ma.*', isRegex: true };
  const [start, merge] = VALID_RULES;
  const cases = [
    ['a draft rule that moves cards', [rule('draft', 's-review'), start, merge], /draft/],
    ['a start rule not to In review', [rule('start', 's-progress'), merge], /start/],
    ['a merge rule not to Done', [start, rule('merge', 's-review')], /merge/],
    ['a missing start rule', [merge], /start/],
    ['a missing merge rule', [start], /merge/],
    ['a regex target-branch rule', [...VALID_RULES, rule('start', 's-review', regexRule)], /regex|regular expression/i],
  ];

  for (const [label, rules, mismatch] of cases) {
    const { message } = refusalOf(() => readLinearTeam(() => teamWith({ rules })), label);
    assert.match(message, mismatch, label);
    assert.match(message, /Team setup/, label);
    assert.match(message, /docs\/LINEAR-CARDS\.md/, label);
  }

  const allWrong = [rule('draft', 's-review'), rule('start', 's-progress'), rule('merge', 's-review'), rule('start', 's-review', regexRule)];
  const { message } = refusalOf(() => readLinearTeam(() => teamWith({ rules: allWrong })), 'every rule wrong');
  for (const mismatch of [/draft/, /start/, /merge/, /regex|regular expression/i]) assert.match(message, mismatch);
});

test('readLinearTeam takes a literal main target-branch rule over the default rule', async (t) => {
  const { readLinearTeam } = await loadReader(t);
  const main = { branchPattern: 'main', isRegex: false };
  const [, merge] = VALID_RULES;

  // A correct default merge rule does not save a literal main rule that merges into In Progress.
  refusalOf(() => readLinearTeam(() => teamWith({ rules: [...VALID_RULES, rule('merge', 's-progress', main)] })), 'a wrong literal main rule');
  // A wrong default start rule does not fail a literal main rule that starts In Review.
  const team = resultOf(() => readLinearTeam(() => teamWith({ rules: [rule('start', 's-done'), merge, rule('start', 's-review', main)] })), 'a correct literal main rule');
  assert.equal(team.key, 'ENG');
});

test('readLinearTeam reads a team with no draft rule as taking no action, as Linear\'s settings show, and a literal main draft rule with no state as no action too', async (t) => {
  const { readLinearTeam } = await loadReader(t);

  assert.equal(resultOf(() => readLinearTeam(() => teamWith({ rules: VALID_RULES })), 'a team with no draft rule').key, 'ENG');
  const main = rule('draft', null, { branchPattern: 'main', isRegex: false });
  assert.equal(resultOf(() => readLinearTeam(() => teamWith({ rules: [...VALID_RULES, main] })), 'a literal main draft rule with no state').key, 'ENG');
});

test('readLinearBoard fails whole when a nested list has another page or Linear returns an identifier outside the team', async (t) => {
  const { readLinearBoard } = await loadReader(t);
  const more = { hasNextPage: true, endCursor: 'more' };
  const epic = issue('ENG-1', 'Epic', TODO);

  for (const connection of ['labels', 'inverseRelations', 'attachments']) {
    const truncated = { ...issue('ENG-3', 'Truncated', TODO), [connection]: { nodes: [], pageInfo: more } };
    const { message } = refusalOf(() => readLinearBoard(board({ issues: [epic, truncated] }).exec), `${connection} with another page`);
    assert.match(message, /ENG-3/, connection);
    assert.match(message, new RegExp(connection), connection);
  }

  for (const identifier of ['OTH-9', 'ENG-0', 'eng-3']) {
    const { message } = refusalOf(() => readLinearBoard(board({ issues: [epic, issue(identifier, 'Foreign', TODO)] }).exec), `the identifier ${identifier}`);
    assert.match(message, new RegExp(identifier), identifier);
  }
});

// Answers the issues query with the page the test names for each cursor it is asked, and bounds itself
// so a reader that keeps asking fails on its assertion rather than looping forever.
const issuesPaged = (pageFor) => {
  const epic = issue('ENG-1', 'Epic', TODO);
  const asked = new Map();
  return (query, variables) => {
    if (query.includes('teams(')) return TEAM;
    if (query.includes('filter: { parent:')) return { issues: list([]) };
    const times = (asked.get(variables.after) ?? 0) + 1;
    asked.set(variables.after, times);
    if (times > 2) throw new Error(`fake: asked again for ${variables.after}`);
    return { issues: { nodes: [epic], pageInfo: pageFor(variables.after) } };
  };
};

test('readLinearBoard fails whole when a Linear page says another page follows but gives no cursor, or gives back a cursor it gave before', async (t) => {
  const { readLinearBoard } = await loadReader(t);

  const noCursor = refusalOf(() => readLinearBoard(issuesPaged(() => ({ hasNextPage: true, endCursor: null }))), 'another page without a cursor');
  assert.ok(noCursor.message.includes('Linear reported another page without a cursor, so the read is incomplete'), noCursor.message);

  const sameCursor = refusalOf(() => readLinearBoard(issuesPaged(() => ({ hasNextPage: true, endCursor: 'p1' }))), 'a cursor it gave before');
  assert.ok(sameCursor.message.includes('Linear gave back the cursor p1 a second time, so the read cannot advance'), sameCursor.message);
});

test('readLinearBoard fails whole when Linear\'s cursors return to one it gave earlier', async (t) => {
  const { readLinearBoard } = await loadReader(t);
  const next = { null: 'p1', p1: 'p2', p2: 'p1' };

  const cycled = refusalOf(() => readLinearBoard(issuesPaged((after) => ({ hasNextPage: true, endCursor: next[after] }))), 'cursors that cycle');
  assert.ok(cycled.message.includes('Linear gave back the cursor p1 a second time, so the read cannot advance'), cycled.message);
});

const cardPage = (id, comments, endCursor = null) => ({
  nodes: comments.map((body, index) => ({ id: `${id}-c${index}`, createdAt: `2026-01-0${index + 1}T00:00:00.000Z`, body })),
  pageInfo: endCursor === null ? noMore : { hasNextPage: true, endCursor },
});

test('linearCardDetails marks a card unavailable on a failed comment page or a different identifier, keeping the other cards, and at a rate limit keeps the cards already read, marks the current and every later card unavailable and sends nothing further', async (t) => {
  const { linearCardDetails } = await loadReader(t);
  const whole = (id, comments) => ({ number: id, body: '', parent: null, comments, commentCount: comments.length, commentsUnavailable: null });
  const answer = (variables, comments, identifier = variables.id) => ({ issue: { identifier, description: null, parent: null, comments } });

  const exec = (query, variables) => {
    if (variables.id === 'ENG-5' && variables.after === 'p1') throw new Error('comments page 2 of ENG-5 failed');
    if (variables.id === 'ENG-5') return answer(variables, cardPage('ENG-5', ['first'], 'p1'));
    if (variables.id === 'ENG-6') return answer(variables, cardPage('ENG-6', ['stray']), 'ENG-77');
    return answer(variables, cardPage(variables.id, [`note on ${variables.id}`]));
  };
  const details = resultOf(() => linearCardDetails(exec, ['ENG-4', 'ENG-5', 'ENG-6', 'ENG-7']), 'a failed page or a different identifier');

  assert.deepEqual([...details.keys()], ['ENG-4', 'ENG-5', 'ENG-6', 'ENG-7']);
  assert.deepEqual(details.get('ENG-4'), whole('ENG-4', ['note on ENG-4']));
  assert.deepEqual(details.get('ENG-7'), whole('ENG-7', ['note on ENG-7']));
  assert.deepEqual(Object.keys(details.get('ENG-5')), ['number', 'unavailable']);
  assert.match(details.get('ENG-5').unavailable, /comments page 2 of ENG-5 failed/);
  assert.deepEqual(Object.keys(details.get('ENG-6')), ['number', 'unavailable']);
  assert.equal(typeof details.get('ENG-6').unavailable, 'string');

  const rateLimit = Object.assign(new Error('Linear\'s API rate limit stopped the request; nothing further was sent'), { rateLimited: true });
  const limitedCalls = [];
  const limited = (query, variables) => {
    limitedCalls.push(variables);
    if (variables.id === 'ENG-2' && variables.after === 'p1') throw rateLimit;
    if (variables.id === 'ENG-2') return answer(variables, cardPage('ENG-2', ['first'], 'p1'));
    return answer(variables, cardPage(variables.id, [`note on ${variables.id}`]));
  };
  const read = resultOf(() => linearCardDetails(limited, ['ENG-1', 'ENG-2', 'ENG-3']), 'a rate limit');

  assert.deepEqual([...read.keys()], ['ENG-1', 'ENG-2', 'ENG-3']);
  assert.deepEqual(read.get('ENG-1'), whole('ENG-1', ['note on ENG-1']));
  assert.deepEqual(read.get('ENG-2'), { number: 'ENG-2', unavailable: rateLimit.message });
  assert.deepEqual(read.get('ENG-3'), { number: 'ENG-3', unavailable: rateLimit.message });
  assert.deepEqual(limitedCalls, [{ id: 'ENG-1', after: null }, { id: 'ENG-2', after: null }, { id: 'ENG-2', after: 'p1' }]);
});

// A Linear that holds each card in a current state and answers an update with the state it was asked
// for (or `confirm`'s), as the schema's `issueUpdate(id, input: { stateId })` returns the updated issue.
// A card answers under its own identifier in team ENG, except for what `answers` sets for it.
function mover(current, { confirm = (stateId) => TEAM_STATES.find((candidate) => candidate.id === stateId), answers = {} } = {}) {
  const calls = [];
  const exec = (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('teams(')) return TEAM;
    if (query.includes('issueUpdate')) return { issueUpdate: { issue: { id: variables.id, state: confirm(variables.stateId) } } };
    return { issue: { id: `id-${variables.id}`, identifier: variables.id, team: { key: 'ENG' }, state: current[variables.id], ...answers[variables.id] } };
  };
  const writes = () => calls.filter(({ query }) => query.includes('issueUpdate')).map(({ variables }) => variables);
  const reads = () => calls.filter(({ query }) => !query.includes('teams(') && !query.includes('issueUpdate')).map(({ variables }) => variables.id);
  return { exec, calls, writes, reads };
}

test('moveLinearCards writes a target state by state id, confirms the written state and writes nothing for a card already there', async (t) => {
  const { moveLinearCards } = await loadReader(t);
  const { exec, calls, writes } = mover({ 'ENG-3': TODO, 'ENG-4': PROGRESS, 'ENG-8': BACKLOG });

  const completed = resultOf(() => moveLinearCards([
    { issueNumber: 'ENG-3', statusName: 'In progress' },
    { issueNumber: 'ENG-4', statusName: 'In progress' },
    { issueNumber: 'ENG-8', statusName: 'ready' },
  ], exec), 'moves to a mapped column');

  assert.deepEqual(completed, [
    { issueNumber: 'ENG-3', statusName: 'In progress', skipped: false },
    { issueNumber: 'ENG-4', statusName: 'In progress', skipped: true },
    { issueNumber: 'ENG-8', statusName: 'Ready', skipped: false },
  ]);
  // ENG-4 was already In Progress, so only the other two cards were written, each by the issue's id and the state's id.
  assert.deepEqual(writes(), [{ id: 'id-ENG-3', stateId: 's-progress' }, { id: 'id-ENG-8', stateId: 's-todo' }]);
  assert.equal(calls.filter(({ query }) => query.includes('teams(')).length, 1);

  // A write Linear answers with another state fails, naming the move that failed and those already done.
  const wrong = mover({ 'ENG-3': TODO, 'ENG-8': BACKLOG }, { confirm: (stateId) => (stateId === 's-todo' ? DONE : TEAM_STATES.find((candidate) => candidate.id === stateId)) });
  const { message } = refusalOf(() => moveLinearCards([
    { issueNumber: 'ENG-3', statusName: 'In progress' },
    { issueNumber: 'ENG-8', statusName: 'Ready' },
  ], wrong.exec), 'a write confirmed in another state');
  assert.match(message, /failed to move ENG-8 → "Ready" \(already completed: ENG-3 → In progress\)/);
  assert.match(message, /"Done"/);

  // An unknown column and a malformed identifier fail before any write.
  const none = mover({ 'ENG-3': TODO });
  assert.match(refusalOf(() => moveLinearCards([{ issueNumber: 'ENG-3', statusName: 'Parked' }], none.exec), 'an unknown column').message, /unknown Status "Parked" — valid options: Backlog, Ready/);
  assert.match(refusalOf(() => moveLinearCards([{ issueNumber: '3', statusName: 'Ready' }], none.exec), 'a bare number').message, /invalid issue ID: 3/);
  assert.deepEqual(none.writes(), []);
});

// What a run throws, or null when it comes back: the writes made are asserted before the throw, so a card
// written when it must not be fails on the write that was made.
function thrownBy(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

test('moveLinearCards never writes In review or Done: a card Linear moved there is a checked no-op, and one it has not moved after six reads fails naming the automation rule, with nothing written', async (t) => {
  const { moveLinearCards } = await loadReader(t);
  const REVIEW = TEAM_STATES.find((candidate) => candidate.id === 's-review');
  const FIVE_PAUSES = [5000, 5000, 5000, 5000, 5000];

  // A pull request marked ready that Linear has not yet moved: the card is read six times, five pauses of
  // five seconds between the reads, and then the move fails. Nothing is written for In review.
  const unstarted = mover({ 'ENG-3': PROGRESS });
  const pauses = [];
  const startFailure = thrownBy(() => moveLinearCards([{ issueNumber: 'ENG-3', statusName: 'In review' }], unstarted.exec, (ms) => pauses.push(ms)));
  assert.deepEqual(unstarted.writes(), [], 'In review is never written');
  assert.ok(startFailure, 'a card Linear has not moved to In review fails');
  assert.deepEqual(unstarted.reads(), Array(6).fill('ENG-3'));
  assert.deepEqual(pauses, FIVE_PAUSES);
  assert.match(startFailure.message, /failed to move ENG-3 → "In review" \(already completed: none\)/);
  assert.match(startFailure.message, /In Progress/);
  assert.match(startFailure.message, /start/);
  assert.match(startFailure.message, /nothing was written/i);

  // The same for Done, naming the rule that merges.
  const unmerged = mover({ 'ENG-4': REVIEW });
  const mergePauses = [];
  const mergeFailure = thrownBy(() => moveLinearCards([{ issueNumber: 'ENG-4', statusName: 'Done' }], unmerged.exec, (ms) => mergePauses.push(ms)));
  assert.deepEqual(unmerged.writes(), [], 'Done is never written');
  assert.ok(mergeFailure, 'a card Linear has not moved to Done fails');
  assert.deepEqual(unmerged.reads(), Array(6).fill('ENG-4'));
  assert.deepEqual(mergePauses, FIVE_PAUSES);
  assert.match(mergeFailure.message, /In Review/);
  assert.match(mergeFailure.message, /merge/);
  assert.match(mergeFailure.message, /nothing was written/i);

  // A card Linear has already moved there is a checked no-op: one read each, no pause and no write.
  const there = mover({ 'ENG-3': REVIEW, 'ENG-4': DONE });
  const idle = [];
  const checked = resultOf(() => moveLinearCards([
    { issueNumber: 'ENG-3', statusName: 'In review' },
    { issueNumber: 'ENG-4', statusName: 'Done' },
  ], there.exec, (ms) => idle.push(ms)), 'cards Linear already moved');
  assert.deepEqual(checked.map(({ issueNumber, statusName, checked: isChecked, movedBy }) => ({ issueNumber, statusName, isChecked, movedBy })), [
    { issueNumber: 'ENG-3', statusName: 'In review', isChecked: true, movedBy: 'Linear' },
    { issueNumber: 'ENG-4', statusName: 'Done', isChecked: true, movedBy: 'Linear' },
  ]);
  assert.deepEqual(there.writes(), []);
  assert.deepEqual(there.reads(), ['ENG-3', 'ENG-4']);
  assert.deepEqual(idle, []);

  // A card Linear moves while the read waits is accepted at the read that sees it, with no further wait.
  const current = { 'ENG-3': PROGRESS };
  const late = mover(current);
  const waits = [];
  const accepted = resultOf(() => moveLinearCards([{ issueNumber: 'ENG-3', statusName: 'In review' }], late.exec, (ms) => {
    waits.push(ms);
    if (waits.length === 2) current['ENG-3'] = REVIEW;
  }), 'a card Linear moves during the wait');
  assert.equal(accepted[0].checked, true);
  assert.equal(accepted[0].movedBy, 'Linear');
  assert.deepEqual(late.reads(), ['ENG-3', 'ENG-3', 'ENG-3']);
  assert.deepEqual(waits, [5000, 5000]);
  assert.deepEqual(late.writes(), []);
});

test('moveLinearCards refuses a card of another team or one whose identifier changed, before any write, naming the moves already completed', async (t) => {
  const { moveLinearCards } = await loadReader(t);

  // A card of another team is refused with both team keys named; the card before it was written.
  const foreign = mover({ 'ENG-1': BACKLOG, 'ENG-2': TODO, 'ENG-3': TODO }, { answers: { 'ENG-2': { team: { key: 'OPS' } } } });
  const teamFailure = thrownBy(() => moveLinearCards([
    { issueNumber: 'ENG-1', statusName: 'Ready' },
    { issueNumber: 'ENG-2', statusName: 'In progress' },
    { issueNumber: 'ENG-3', statusName: 'In progress' },
  ], foreign.exec));
  assert.deepEqual(foreign.writes(), [{ id: 'id-ENG-1', stateId: 's-todo' }], 'only the card before the foreign one is written');
  assert.ok(teamFailure, 'a card of another team is refused');
  assert.match(teamFailure.message, /failed to move ENG-2 → "In progress" \(already completed: ENG-1 → Ready\)/);
  const [, teamReason] = teamFailure.message.split(') — ');
  assert.match(teamReason, /OPS/);
  assert.match(teamReason, /ENG(?!-)/);

  // A card answering under another identifier (moved within the team's numbering, or to another team) is refused with both named.
  const renamed = mover({ 'ENG-5': TODO }, { answers: { 'ENG-5': { identifier: 'ENG-77' } } });
  const identifierFailure = thrownBy(() => moveLinearCards([{ issueNumber: 'ENG-5', statusName: 'In progress' }], renamed.exec));
  assert.deepEqual(renamed.writes(), [], 'a card under another identifier is never written');
  assert.ok(identifierFailure, 'a card whose identifier changed is refused');
  assert.match(identifierFailure.message, /failed to move ENG-5 → "In progress" \(already completed: none\)/);
  const [, identifierReason] = identifierFailure.message.split(') — ');
  assert.match(identifierReason, /ENG-5/);
  assert.match(identifierReason, /ENG-77/);
});
