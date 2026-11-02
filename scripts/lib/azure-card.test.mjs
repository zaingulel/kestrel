// Independent native transcripts protect write policy without live credentials or child processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyToolkit, AZURE_TEST_CONFIG } from './board-toolkit-copy.mjs';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ROOT = `/${PROJECT}/_apis/wit`;
const URL = `https://dev.azure.com/example-org/${PROJECT}/_apis/wit/workitems/`;
const BEFORE = { id: 299, rev: 5, fields: { 'System.TeamProject': 'Native Project', 'System.WorkItemType': 'Task',
  'System.State': 'Ready', 'System.Title': 'Native task', 'System.Description': '<p>Full <a href="https://example.test/hidden">label</a></p>', 'System.Tags': 'task; retained' }, relations: [] };
const PARENT = { id: 297, rev: 8, fields: { 'System.TeamProject': 'Native Project', 'System.WorkItemType': 'Epic', 'System.State': 'Ready', 'System.Title': 'Parent', 'System.Tags': 'epic' }, relations: [] };
const BLOCKER = { ...BEFORE, id: 300 };
const COMMENT = { id: 71, workItemId: 299, version: 1, text: '<p>Claim: complete <a href="https://example.test/claim">label</a></p>', format: 'html', createdBy: { id: VIEWER }, createdDate: '2026-01-01T00:00:00Z' };
const SOURCE = 'Acceptance & <script>alert("literal")</script>\n[link](https://example.test/hidden?a=1&b=2)';
const HTML = '<pre>Acceptance &amp; &lt;script&gt;alert("literal")&lt;/script&gt;\n[link](https://example.test/hidden?a=1&amp;b=2)</pre>';
const STATE_PATCH = [{ op: 'test', path: '/rev', value: 5 }, { op: 'add', path: '/fields/System.State', value: 'Active' }];
const ACTIVE = { ...BEFORE, rev: 6, fields: { ...BEFORE.fields, 'System.State': 'Active' } };
const relation = (rel, id) => ({ rel: 'System.LinkTypes.' + rel, url: URL + id });

function native(options = {}) {
  const calls = [];
  let actual = false;
  let commentMutation = false;
  const exec = (request) => {
    calls.push(structuredClone(request));
    const { method, path } = request;
    if (method === 'GET') {
      if (path === '/_apis/projects/' + PROJECT) return { id: PROJECT, name: 'Native Project' };
      if (path === ROOT + '/workitemtypes') return { count: 4, value: ['Epic', 'User Story', 'Task', 'Bug'].map((name) => ({ name })) };
      if (/\/workitemtypes\/[^/]+\/states$/.test(path)) return { count: 6, value: [
        { name: 'New', category: 'Proposed' }, { name: 'Ready', category: 'Proposed' }, { name: 'Active', category: 'InProgress' },
        { name: 'Awaiting Push', category: 'Resolved' }, { name: 'In Review', category: 'Resolved' }, { name: 'Closed', category: 'Completed' },
      ] };
      if (path === '/_apis/wit/workitemrelationtypes') return { count: 4, value: [
        ['Hierarchy-Forward', 'Hierarchy-Reverse'], ['Hierarchy-Reverse', 'Hierarchy-Forward'], ['Dependency-Forward', 'Dependency-Reverse'], ['Dependency-Reverse', 'Dependency-Forward'],
      ].map(([name, opposite]) => ({ referenceName: 'System.LinkTypes.' + name, attributes: { enabled: true, directional: true, usage: 'workItemLink', oppositeEndReferenceName: 'System.LinkTypes.' + opposite } })) };
      if (path === '/_apis/profile/profiles/me') return { id: VIEWER, emailAddress: 'viewer@example.test' };
      if (path === ROOT + '/workitems/299/comments') return { count: 1, totalCount: 1, comments: [structuredClone(actual ? options.commentAfter ?? COMMENT : options.commentBefore ?? COMMENT)] };
      if (path === ROOT + '/workitems/297') return structuredClone(PARENT);
      if (path === ROOT + '/workitems/300') {
        if (options.failSecond) throw new Error('second card unavailable');
        return structuredClone(options.blocker ?? BLOCKER);
      }
      if (path === ROOT + '/workitems/299') {
        const item = actual && !commentMutation ? options.after ?? options.returned ?? ACTIVE : options.before ?? BEFORE;
        if (item instanceof Error) throw item;
        return structuredClone(item);
      }
      if (path === ROOT + '/workitems/301') {
        if (options.after instanceof Error) throw options.after;
        return structuredClone(options.after ?? options.returned);
      }
    }
    if (method === 'PATCH' || method === 'POST') {
      assert.ok(path === ROOT + '/workitems/299' || path === ROOT + '/workitems/$Task' || path === ROOT + '/workitems/299/comments' || path === ROOT + '/workitems/299/comments/71');
      if (options.patch) assert.deepEqual(request.body, options.patch);
      if (request.query?.validateOnly === true) {
        if (options.validation instanceof Error) throw options.validation;
        return structuredClone(options.validation ?? options.returned ?? ACTIVE);
      }
      actual = true;
      commentMutation = path.includes('/comments');
      if (options.failure) throw options.failure;
      return structuredClone(options.returned ?? ACTIVE);
    }
    throw new Error('unexpected native request ' + JSON.stringify(request));
  };
  return { exec, calls, writes: () => calls.filter(({ method }) => method === 'PATCH' || method === 'POST'), actual: () => actual };
}

test('Azure mutations preserve ownership revision and confirmed outcomes', async (t) => {
  const toolkit = copyToolkit(AZURE_TEST_CONFIG);
  t.after(toolkit.cleanup);
  const { parseCardArgs, runCardCommand } = await toolkit.load('lib/azure-card.mjs');
  const { moveAzureCards } = await toolkit.load('lib/board-azure.mjs');
  const body = join(toolkit.root, 'body.txt');
  writeFileSync(body, SOURCE);
  const command = (...args) => parseCardArgs(args);
  const invoke = (provider, ...args) => runCardCommand(command(...args), provider.exec);
  for (const args of [[], ['assign', '299'], ['assign', 'AB-0'], ['assign', 'AB-2147483648'], ['assign', 'AB-01'],
    ['edit', 'AB-299', '--title', 'a', '--title', 'b'], ['assign', 'AB-299', '--who', 'other'], ['comment', 'AB-299', '--body', 'inline'],
    ['edit', 'AB-299', '--title', '--body-file', body], ['parent', 'AB-299'], ['edit-comment', 'AB-299', '0', '--body-file', body],
    ['create', '--title', 'x', '--body-file', body, '--status', 'Ready', '--kind', 'task', '--blocked-by', 'AB-300,AB-300']]) assert.throws(() => command(...args));
  const unreadable = native();
  assert.throws(() => invoke(unreadable, 'edit', 'AB-299', '--body-file', join(toolkit.root, 'absent')), /body file/i);
  assert.equal(unreadable.calls.length, 0);

  const moved = native({ patch: STATE_PATCH });
  assert.deepEqual(moveAzureCards([{ issueNumber: 'AB-299', statusName: 'In progress' }], moved.exec), [{ issueNumber: 'AB-299', statusName: 'In progress', skipped: false }]);
  assert.deepEqual(moved.writes().map(({ query }) => query), [{ 'api-version': '7.1', validateOnly: true }, { 'api-version': '7.1' }]);
  const noopMove = native({ before: ACTIVE });
  assert.deepEqual(moveAzureCards([{ issueNumber: 'AB-299', statusName: 'In progress' }], noopMove.exec), [{ issueNumber: 'AB-299', statusName: 'In progress', skipped: true }]);
  assert.equal(noopMove.writes().length, 0);
  const conflict = native({ failure: new Error('HTTP 412 conflict'), patch: STATE_PATCH });
  assert.throws(() => moveAzureCards([{ issueNumber: 'AB-299', statusName: 'In progress' }], conflict.exec), /412.*no retry/i);
  assert.equal(conflict.writes().length, 2);
  const required = native({ validation: new Error('required field Custom.Required'), patch: STATE_PATCH });
  assert.throws(() => moveAzureCards([{ issueNumber: 'AB-299', statusName: 'In progress' }], required.exec), /validation.*process.*setup/i);
  assert.equal(required.actual(), false);
  for (const after of [BEFORE, { ...ACTIVE, id: 300 }, { ...ACTIVE, fields: { ...ACTIVE.fields, 'System.TeamProject': 'Foreign' } }, new Error('read unavailable')]) {
    const wrong = native({ after, patch: STATE_PATCH });
    assert.throws(() => moveAzureCards([{ issueNumber: 'AB-299', statusName: 'In progress' }], wrong.exec), /AB-299.*unconfirmed/i);
  }
  const batch = native({ patch: STATE_PATCH, failSecond: true });
  assert.throws(() => moveAzureCards([{ issueNumber: 'AB-299', statusName: 'In progress' }, { issueNumber: 'AB-300', statusName: 'In progress' }], batch.exec), /confirmed.*AB-299.*AB-300/i);

  const assigned = { ...BEFORE, rev: 6, fields: { ...BEFORE.fields, 'System.AssignedTo': { id: VIEWER, uniqueName: 'viewer@example.test' } } };
  const assignment = native({ returned: assigned, patch: [{ op: 'test', path: '/rev', value: 5 }, { op: 'add', path: '/fields/System.AssignedTo', value: 'viewer@example.test' }] });
  assert.deepEqual(invoke(assignment, 'assign', 'AB-299'), [['assigned', 'AB-299', VIEWER]]);
  const wrongPrincipal = native({ validation: { ...assigned, fields: { ...assigned.fields, 'System.AssignedTo': { id: OTHER } } } });
  assert.throws(() => invoke(wrongPrincipal, 'assign', 'AB-299'), /identity|assignee/i);
  assert.equal(wrongPrincipal.actual(), false);
  const wrongReadback = native({ returned: assigned, after: { ...assigned, fields: { ...assigned.fields, 'System.AssignedTo': { id: OTHER } } } });
  assert.throws(() => invoke(wrongReadback, 'assign', 'AB-299'), /unconfirmed/i);
  for (const operation of ['assign', 'unassign']) {
    const foreign = native({ before: { ...BEFORE, fields: { ...BEFORE.fields, 'System.AssignedTo': { id: OTHER, displayName: 'Same name' } } } });
    let error;
    try {
      invoke(foreign, operation, 'AB-299');
    } catch (caught) {
      error = caught;
    }
    assert.equal(foreign.writes().length, 0);
    assert.match(error.message, /another|ownership/i);
  }
  const self = native({ before: assigned });
  assert.deepEqual(invoke(self, 'assign', 'AB-299'), [['no-op']]);
  assert.equal(self.writes().length, 0);
  const none = native();
  assert.deepEqual(invoke(none, 'unassign', 'AB-299'), [['no-op']]);
  assert.equal(none.writes().length, 0);
  const cleared = { ...BEFORE, rev: 7 };
  const unassign = native({ before: assigned, returned: cleared, patch: [{ op: 'test', path: '/rev', value: 6 }, { op: 'add', path: '/fields/System.AssignedTo', value: '' }] });
  assert.deepEqual(invoke(unassign, 'unassign', 'AB-299'), [['unassigned', 'AB-299']]);

  const edited = { ...BEFORE, rev: 6, fields: { ...BEFORE.fields, 'System.Title': 'Changed', 'System.Description': HTML } };
  const editing = native({ returned: edited, patch: [{ op: 'test', path: '/rev', value: 5 }, { op: 'add', path: '/fields/System.Title', value: 'Changed' }, { op: 'add', path: '/fields/System.Description', value: HTML }] });
  assert.deepEqual(invoke(editing, 'edit', 'AB-299', '--title', 'Changed', '--body-file', body), [['edited', 'AB-299']]);
  const sameEdit = native();
  assert.deepEqual(invoke(sameEdit, 'edit', 'AB-299', '--title', 'Native task'), [['no-op']]);
  assert.equal(sameEdit.writes().length, 0);

  for (const [operation, flag, target, rel, receipt] of [['parent', '--to', 'AB-297', 'Hierarchy-Reverse', 'parent'], ['block', '--by', 'AB-300', 'Dependency-Reverse', 'block']]) {
    const linked = { ...BEFORE, rev: 6, relations: [relation(rel, Number(target.slice(3)))] };
    const linking = native({ returned: linked, patch: [{ op: 'test', path: '/rev', value: 5 }, { op: 'add', path: '/relations/-', value: relation(rel, Number(target.slice(3))) }] });
    assert.deepEqual(invoke(linking, operation, 'AB-299', flag, target), [[receipt, 'AB-299', target]]);
    const same = native({ before: linked });
    assert.deepEqual(invoke(same, operation, 'AB-299', flag, target), [['no-op']]);
    assert.equal(same.writes().length, 0);
    const selfLink = native();
    assert.throws(() => invoke(selfLink, operation, 'AB-299', flag, 'AB-299'), /itself|self/i);
    assert.equal(selfLink.writes().length, 0);
  }
  const reparent = native({ before: { ...BEFORE, relations: [relation('Hierarchy-Reverse', 300)] } });
  assert.throws(() => invoke(reparent, 'parent', 'AB-299', '--to', 'AB-297'), /different.*parent|reparent/i);
  assert.equal(reparent.writes().length, 0);

  const createPatch = [{ op: 'add', path: '/fields/System.Title', value: 'Created' }, { op: 'add', path: '/fields/System.Description', value: HTML },
    { op: 'add', path: '/fields/System.State', value: 'Ready' }, { op: 'add', path: '/fields/System.Tags', value: 'task' },
    { op: 'add', path: '/relations/-', value: relation('Hierarchy-Reverse', 297) }, { op: 'add', path: '/relations/-', value: relation('Dependency-Reverse', 300) }];
  const created = { ...BEFORE, id: 301, rev: 1, fields: { ...BEFORE.fields, 'System.Title': 'Created', 'System.Description': HTML, 'System.Tags': 'task' }, relations: [relation('Hierarchy-Reverse', 297), relation('Dependency-Reverse', 300)] };
  const createArgs = ['create', '--title', 'Created', '--body-file', body, '--status', 'Ready', '--kind', 'task', '--parent', 'AB-297', '--blocked-by', 'AB-300'];
  const creating = native({ returned: created, patch: createPatch });
  assert.deepEqual(invoke(creating, ...createArgs), [['created', 'AB-301']]);
  assert.equal(creating.writes().length, 2);
  const known = native({ returned: created, patch: createPatch, after: new Error('readback unavailable') });
  assert.throws(() => invoke(known, ...createArgs), /created AB-301.*unconfirmed.*do not.*create/i);
  const unknown = native({ returned: {}, patch: createPatch });
  assert.throws(() => invoke(unknown, ...createArgs), /unknown.*Native Project.*Created.*inspect/i);

  const posted = { ...COMMENT, version: 2, text: SOURCE, format: 'markdown' };
  for (const operation of ['comment', 'edit-comment']) {
    const commenting = native({ returned: posted, commentAfter: posted, patch: { text: SOURCE } });
    const args = operation === 'comment' ? [operation, 'AB-299', '--body-file', body] : [operation, 'AB-299', '71', '--body-file', body];
    const rows = invoke(commenting, ...args);
    assert.deepEqual(rows[0], [operation === 'comment' ? 'comment' : 'edited-comment', 'AB-299', 71, `https://dev.azure.com/example-org/${PROJECT}/_workitems/edit/299?discussionId=71`]);
    assert.deepEqual(commenting.writes()[0].query, { 'api-version': '7.1-preview.4', format: 'markdown' });
    assert.equal(commenting.calls.filter(({ path }) => path === '/_apis/projects/' + PROJECT).length, 1);
    assert.equal(commenting.calls.filter(({ path }) => path === ROOT + '/workitems/299').length, 1);
    assert.equal(commenting.calls.filter(({ method, path }) => method === 'GET' && path === ROOT + '/workitems/299/comments').length, operation === 'edit-comment' ? 2 : 1);
    if (operation === 'edit-comment') assert.match(JSON.stringify(rows), /no atomic/i);
    const unconfirmed = native({ returned: posted, commentAfter: COMMENT });
    assert.throws(() => invoke(unconfirmed, ...args), /comment 71.*unconfirmed/i);
  }
  const foreignComment = native({ commentBefore: { ...COMMENT, createdBy: { id: OTHER } } });
  let foreignCommentError;
  try {
    invoke(foreignComment, 'edit-comment', 'AB-299', '71', '--body-file', body);
  } catch (caught) {
    foreignCommentError = caught;
  }
  assert.equal(foreignComment.writes().length, 0);
  assert.match(foreignCommentError.message, /another|ownership/i);
  const textProvider = native();
  const text = invoke(textProvider, 'text', 'AB-299');
  assert.ok(JSON.stringify(text).includes('https://example.test/hidden'));
  assert.ok(JSON.stringify(text).includes('https://example.test/claim'));
  assert.ok(JSON.stringify(text).includes('html'));
  assert.deepEqual(invoke(native(), 'children', 'AB-299'), [['children', []], ['total', 0], ['completed', 0]]);
  const viewProvider = native({ before: { ...BEFORE, relations: [relation('Hierarchy-Reverse', 297)] } });
  const view = invoke(viewProvider, 'view', 'AB-299');
  assert.ok(JSON.stringify(view).includes(VIEWER));
  assert.ok(JSON.stringify(view).includes(COMMENT.text.replaceAll('"', '\\"')));
  assert.equal(viewProvider.calls.filter(({ path }) => path === ROOT + '/workitems/297').length, 0);
  for (const provider of [textProvider, viewProvider]) {
    for (const path of ['/_apis/projects/' + PROJECT, ROOT + '/workitems/299', ROOT + '/workitems/299/comments']) {
      assert.equal(provider.calls.filter((request) => request.path === path).length, 1);
    }
  }
  const boardProvider = native({ before: { ...BEFORE, relations: [relation('Hierarchy-Reverse', 297)] } });
  assert.deepEqual(invoke(boardProvider, 'view', 'AB-299', '--board'), [['board', 'azure', PROJECT, 'Ready'], ['boards', 1]]);
  assert.equal(boardProvider.calls.filter(({ path }) => path === ROOT + '/workitems/299').length, 1);
  assert.equal(boardProvider.calls.filter(({ path }) => path === ROOT + '/workitems/299/comments' || path === ROOT + '/workitems/297').length, 0);

  const rateLimited = Object.assign(new Error('Azure rate limit (HTTP 429): Retry-After 60; no retry was sent'), { rateLimited: true });
  const rateFlags = [];
  for (const [options, message] of [
    [{ validation: rateLimited, patch: STATE_PATCH }, /confirmed none.*AB-299.*validation.*process.*setup.*429/i],
    [{ failure: rateLimited, patch: STATE_PATCH }, /confirmed none.*AB-299.*429.*no retry/i],
    [{ after: rateLimited, patch: STATE_PATCH }, /confirmed none.*AB-299.*unconfirmed.*429/i],
  ]) {
    const limited = native(options);
    assert.throws(() => moveAzureCards([{ issueNumber: 'AB-299', statusName: 'In progress' }], limited.exec), (error) => {
      assert.match(error.message, message);
      rateFlags.push(error.rateLimited);
      return true;
    });
  }
  const commentLimited = native({ failure: rateLimited, patch: { text: SOURCE } });
  assert.throws(() => invoke(commentLimited, 'comment', 'AB-299', '--body-file', body), (error) => {
    assert.match(error.message, /AB-299.*comment outcome unknown.*inspect.*no retry.*429/i);
    rateFlags.push(error.rateLimited);
    return true;
  });
  assert.deepEqual(rateFlags, [true, true, true, true], 'native rate-limit classification must survive validation, mutation, readback and comment wrappers');
});

test('Azure text verifies complete native blockers including closed cards', async (t) => {
  const toolkit = copyToolkit(AZURE_TEST_CONFIG);
  t.after(toolkit.cleanup);
  const { parseCardArgs, runCardCommand } = await toolkit.load('lib/azure-card.mjs');
  const before = { ...BEFORE, relations: [relation('Dependency-Reverse', 297), relation('Dependency-Reverse', 300), relation('Dependency-Forward', 301)] };
  const blocker = { ...BLOCKER, fields: { ...BLOCKER.fields, 'System.State': 'Closed' } };
  const provider = native({ before, blocker });
  const rows = runCardCommand(parseCardArgs(['text', 'AB-299']), provider.exec);
  assert.deepEqual(rows.find(([name]) => name === 'blockedBy'), ['blockedBy', ['AB-297', 'AB-300']]);
  assert.ok(provider.calls.some(({ method, path }) => method === 'GET' && path === ROOT + '/workitems/297'));
  assert.ok(provider.calls.some(({ method, path }) => method === 'GET' && path === ROOT + '/workitems/300'));
  assert.equal(provider.calls.some(({ path }) => path === ROOT + '/workitems/301'), false);
  const unavailable = native({ before, blocker, failSecond: true });
  assert.throws(() => runCardCommand(parseCardArgs(['text', 'AB-299']), unavailable.exec), /second card unavailable/);
});
