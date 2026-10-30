// Native Jira card transcripts: writes and expected rows are literal contract examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyToolkit } from './board-toolkit-copy.mjs';

const SITE = 'https://example.atlassian.net';
const CONFIG = { site: SITE, project: 'ENG', states: { Backlog: '10', Ready: '11', 'In progress': '12', 'Awaiting push': '13', 'In review': '14', Done: '15' }, issueTypes: { epic: '10001', feature: '10002', task: '10002', bug: '10002', docs: '10002' }, blockLinkType: '10003' };
const CONFIG_SOURCE = `
export const BOARD_OWNER = 'example-owner';
export const BOARD_OWNER_TYPE = 'user';
export const BOARD_REPOSITORY = 'example-repo';
export const BOARD_PROJECT_NUMBER = null;
export const ROUTING_FIELD = null;
export const ROUTING_OPTIONS = [];
export const PARKED_LANE = null;
export const TRACKER = 'jira';
export const STATUS_OPTIONS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
export const PICKABLE_STATUSES = ['Backlog', 'Ready'];
export const WAIT_STATUSES = ['Awaiting push'];
export const TERMINAL_STATUSES = ['Done'];
export const KIND_LABELS = { epic: 'epic', feature: 'enhancement', task: 'task', bug: 'bug', docs: 'documentation' };
export const JIRA_CONFIG = ${JSON.stringify(CONFIG)};
`;
const STATES = [
  { id: '10', name: 'Backlog', statusCategory: { key: 'new' } }, { id: '11', name: 'Ready', statusCategory: { key: 'new' } },
  { id: '12', name: 'In progress', statusCategory: { key: 'indeterminate' } }, { id: '13', name: 'Awaiting push', statusCategory: { key: 'indeterminate' } },
  { id: '14', name: 'In review', statusCategory: { key: 'indeterminate' } }, { id: '15', name: 'Done', statusCategory: { key: 'done' } },
];
const PROJECT = { id: '10000', key: 'ENG', issueTypes: [{ id: '10001', hierarchyLevel: 1 }, { id: '10002', hierarchyLevel: 0 }] };
const ADF = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Acceptance text' }] }] };
const MULTILINE = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'literal **source**' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }] }] };
const PARENT = { id: '20001', key: 'ENG-1', fields: { project: { id: '10000', key: 'ENG' }, summary: 'Parent', status: STATES[1], issuetype: { id: '10001' }, labels: ['epic'], assignee: null, parent: null, issuelinks: [], description: ADF } };
const CARD = { id: '20002', key: 'ENG-2', fields: { project: { id: '10000', key: 'ENG' }, summary: 'Jira tracer', status: STATES[1], issuetype: { id: '10002' }, labels: ['task'], assignee: null, parent: { id: '20001', key: 'ENG-1' }, issuelinks: [], description: ADF } };
const OWN = { id: '30001', created: '2026-01-01T00:00:00.000Z', author: { accountId: 'acct-self', displayName: 'Same name' }, body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Claim: test, Codex, 2026-01-01T00:00Z' }] }] } };
const OTHER = { id: '30002', created: '2026-01-02T00:00:00.000Z', author: { accountId: 'acct-other', displayName: 'Same name' }, body: ADF };
const CREATE_FIELDS = [
  { fieldId: 'project', required: true, hasDefaultValue: false }, { fieldId: 'issuetype', required: true, hasDefaultValue: false }, { fieldId: 'summary', required: true, hasDefaultValue: false },
  { fieldId: 'description', required: false, hasDefaultValue: false }, { fieldId: 'labels', required: false, hasDefaultValue: false }, { fieldId: 'parent', required: false, hasDefaultValue: false },
  { fieldId: 'customfield_10100', required: true, hasDefaultValue: true },
];
const clone = (value) => structuredClone(value);
const changed = (fields) => ({ ...clone(CARD), fields: { ...clone(CARD.fields), ...fields } });
const LINK = { id: '40001', type: { id: '10003' }, inwardIssue: { id: '20001', key: 'ENG-1' } };

// Reads have fixed native routes. Each mutation must match the next literal step; only its declared
// post-read issue/comments change. There is no provider fallback or request-derived simulator.
function native(options = {}) {
  const issues = { 'ENG-1': clone(options.parent ?? PARENT), ...(options.withoutTarget ? {} : { 'ENG-2': clone(options.card ?? CARD) }) };
  let comments = clone(options.comments ?? [OTHER, OWN]);
  const steps = [...(options.steps ?? [])];
  const calls = [];
  const writes = [];
  const exec = (request) => {
    calls.push(clone(request));
    const { method, path, query = {} } = request;
    if (method !== 'GET') {
      writes.push(clone(request));
      const step = steps.shift();
      assert.ok(step, 'unanticipated Jira mutation: ' + JSON.stringify(request));
      assert.deepEqual(request, step.request);
      if (step.error) throw step.error;
      for (const [key, issue] of Object.entries(step.issues ?? {})) issues[key] = clone(issue);
      if (step.comments) comments = clone(step.comments);
      return clone(step.response ?? null);
    }
    if (path === '/rest/api/3/project/ENG') return clone(PROJECT);
    if (path === '/rest/api/3/project/ENG/statuses') return clone([{ id: '10001', statuses: STATES }, { id: '10002', statuses: STATES }]);
    if (path === '/rest/api/3/issueLinkType') return { issueLinkTypes: [{ id: '10003', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] };
    if (path === '/rest/api/3/myself') return { accountId: 'acct-self', displayName: 'Same name' };
    if (path === '/rest/api/3/search/jql') {
      assert.equal(query.jql, 'project = ENG ORDER BY key ASC');
      assert.equal(query.fields, 'summary,status,project,issuetype,labels,assignee,parent,issuelinks,description');
      return { issues: clone(Object.values(issues)), isLast: true, total: Object.keys(issues).length };
    }
    if (path === '/rest/api/3/issue/createmeta/ENG/issuetypes/10002') {
      assert.equal(query.maxResults, 100);
      const fields = options.createFields ?? CREATE_FIELDS;
      return { fields: clone(fields.slice(query.startAt, query.startAt + 3)), startAt: query.startAt, maxResults: 3, total: fields.length };
    }
    const target = /^\/rest\/api\/3\/issue\/(ENG-[12])(?:\/(editmeta|transitions|comment))?$/.exec(path);
    if (!target || !issues[target[1]]) throw new Error('unanticipated Jira read: ' + JSON.stringify(request));
    if (!target[2]) return clone(issues[target[1]]);
    if (target[2] === 'editmeta') return clone(options.editmeta ?? { fields: { summary: { operations: ['set'] }, description: { operations: ['set'] }, parent: { operations: ['set'] } } });
    if (target[2] === 'transitions') return clone(options.transitions?.[target[1]] ?? { transitions: [{ id: '21', to: STATES[1], fields: {} }] });
    if (options.commentFailure && query.startAt > 0) throw new Error('later comment page failed');
    return { comments: clone(comments.slice(query.startAt, query.startAt + 1)), startAt: query.startAt, maxResults: 1, total: comments.length };
  };
  return { exec, calls, writes, remaining: () => steps.length };
}
const transition = { method: 'POST', path: '/rest/api/3/issue/ENG-2/transitions', body: { transition: { id: '21' } } };
const createRequest = { method: 'POST', path: '/rest/api/3/issue', body: { fields: { project: { id: '10000' }, issuetype: { id: '10002' }, summary: 'Jira tracer', description: ADF, labels: ['task'], parent: { id: '20001' } } } };
const CREATED = changed({ status: STATES[0] });

test('Jira card operations preserve ownership links and partial-write evidence', async (t) => {
  const toolkit = copyToolkit(CONFIG_SOURCE);
  t.after(toolkit.cleanup);
  const { main } = await toolkit.load('jira-card.mjs');
  const { parseCardArgs, runCardCommand } = await toolkit.load('lib/jira-card.mjs');
  const { moveJiraCards } = await toolkit.load('lib/board-jira.mjs');
  const body = join(toolkit.root, 'body.md');
  const multiline = join(toolkit.root, 'multiline.md');
  writeFileSync(body, 'Acceptance text');
  writeFileSync(multiline, 'literal **source**\nsecond line');
  const run = (args, provider) => {
    const rows = [];
    const errors = [];
    const status = main(args, { jiraExec: provider.exec, output: { log: (line) => rows.push(JSON.parse(line)), error: (line) => errors.push(line) } });
    return { status, rows, errors };
  };
  const success = (args, provider, expected) => {
    const result = run(args, provider);
    assert.equal(result.status, 0, result.errors.join('\n'));
    assert.deepEqual(result.rows, expected);
    assert.deepEqual(result.errors, []);
    assert.equal(provider.remaining(), 0);
    return result;
  };
  const failure = (args, provider, cause) => {
    const result = run(args, provider);
    assert.equal(result.status, 1);
    assert.deepEqual(result.rows, []);
    assert.match(result.errors.join('\n'), cause);
    return result;
  };
  const createArgs = ['create', '--title', 'Jira tracer', '--body-file', body, '--status', 'Ready', '--kind', 'task', '--parent', 'ENG-1'];
  assert.deepEqual(parseCardArgs(['edit-comment', 'ENG-2', '30001', '--body', 'changed']), { name: 'edit-comment', id: 'ENG-2', commentId: '30001', body: { text: 'changed' } });
  for (const args of [[], ['unknown'], ['view'], ['view', '2'], ['view', 'ENG-2', '--unknown'], ['comment', 'ENG-2'], ['edit-comment', 'ENG-2', '0', '--body', 'x'], ['comment', 'ENG-2', '--body', 'x', '--body-file', body]]) {
    const provider = native();
    const result = run(args, provider);
    assert.equal(result.status, 2);
    assert.deepEqual(result.rows, []);
    assert.match(result.errors.join('\n'), /usage:/);
    assert.equal(provider.calls.length, 0);
  }
  success(['view', 'ENG-2'], native({ card: changed({ assignee: { accountId: 'acct-self', displayName: 'Same name' } }) }), [
    ['state', 'OPEN'], ['assignees', ['acct-self']], ['viewer', 'acct-self'],
    ['claim', 1, 'acct-self', '2026-01-01T00:00:00.000Z', SITE + '/browse/ENG-2?focusedCommentId=30001', 'Claim: test, Codex, 2026-01-01T00:00Z', '30001'], ['comments', 2],
  ]);
  success(['view', 'ENG-2', '--board'], native(), [['board', 'jira', 'ENG', 'Ready'], ['boards', 1]]);
  success(['text', 'ENG-2'], native({ card: changed({ issuelinks: [LINK] }) }), [
    ['title', 'Jira tracer'], ['body', 'Acceptance text'], ['parent', 'ENG-1'], ['blockedBy', ['ENG-1']],
    ['comment', 1, 'acct-self', '2026-01-01T00:00:00.000Z', SITE + '/browse/ENG-2?focusedCommentId=30001', 'Claim: test, Codex, 2026-01-01T00:00Z'],
    ['comment', 2, 'acct-other', '2026-01-02T00:00:00.000Z', SITE + '/browse/ENG-2?focusedCommentId=30002', 'Acceptance text'],
  ]);
  failure(['view', 'ENG-2'], native({ commentFailure: true }), /later comment page failed/);
  const ownAssigned = changed({ assignee: { accountId: 'acct-self', displayName: 'Same name' } });
  for (const name of ['assign', 'unassign']) {
    const other = native({ card: changed({ assignee: { accountId: 'acct-other', displayName: 'Same name' } }) });
    failure([name, 'ENG-2'], other, /held|another account|owner/i);
    assert.equal(other.writes.length, 0);
  }
  success(['assign', 'ENG-2'], native({ steps: [{ request: { method: 'PUT', path: '/rest/api/3/issue/ENG-2/assignee', body: { accountId: 'acct-self' } }, issues: { 'ENG-2': ownAssigned } }] }), [['assignees', ['acct-self']]]);
  success(['unassign', 'ENG-2'], native({ card: ownAssigned, steps: [{ request: { method: 'PUT', path: '/rest/api/3/issue/ENG-2/assignee', body: { accountId: null } }, issues: { 'ENG-2': CARD } }] }), [['assignees', []]]);
  success(['assign', 'ENG-2'], native({ card: ownAssigned }), [['no-op']]);
  success(['unassign', 'ENG-2'], native(), [['no-op']]);
  const commentBody = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New comment' }] }] };
  const added = { ...clone(OWN), id: '30003', body: commentBody };
  success(['comment', 'ENG-2', '--body', 'New comment'], native({ steps: [{ request: { method: 'POST', path: '/rest/api/3/issue/ENG-2/comment', body: { body: commentBody } }, response: { id: '30003' }, comments: [OWN, OTHER, added] }] }), [['comment', '30003', SITE + '/browse/ENG-2?focusedCommentId=30003']]);
  success(['edit-comment', 'ENG-2', '30001', '--body', 'New comment'], native({ steps: [{ request: { method: 'PUT', path: '/rest/api/3/issue/ENG-2/comment/30001', body: { body: commentBody } }, response: { id: '30001' }, comments: [{ ...clone(OWN), body: commentBody }, OTHER] }] }), [['comment', '30001', SITE + '/browse/ENG-2?focusedCommentId=30001']]);
  const otherComment = native();
  failure(['edit-comment', 'ENG-2', '30002', '--body', 'x'], otherComment, /author|another account/i);
  assert.equal(otherComment.writes.length, 0);
  const edited = changed({ summary: 'Changed', description: MULTILINE });
  success(['edit', 'ENG-2', '--title', 'Changed', '--body-file', multiline], native({ steps: [{ request: { method: 'PUT', path: '/rest/api/3/issue/ENG-2', body: { fields: { summary: 'Changed', description: MULTILINE } } }, issues: { 'ENG-2': edited } }] }), [['edited', 'ENG-2']]);
  failure(['edit', 'ENG-2', '--title', 'Changed'], native({ steps: [{ request: { method: 'PUT', path: '/rest/api/3/issue/ENG-2', body: { fields: { summary: 'Changed' } } } }] }), /read.back|confirm|summary/i);
  const metadataRefusal = native({ editmeta: { fields: {} } });
  failure(['edit', 'ENG-2', '--title', 'Changed'], metadataRefusal, /metadata|editable|summary/i);
  assert.equal(metadataRefusal.writes.length, 0);
  success(['parent', 'ENG-2', '--to', 'ENG-1'], native({ card: changed({ parent: null }), steps: [{ request: { method: 'PUT', path: '/rest/api/3/issue/ENG-2', body: { fields: { parent: { id: '20001' } } } }, issues: { 'ENG-2': CARD } }] }), [['parent', 'ENG-2', 'ENG-1']]);
  const nonEpic = native({ parent: { ...clone(PARENT), fields: { ...clone(PARENT.fields), issuetype: { id: '10002' } } } });
  failure(['parent', 'ENG-2', '--to', 'ENG-1'], nonEpic, /hierarchy|epic/i);
  assert.equal(nonEpic.writes.length, 0);
  const linkRequest = { method: 'POST', path: '/rest/api/3/issueLink', body: { type: { id: '10003' }, inwardIssue: { key: 'ENG-1' }, outwardIssue: { key: 'ENG-2' } } };
  success(['block', 'ENG-2', '--by', 'ENG-1'], native({ steps: [{ request: linkRequest, issues: { 'ENG-2': changed({ issuelinks: [LINK] }) } }] }), [['block', 'ENG-2', 'ENG-1']]);
  failure(['block', 'ENG-2', '--by', 'ENG-1'], native({ steps: [{ request: linkRequest }] }), /read.back|confirm|block/i);
  const foreign = native({ card: changed({ project: { id: '99999', key: 'ENG' } }) });
  failure(['assign', 'ENG-2'], foreign, /project/i);
  assert.equal(foreign.writes.length, 0);
  for (const command of [{ name: 'parent', id: 'ENG-2', to: 'ENG-2' }, { name: 'block', id: 'ENG-2', by: 'ENG-2' }]) {
    const self = native();
    assert.throws(() => runCardCommand(command, self.exec), /self|itself/i);
    assert.equal(self.writes.length, 0);
  }
  const foreignParent = native();
  failure(['parent', 'ENG-2', '--to', 'OPS-1'], foreignParent, /project|outside/i);
  assert.equal(foreignParent.writes.length, 0);
  failure(['assign', 'ENG-2'], native({ steps: [{ request: { method: 'PUT', path: '/rest/api/3/issue/ENG-2/assignee', body: { accountId: 'acct-self' } } }] }), /read.back|confirm|assignee/i);
  failure(['edit-comment', 'ENG-2', '30001', '--body', 'New comment'], native({ steps: [{ request: { method: 'PUT', path: '/rest/api/3/issue/ENG-2/comment/30001', body: { body: commentBody } }, response: { id: '30001' } }] }), /read.back|confirm|comment/i);
  const creates = () => [{ request: createRequest, response: { id: '20002', key: 'ENG-2' }, issues: { 'ENG-2': CREATED } }, { request: transition, issues: { 'ENG-2': CARD } }];
  const filed = native({ withoutTarget: true, steps: creates() });
  success(createArgs, filed, [['created', 'ENG-2']]);
  assert.deepEqual(filed.writes, [createRequest, transition]);
  const required = native({ withoutTarget: true, createFields: [...CREATE_FIELDS, { fieldId: 'customfield_10999', required: true, hasDefaultValue: false }] });
  failure(createArgs, required, /customfield_10999.*required|required.*customfield_10999/i);
  assert.equal(required.writes.length, 0);
  const duplicate = native();
  failure(createArgs, duplicate, /title|already|preflight/i);
  assert.equal(duplicate.writes.length, 0);
  const partialSteps = creates();
  partialSteps[1].error = new Error('transition denied');
  const partial = native({ withoutTarget: true, steps: partialSteps });
  failure(createArgs, partial, /created ENG-2.*transition denied/s);
  assert.equal(partial.writes.length, 2);
  const blockPartial = native({ withoutTarget: true, steps: [...creates(), { request: linkRequest, error: new Error('link denied') }] });
  const blockFailure = failure([...createArgs, '--blocked-by', 'ENG-1'], blockPartial, /created ENG-2.*link denied/s);
  assert.match(blockFailure.errors.join('\n'), /ENG-1/);
  assert.equal(blockPartial.writes.length, 3);
  const uncertain = native({ withoutTarget: true, steps: [{ request: createRequest, error: new Error('connection reset after send') }] });
  const unknown = failure(createArgs, uncertain, /outcome.*unknown|unknown.*outcome/i);
  assert.match(unknown.errors.join('\n'), /inspect.*retry/s);
  assert.equal(uncertain.writes.length, 1);
  const requiredTransition = native({ card: CREATED, transitions: { 'ENG-2': { transitions: [{ id: '21', to: STATES[1], fields: { customfield_10999: { required: true, hasDefaultValue: false } } }] } } });
  assert.throws(() => moveJiraCards([{ issueNumber: 'ENG-2', statusName: 'Ready' }], requiredTransition.exec), /required|customfield_10999/i);
  assert.equal(requiredTransition.writes.length, 0);
  const ambiguous = native({ card: CREATED, transitions: { 'ENG-2': { transitions: [{ id: '21', to: STATES[1], fields: {} }, { id: '22', to: STATES[1], fields: {} }] } } });
  assert.throws(() => moveJiraCards([{ issueNumber: 'ENG-2', statusName: 'Ready' }], ambiguous.exec), /one|unique|ambiguous/i);
  assert.equal(ambiguous.writes.length, 0);
  const noop = native();
  assert.deepEqual(moveJiraCards([{ issueNumber: 'ENG-2', statusName: 'Ready' }], noop.exec), [{ issueNumber: 'ENG-2', statusName: 'Ready', skipped: true }]);
  assert.equal(noop.writes.length, 0);
  const badReadback = native({ card: CREATED, steps: [{ request: transition }] });
  assert.throws(() => moveJiraCards([{ issueNumber: 'ENG-2', statusName: 'Ready' }], badReadback.exec), /read.back|confirm|status/i);
  const batch = native({ parent: { ...clone(PARENT), fields: { ...clone(PARENT.fields), status: STATES[0] } }, card: CREATED, transitions: { 'ENG-2': { transitions: [] } }, steps: [{ request: { ...clone(transition), path: '/rest/api/3/issue/ENG-1/transitions' }, issues: { 'ENG-1': PARENT } }] });
  assert.throws(() => moveJiraCards([{ issueNumber: 'ENG-1', statusName: 'Ready' }, { issueNumber: 'ENG-2', statusName: 'Ready' }], batch.exec), /completed.*ENG-1.*Ready/i);
  assert.equal(batch.writes.length, 1);
  assert.deepEqual(runCardCommand(parseCardArgs(['unassign', 'ENG-2']), native().exec), [['no-op']]);
});

test('Jira moves request transition field metadata before writing', async (t) => {
  const toolkit = copyToolkit(CONFIG_SOURCE);
  t.after(toolkit.cleanup);
  const { moveJiraCards } = await toolkit.load('lib/board-jira.mjs');
  const provider = native({ card: CREATED, steps: [{ request: transition, issues: { 'ENG-2': CARD } }] });
  const exec = (request) => {
    const response = provider.exec(request);
    if (request.method !== 'GET' || request.path !== '/rest/api/3/issue/ENG-2/transitions') return response;
    // Jira includes field metadata only when this native expansion is requested.
    if (request.query?.expand === 'transitions.fields') return response;
    return { transitions: response.transitions.map(({ id, to }) => ({ id, to })) };
  };
  assert.deepEqual(moveJiraCards([{ issueNumber: 'ENG-2', statusName: 'Ready' }], exec), [{ issueNumber: 'ENG-2', statusName: 'Ready', skipped: false }]);
  assert.equal(provider.calls.find(({ method, path }) => method === 'GET' && path.endsWith('/transitions')).query.expand, 'transitions.fields');
  assert.deepEqual(provider.writes, [transition]);
  assert.equal(provider.remaining(), 0);
});

test('Jira create refuses mismatched field read-backs', async (t) => {
  const toolkit = copyToolkit(CONFIG_SOURCE);
  t.after(toolkit.cleanup);
  const { main } = await toolkit.load('jira-card.mjs');
  const body = join(toolkit.root, 'body.md');
  writeFileSync(body, 'Acceptance text');
  const args = ['create', '--title', 'Jira tracer', '--body-file', body, '--status', 'Ready', '--kind', 'task', '--parent', 'ENG-1'];
  const run = (card, expectedReads) => {
    const provider = native({ withoutTarget: true, steps: [{ request: createRequest, response: { id: '20002', key: 'ENG-2' }, issues: { 'ENG-2': card } }] });
    const rows = [];
    const errors = [];
    const status = main(args, { jiraExec: provider.exec, output: { log: (line) => rows.push(JSON.parse(line)), error: (line) => errors.push(line) } });
    assert.deepEqual(provider.writes, [createRequest], 'one create POST and no retry or follow-on write');
    assert.equal(provider.remaining(), 0);
    assert.equal(provider.calls.filter(({ method, path }) => method === 'GET' && path === '/rest/api/3/issue/ENG-2').length, expectedReads);
    return { status, rows, errors };
  };
  assert.deepEqual(run(CARD, 2), { status: 0, rows: [['created', 'ENG-2']], errors: [] });
  const mismatches = [
    ['id', { ...clone(CARD), id: '20003' }],
    ['summary', changed({ summary: 'Different title' })],
    ['description', changed({ description: MULTILINE })],
    ['kind', changed({ issuetype: { id: '10001' } })],
    ['labels', changed({ labels: ['bug'] })],
    ['parent id', changed({ parent: { id: '20099', key: 'ENG-1' } })],
    ['parent key', changed({ parent: { id: '20001', key: 'ENG-9' } })],
  ];
  for (const [field, card] of mismatches) {
    const result = run(card, 1);
    assert.equal(result.status, 1, field);
    assert.deepEqual(result.rows, [], field);
    assert.equal(result.errors.length, 1, field);
    assert.match(result.errors[0], /created ENG-2 \(id 20002\), then remaining work failed: created issue read-back does not confirm intended fields/, field);
    assert.match(result.errors[0], /do not rerun create/, field);
  }
});

test('Jira native snapshots refuse missing issue titles and descriptions', async (t) => {
  const toolkit = copyToolkit(CONFIG_SOURCE);
  t.after(toolkit.cleanup);
  const { main } = await toolkit.load('jira-card.mjs');
  const { jiraCardDetails } = await toolkit.load('lib/board-jira.mjs');
  const snapshot = (card) => {
    const provider = native({ card });
    const rows = [];
    const errors = [];
    const status = main(['text', 'ENG-2'], { jiraExec: provider.exec, output: {
      log: (line) => rows.push(JSON.parse(line)), error: (line) => errors.push(line),
    } });
    assert.deepEqual(provider.writes, []);
    return { status, rows, errors };
  };
  for (const description of [null, { type: 'doc', version: 1, content: [] }]) {
    const card = changed({ description });
    delete card.fields.parent;
    const result = snapshot(card);
    assert.equal(result.status, 0, result.errors.join('\n'));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.rows.find(([name]) => name === 'title'), ['title', 'Jira tracer']);
    assert.deepEqual(result.rows.find(([name]) => name === 'body'), ['body', '']);
    assert.deepEqual(result.rows.find(([name]) => name === 'parent'), ['parent', null]);
    const details = jiraCardDetails(native({ card }).exec, ['ENG-2']).get('ENG-2');
    assert.equal(details.unavailable, undefined);
    assert.equal(details.body, '');
    assert.equal(details.parent, null);
  }

  const missingSummary = clone(CARD);
  delete missingSummary.fields.summary;
  const missingDescription = clone(CARD);
  delete missingDescription.fields.description;
  const incomplete = [
    ['missing summary', missingSummary, /summary|title/i],
    ...[undefined, null, 42, '', ' \t'].map((summary) => [
      'summary ' + String(summary), changed({ summary }), /summary|title/i,
    ]),
    ['missing description', missingDescription, /description|ADF/i],
    ['undefined description', changed({ description: undefined }), /description|ADF/i],
  ];
  for (const [label, card, cause] of incomplete) {
    const result = snapshot(card);
    assert.equal(result.status, 1, label + ' must refuse an incomplete native snapshot');
    assert.deepEqual(result.rows, [], label);
    assert.match(result.errors.join('\n'), cause, label);
    const details = jiraCardDetails(native({ card }).exec, ['ENG-2']).get('ENG-2');
    assert.equal(typeof details.unavailable, 'string', label);
    assert.match(details.unavailable, cause, label);
    assert.equal(details.body, undefined, label);
  }
});
