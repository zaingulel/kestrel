// CLI routing uses literal native responses at the external execution boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AZURE_TEST_CONFIG, GITHUB_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';

const PROJECT_PATH = '/11111111-1111-4111-8111-111111111111/_apis/wit';
const ITEM_PATH = PROJECT_PATH + '/workitems/299';
const AS_OF = '2026-01-01T00:00:00.000Z';
const READY_ITEM = {
  id: 299, rev: 5,
  url: 'https://dev.azure.com/example-org/11111111-1111-4111-8111-111111111111/_apis/wit/workitems/299',
  fields: {
    'System.Id': 299, 'System.Rev': 5, 'System.TeamProject': 'Example Project',
    'System.WorkItemType': 'Task', 'System.State': 'Ready', 'System.Title': 'Native task',
    'System.Description': '<pre>Acceptance text</pre>', 'System.Tags': 'task',
    'System.CreatedDate': '2026-01-01T00:00:00.000Z', 'System.ChangedDate': '2026-01-01T00:00:00.000Z',
  },
  relations: [],
};
const ACTIVE_ITEM = {
  ...READY_ITEM, rev: 6,
  fields: { ...READY_ITEM.fields, 'System.Rev': 6, 'System.State': 'Active' },
};
const STATE_PATCH = [
  { op: 'test', path: '/rev', value: 5 },
  { op: 'add', path: '/fields/System.State', value: 'Active' },
];
const STATES = { count: 6, value: [
  { name: 'New', category: 'Proposed' }, { name: 'Ready', category: 'Proposed' },
  { name: 'Active', category: 'InProgress' }, { name: 'Awaiting Push', category: 'InProgress' },
  { name: 'In Review', category: 'InProgress' }, { name: 'Closed', category: 'Completed' },
] };
const RELATIONS = { count: 4, value: [
  { referenceName: 'System.LinkTypes.Hierarchy-Reverse', name: 'Parent', attributes: { enabled: true, directional: true, usage: 'workItemLink', oppositeEndReferenceName: 'System.LinkTypes.Hierarchy-Forward' } },
  { referenceName: 'System.LinkTypes.Hierarchy-Forward', name: 'Child', attributes: { enabled: true, directional: true, usage: 'workItemLink', oppositeEndReferenceName: 'System.LinkTypes.Hierarchy-Reverse' } },
  { referenceName: 'System.LinkTypes.Dependency-Reverse', name: 'Predecessor', attributes: { enabled: true, directional: true, usage: 'workItemLink', oppositeEndReferenceName: 'System.LinkTypes.Dependency-Forward' } },
  { referenceName: 'System.LinkTypes.Dependency-Forward', name: 'Successor', attributes: { enabled: true, directional: true, usage: 'workItemLink', oppositeEndReferenceName: 'System.LinkTypes.Dependency-Reverse' } },
] };

function native() {
  const calls = [];
  const ghCalls = [];
  let item = structuredClone(READY_ITEM);
  const exec = (request) => {
    calls.push(structuredClone(request));
    const { method, path } = request;
    if (method === 'GET') {
      if (path === '/_apis/projects/11111111-1111-4111-8111-111111111111') {
        return { id: '11111111-1111-4111-8111-111111111111', name: 'Example Project', state: 'wellFormed' };
      }
      if (path === PROJECT_PATH + '/workitemtypes') return { count: 4, value: [
        { name: 'Epic', isDisabled: false }, { name: 'User Story', isDisabled: false },
        { name: 'Task', isDisabled: false }, { name: 'Bug', isDisabled: false },
      ] };
      if ([PROJECT_PATH + '/workitemtypes/Epic/states', PROJECT_PATH + '/workitemtypes/User%20Story/states', PROJECT_PATH + '/workitemtypes/Task/states', PROJECT_PATH + '/workitemtypes/Bug/states'].includes(path)) return structuredClone(STATES);
      if (path === '/_apis/wit/workitemrelationtypes') return structuredClone(RELATIONS);
      if (path === '/_apis/profile/profiles/me') return { id: '22222222-2222-4222-8222-222222222222', displayName: 'Fixture viewer', emailAddress: 'viewer@example.test' };
      if (path === ITEM_PATH) return structuredClone(item);
      if (path === PROJECT_PATH + '/workitems/299/comments') return { totalCount: 0, count: 0, comments: [] };
    }
    if (method === 'POST' && path === PROJECT_PATH + '/wiql') {
      assert.deepEqual(request.body, { query: 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.Id] ASC' });
      return { queryType: 'flat', queryResultType: 'workItem', asOf: AS_OF, workItems: [{ id: 299, url: READY_ITEM.url }] };
    }
    if (method === 'POST' && path === PROJECT_PATH + '/workitemsbatch') {
      assert.deepEqual(request.body, { ids: [299], asOf: AS_OF, errorPolicy: 'Fail', '$expand': 'All' });
      return { count: 1, value: [structuredClone(item)] };
    }
    if (method === 'PATCH' && path === ITEM_PATH) {
      assert.deepEqual(request.body, STATE_PATCH);
      if (request.query?.validateOnly === true) return structuredClone(ACTIVE_ITEM);
      item = structuredClone(ACTIVE_ITEM);
      return structuredClone(ACTIVE_ITEM);
    }
    throw new Error('Unexpected Azure request: ' + JSON.stringify(request));
  };
  const gh = (args) => {
    ghCalls.push(structuredClone(args));
    assert.deepEqual(args, ['api', 'repos/example-owner/example-repo/pulls?state=all&per_page=100', '--paginate', '--slurp']);
    return '[[]]';
  };
  return { exec, gh, calls, ghCalls };
}

test('Azure commands route native card identities without GitHub issue writes', async (t) => {
  const toolkit = copyToolkit(AZURE_TEST_CONFIG);
  t.after(toolkit.cleanup);
  const { main: board } = await toolkit.load('board.mjs');
  const { main: move } = await toolkit.load('board-move.mjs');
  const { main: publish } = await toolkit.load('verify-issue-publish.mjs');
  const run = (main, args, provider) => {
    const stdout = [];
    const stderr = [];
    const status = main(args, {
      azureExec: provider.exec, ghExec: provider.gh,
      jiraExec: () => { throw new Error('must not call Jira'); },
      linearExec: () => { throw new Error('must not call Linear'); },
      fetchBoard: () => { throw new Error('must not read GitHub Projects'); },
      output: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
    });
    return { status, stdout, stderr };
  };

  const moving = native();
  const moved = run(move, ['AB-299', 'In progress'], moving);
  assert.equal(moved.status, 0, moved.stderr.join('\n'));
  assert.deepEqual(moved.stdout, ['board-move: AB-299 → In progress']);
  const writes = moving.calls.filter(({ method }) => method === 'PATCH');
  assert.equal(writes.length, 2);
  assert.ok(writes.some(({ query }) => query?.validateOnly === true));
  assert.ok(writes.some(({ query }) => query?.validateOnly !== true));
  assert.equal(moving.ghCalls.length, 0);

  const listing = native();
  const listed = run(board, ['--all', '--json'], listing);
  assert.equal(listed.status, 0, listed.stderr.join('\n'));
  assert.deepEqual(JSON.parse(listed.stdout[0]), [
    { number: 'AB-299', status: 'Ready', title: 'Native task', routing: null, parked: false, labels: ['task'], state: 'OPEN', assignees: [], openBlockers: [], closingPullRequests: [], subIssues: { total: 0, completed: 0 } },
  ]);
  assert.ok(listing.calls.some(({ path }) => path === PROJECT_PATH + '/wiql'));
  assert.ok(listing.calls.some(({ path }) => path === PROJECT_PATH + '/workitemsbatch'));

  const publication = native();
  const published = run(publish, ['AB-299'], publication);
  assert.equal(published.status, 0, published.stderr.join('\n'));
  assert.ok(publication.calls.some(({ method, path }) => method === 'GET' && path === ITEM_PATH));
  assert.match(published.stdout.join('\n'), /Statuses verified for AB-299/);
  assert.match(published.stdout.join('\n'), /exactly one kind label verified for AB-299/);
  assert.match(published.stdout.join('\n'), /0 child issues/);
  assert.equal(publication.ghCalls.length, 0);

  for (const [main, args] of [[move, ['299', 'In progress']], [move, ['--batch', '299:In progress']], [publish, ['299']]]) {
    const provider = native();
    const rejected = run(main, args, provider);
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(rejected.stdout, []);
    assert.ok(rejected.stderr.length > 0);
    assert.deepEqual(provider.calls, []);
    assert.deepEqual(provider.ghCalls, []);
  }
});

test('Azure publication requires complete native child evidence', async (t) => {
  const toolkit = copyToolkit(AZURE_TEST_CONFIG);
  t.after(toolkit.cleanup);
  const publication = await toolkit.load('lib/issue-publish.mjs');
  const parent = { ...READY_ITEM, id: 297, fields: { ...READY_ITEM.fields, 'System.Id': 297, 'System.Title': 'Parent', 'System.WorkItemType': 'Epic', 'System.Tags': 'epic' },
    url: READY_ITEM.url.replace('/299', '/297'), relations: [{ rel: 'System.LinkTypes.Hierarchy-Forward', url: READY_ITEM.url }] };
  const child = { ...READY_ITEM, relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: parent.url }] };
  const provider = (overrides = {}) => {
    const fallback = native();
    return (request) => {
      if (request.method === 'GET' && request.path === PROJECT_PATH + '/workitems/297') return structuredClone(overrides.parent ?? parent);
      if (request.method === 'GET' && request.path === ITEM_PATH) {
        if (overrides.missingChild) throw new Error('native child inaccessible');
        return structuredClone(overrides.child ?? child);
      }
      return fallback.exec(request);
    };
  };
  assert.deepEqual(publication.parseIssuePublishArgs(['AB-297', 'AB-299'], 'azure'), { subjectNumber: 'AB-297', childNumbers: ['AB-299'] });
  for (const args of [['297'], ['AB-0'], ['AB-01'], ['AB-2147483648'], ['AB-297', 'AB-297'], ['AB-297', '--unknown']]) assert.throws(() => publication.parseIssuePublishArgs(args, 'azure'));
  assert.ok(publication.verifyAzurePublication(['AB-297', 'AB-299'], provider()).some((line) => line.includes('exactly the 1 supplied child issues')));
  assert.ok(publication.verifyAzurePublication(['AB-297'], provider()).some((line) => line.includes('1 child issues (none supplied')));
  assert.throws(() => publication.verifyAzurePublication(['AB-297', 'AB-299'], provider({ parent: { ...parent, relations: [] } })), /child set|children/i);
  assert.throws(() => publication.verifyAzurePublication(['AB-297', 'AB-299'], provider({ missingChild: true })), /native child inaccessible/);
  assert.throws(() => publication.verifyAzurePublication(['AB-297', 'AB-299'], provider({ child: { ...child, relations: [] } })), /parent/i);
  assert.throws(() => publication.verifyAzurePublication(['AB-297', 'AB-299'], provider({ parent: { ...parent, relations: [parent.relations[0], parent.relations[0]] } })), /duplicat/i);
  assert.throws(() => publication.verifyAzurePublication(['AB-297', 'AB-299'], provider({ child: { ...child, fields: { ...child.fields, 'System.Tags': 'retained' } } })), /exactly one kind/i);
  assert.throws(() => publication.verifyAzurePublication(['AB-297', 'AB-299'], provider({ child: { ...child, fields: { ...child.fields, 'System.State': 'Unmapped' } } })), /mapping/i);
});

test('Azure card CLI routes native reads and preserves provider exits', async (t) => {
  const toolkit = copyToolkit(AZURE_TEST_CONFIG);
  t.after(toolkit.cleanup);
  const { main } = await toolkit.load('azure-card.mjs');
  const run = (args, exec) => {
    const stdout = [];
    const stderr = [];
    const status = main(args, { azureExec: exec,
      output: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) } });
    return { status, stdout, stderr };
  };
  const provider = native();
  const viewed = run(['view', 'AB-299', '--board'], provider.exec);
  assert.equal(viewed.status, 0, viewed.stderr.join('\n'));
  assert.deepEqual(viewed.stdout.map((line) => JSON.parse(line)), [
    ['board', 'azure', '11111111-1111-4111-8111-111111111111', 'Ready'], ['boards', 1],
  ]);
  assert.deepEqual(viewed.stderr, []);
  assert.ok(provider.calls.some(({ method, path }) => method === 'GET' && path === ITEM_PATH));
  const rejectedProvider = native();
  const rejected = run(['view', '299', '--board'], rejectedProvider.exec);
  assert.equal(rejected.status, 2);
  assert.deepEqual(rejected.stdout, []);
  assert.match(rejected.stderr.join('\n'), /Azure card identifier must be AB-<positive int32>/);
  assert.deepEqual(rejectedProvider.calls, []);
  const limited = run(['view', 'AB-299', '--board'], () => {
    const error = new Error('Azure rate limit fixture');
    error.rateLimited = true;
    throw error;
  });
  assert.equal(limited.status, 3);
  assert.deepEqual(limited.stdout, []);
  assert.deepEqual(limited.stderr, ['azure-card: Azure rate limit fixture']);
  for (const command of ['view', 'text']) {
    const reading = native();
    const throttled = run([command, 'AB-299'], (request) => {
      if (request.method === 'GET' && request.path === ITEM_PATH + '/comments') {
        const error = new Error('Azure comments rate limit fixture');
        error.rateLimited = true;
        throw error;
      }
      return reading.exec(request);
    });
    assert.ok(reading.calls.some(({ path }) => path === '/_apis/projects/11111111-1111-4111-8111-111111111111'));
    assert.ok(reading.calls.some(({ path }) => path === ITEM_PATH));
    assert.equal(throttled.status, 3, command + ' must preserve mid-read throttling');
    assert.deepEqual(throttled.stdout, []);
    assert.match(throttled.stderr.join('\n'), /Azure comments rate limit fixture/);
  }
});

test('Azure board surfaces kind-label drift without changing other trackers', async (t) => {
  const items = [
    { id: 'AB-301', status: 'Ready', title: 'Missing kind', routing: null, labels: [], content: { number: 'AB-301', state: 'OPEN' } },
    { id: 'AB-302', status: 'Ready', title: 'Multiple kinds', routing: null, labels: ['task', 'bug'], content: { number: 'AB-302', state: 'OPEN' } },
    { id: 'AB-303', status: 'Ready', title: 'Valid kind', routing: null, labels: ['task'], content: { number: 'AB-303', state: 'OPEN' } },
  ];
  const github = copyToolkit(GITHUB_TEST_CONFIG);
  t.after(github.cleanup);
  const { scanBoard: scanGithub } = await github.load('lib/board-rules.mjs');
  const githubItems = items.map((item, index) => ({
    ...item, id: `PVTI_${301 + index}`, routing: 'Product', content: { number: 301 + index, state: 'OPEN' },
  }));
  assert.deepEqual(scanGithub(githubItems), { drifted: [], unreadable: [] });

  const azure = copyToolkit(AZURE_TEST_CONFIG);
  t.after(azure.cleanup);
  const { scanBoard } = await azure.load('lib/board-rules.mjs');
  const { drifted, unreadable } = scanBoard(items);
  assert.deepEqual(unreadable, []);
  assert.deepEqual(drifted.filter((row) => row.number === 'AB-303'), []);
  for (const number of ['AB-301', 'AB-302']) {
    const rows = drifted.filter((row) => row.number === number);
    assert.equal(rows.length, 1, `${number} must report one kind-label advisory`);
    assert.equal(rows[0].advisory, true);
    assert.match(rows[0].reason, /kind/i);
  }
  assert.equal(drifted.length, 2);
});
