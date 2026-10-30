// Native Jira fixtures and hand-worked board expectations; all provider execution is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyToolkit } from './board-toolkit-copy.mjs';

const SITE = 'https://example.atlassian.net';
const CONFIG = {
  site: SITE, project: 'ENG',
  states: { Backlog: '10', Ready: '11', 'In progress': '12', 'Awaiting push': '13', 'In review': '14', Done: '15' },
  issueTypes: { epic: '10001', feature: '10002', task: '10002', bug: '10002', docs: '10002' }, blockLinkType: '10003',
};
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
async function reader(t) {
  const toolkit = copyToolkit(CONFIG_SOURCE);
  t.after(toolkit.cleanup);
  return { ...await toolkit.load('lib/board-jira.mjs'), ...await toolkit.load('lib/board.mjs') };
}
const status = (id, key) => ({ id, name: 'Status ' + id, statusCategory: { key } });
const STATES = [status('10', 'new'), status('11', 'new'), status('12', 'indeterminate'), status('13', 'indeterminate'), status('14', 'indeterminate'), status('15', 'done')];
const PROJECT = { id: '10000', key: 'ENG', issueTypes: [{ id: '10001', hierarchyLevel: 1 }, { id: '10002', hierarchyLevel: 0 }] };
const METADATA = [{ id: '10001', statuses: STATES }, { id: '10002', statuses: STATES }];
const TEXT = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const DESCRIPTION = { type: 'doc', version: 1, content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Acceptance' }, { type: 'hardBreak' }, { type: 'text', text: 'text' }] },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
  { type: 'bulletList', content: [
    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
  ] },
  { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
  { type: 'codeBlock', content: [{ type: 'text', text: 'code' }] },
  { type: 'table', content: [{ type: 'tableRow', content: [
    { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cell1' }] }] },
    { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cell2' }] }] },
  ] }] },
  { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Alice' } }, { type: 'text', text: ' ' }, { type: 'emoji', attrs: { shortName: ':wave:' } }] },
] };
const ISSUES = {
  'ENG-1': { id: '20001', key: 'ENG-1', fields: { project: { id: '10000', key: 'ENG' }, summary: 'Parent', status: STATES[1], issuetype: { id: '10001' }, labels: ['epic'], assignee: null, parent: null, issuelinks: [], description: TEXT('Parent body') } },
  'ENG-2': { id: '20002', key: 'ENG-2', fields: { project: { id: '10000', key: 'ENG' }, summary: 'Active child', status: STATES[2], issuetype: { id: '10002' }, labels: ['task'], assignee: { accountId: 'acct-self', displayName: 'Same name' }, parent: { id: '20001', key: 'ENG-1' }, issuelinks: [{ id: '40001', type: { id: '10003' }, inwardIssue: { id: '20001', key: 'ENG-1' } }], description: DESCRIPTION } },
  'ENG-3': { id: '20003', key: 'ENG-3', fields: { project: { id: '10000', key: 'ENG' }, summary: 'Done child', status: STATES[5], issuetype: { id: '10002' }, labels: ['task'], assignee: null, parent: { id: '20001', key: 'ENG-1' }, issuelinks: [], description: null } },
};
const COMMENT_1 = { id: '30001', created: '2026-01-01T00:00:00.000Z', author: { accountId: 'acct-self', displayName: 'Same name' }, self: SITE + '/rest/api/3/issue/20002/comment/30001', body: TEXT('Claim: first, Codex, 2026-01-01T00:00Z') };
const COMMENT_2 = { id: '30002', created: '2026-01-02T00:00:00.000Z', author: { accountId: 'acct-other', displayName: 'Same name' }, self: SITE + '/rest/api/3/issue/20002/comment/30002', body: TEXT('second') };
const PR = { number: 17, state: 'open', draft: false, merged_at: null, head: { ref: 'job/ENG-2', repo: { full_name: 'example-owner/example-repo' } }, base: { ref: 'main', repo: { full_name: 'example-owner/example-repo' } }, body: 'Context\nCloses ENG-2\n' };
const clone = (value) => structuredClone(value);
function provider(options = {}) {
  const calls = [];
  const ghCalls = [];
  const issues = options.issues ?? clone(ISSUES);
  const issuePages = options.issuePages ?? {
    '': { issues: [issues['ENG-1'], issues['ENG-2']], isLast: false, nextPageToken: 'p2', total: 3 },
    p2: { issues: [issues['ENG-3']], isLast: true, total: 3 },
  };
  const childPages = options.childPages ?? {
    '': { issues: [issues['ENG-2']], isLast: false, nextPageToken: 'child2', total: 2 },
    child2: { issues: [issues['ENG-3']], isLast: true, total: 2 },
  };
  const commentPages = options.commentPages ?? {
    0: { startAt: 0, maxResults: 1, total: 2, comments: [COMMENT_2] },
    1: { startAt: 1, maxResults: 1, total: 2, comments: [COMMENT_1] },
  };
  const exec = (request) => {
    calls.push(clone(request));
    const { path } = request;
    const postSearch = request.method === 'POST' && path === '/rest/api/3/search/jql';
    assert.ok(request.method === 'GET' || postSearch, 'no Jira mutations');
    if (calls.length > 100) throw new Error('fake: non-progressing read');
    const query = postSearch ? request.body : request.query ?? {};
    if (path === '/rest/api/3/project/ENG') return clone(options.project ?? PROJECT);
    if (path === '/rest/api/3/project/ENG/statuses') return clone(options.metadata ?? METADATA);
    if (path === '/rest/api/3/issueLinkType') return clone(options.links ?? { issueLinkTypes: [{ id: '10003', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] });
    if (path === '/rest/api/3/search/jql') {
      const fields = 'summary,status,project,issuetype,labels,assignee,parent,issuelinks,description';
      if (postSearch) assert.deepEqual(query.fields, fields.split(','));
      else assert.equal(query.fields, fields);
      assert.equal(query.maxResults, 100);
      let pages;
      if (postSearch) {
        const match = /^parent IN \(([^)]+)\) ORDER BY key ASC$/i.exec(query.jql);
        assert.ok(match, 'only the native parent-IN search is an additional read');
        const keys = match[1].split(',').map((key) => key.trim().replace(/^"|"$/g, ''));
        assert.ok(keys.every((key) => ['ENG-1', 'ENG-2', 'ENG-3'].includes(key)));
        pages = keys.includes('ENG-1') ? childPages : { '': { issues: [], isLast: true, total: 0 } };
      } else if (query.jql === 'project = ENG ORDER BY key ASC') pages = issuePages;
      else if (query.jql === 'parent = ENG-1 ORDER BY key ASC') pages = childPages;
      else if (['parent = ENG-2 ORDER BY key ASC', 'parent = ENG-3 ORDER BY key ASC'].includes(query.jql)) pages = { '': { issues: [], isLast: true, total: 0 } };
      else throw new Error('Unexpected JQL: ' + query.jql);
      const page = pages[query.nextPageToken ?? ''];
      if (!page) throw new Error('Unknown search cursor');
      return clone(page);
    }
    const comment = /^\/rest\/api\/3\/issue\/(ENG-[123])\/comment$/.exec(path);
    if (comment) {
      assert.equal(query.maxResults, 100);
      if (comment[1] !== 'ENG-2') return { startAt: 0, maxResults: 100, total: 0, comments: [] };
      const page = commentPages[query.startAt];
      if (page instanceof Error) throw page;
      if (!page) throw new Error('Unknown comment offset');
      return clone(page);
    }
    const issue = /^\/rest\/api\/3\/issue\/(ENG-[123])$/.exec(path);
    if (issue) return clone(options.directIssues?.[issue[1]] ?? issues[issue[1]]);
    throw new Error('Unexpected Jira request: ' + JSON.stringify(request));
  };
  const gh = (args) => {
    ghCalls.push(args);
    assert.deepEqual(args, ['api', 'repos/example-owner/example-repo/pulls?state=all&per_page=100', '--paginate', '--slurp']);
    if (options.ghError) throw options.ghError;
    return JSON.stringify(options.pulls ?? [[PR, { ...clone(PR), number: 18, head: { ref: 'job/ENG-2', repo: { full_name: 'fork/example-repo' } } }], [
      { ...clone(PR), number: 19, base: { ref: 'develop', repo: { full_name: 'example-owner/example-repo' } } },
      { ...clone(PR), number: 20, body: 'Mention: Closes ENG-2' },
      { ...clone(PR), number: 21, state: 'closed' },
    ]]);
  };
  return { exec, gh, calls, ghCalls };
}

test('Jira board reads complete project data and refuses incomplete evidence', async (t) => {
  const api = await reader(t);
  const native = provider();
  const board = api.readJiraBoard(native.exec, native.gh);
  assert.deepEqual(board.items.map(api.normalizeItem), [
    { number: 'ENG-1', status: 'Ready', title: 'Parent', routing: null, parked: false, labels: ['epic'], state: 'OPEN', assignees: [], openBlockers: [], closingPullRequests: [], subIssues: { total: 2, completed: 1 } },
    { number: 'ENG-2', status: 'In progress', title: 'Active child', routing: null, parked: false, labels: ['task'], state: 'OPEN', assignees: ['acct-self'], openBlockers: ['ENG-1'], closingPullRequests: [{ number: 17 }], subIssues: { total: 0, completed: 0 } },
    { number: 'ENG-3', status: 'Done', title: 'Done child', routing: null, parked: false, labels: ['task'], state: 'CLOSED', assignees: [], openBlockers: [], closingPullRequests: [], subIssues: { total: 0, completed: 0 } },
  ]);
  assert.equal(native.ghCalls.length, 1);
  assert.equal(native.calls.some(({ path }) => path.endsWith('/comment')), false, 'board must not fetch unrelated comments');
  assert.deepEqual(native.calls.filter(({ query }) => query?.jql === 'project = ENG ORDER BY key ASC').map(({ query }) => query.nextPageToken ?? null), [null, 'p2']);
  assert.ok(native.calls.some(({ path }) => path === '/rest/api/3/issue/ENG-1'), 'blockers and parents need direct identity reads');
  const children = api.readJiraChildren('ENG-1', provider().exec);
  assert.deepEqual(children.issues.map(({ key }) => key), ['ENG-2', 'ENG-3']);
  assert.deepEqual([children.total, children.completed], [2, 1]);
  assert.equal(api.readJiraIssue('ENG-2', provider().exec).id, '20002');
  const comments = api.readJiraComments('ENG-2', provider().exec);
  assert.deepEqual(comments.map(({ id, accountId, createdAt, url, body, position }) => ({ id, accountId, createdAt, url, body, position })), [
    { id: '30001', accountId: 'acct-self', createdAt: '2026-01-01T00:00:00.000Z', url: SITE + '/browse/ENG-2?focusedCommentId=30001', body: 'Claim: first, Codex, 2026-01-01T00:00Z', position: 1 },
    { id: '30002', accountId: 'acct-other', createdAt: '2026-01-02T00:00:00.000Z', url: SITE + '/browse/ENG-2?focusedCommentId=30002', body: 'second', position: 2 },
  ]);
  assert.deepEqual(api.jiraCardDetails(provider().exec, ['ENG-2']).get('ENG-2'), {
    number: 'ENG-2', body: 'Acceptance\ntext\nHeading\none\ntwo\nquoted\ncode\ncell1\tcell2\n@Alice :wave:', parent: 'ENG-1',
    comments: ['Claim: first, Codex, 2026-01-01T00:00Z', 'second'], commentCount: 2, commentsUnavailable: null,
  });
  for (const pull of [{ ...clone(PR), draft: true }, { ...clone(PR), state: 'closed', merged_at: '2026-01-01T00:00:00Z' }]) {
    const data = provider({ pulls: [[pull]] });
    assert.deepEqual(api.readJiraBoard(data.exec, data.gh).items[1].closingPullRequests, [{ number: 17 }]);
  }
  const reversed = clone(ISSUES);
  reversed['ENG-2'].fields.issuelinks = [{ id: '40001', type: { id: '10003' }, outwardIssue: { id: '20001', key: 'ENG-1' } }];
  const reverse = provider({ issues: reversed });
  assert.deepEqual(api.readJiraBoard(reverse.exec, reverse.gh).items[1].blockers, []);

  const closedBlocker = clone(ISSUES['ENG-1']);
  closedBlocker.fields.status = STATES[5];
  const direct = provider({ directIssues: { 'ENG-1': closedBlocker } });
  assert.deepEqual(api.readJiraBoard(direct.exec, direct.gh).items[1].blockers, [{ number: 'ENG-1', state: 'CLOSED' }]);
  for (const [category, state] of [['indeterminate', 'OPEN'], ['done', 'CLOSED']]) {
    const unmapped = clone(ISSUES);
    unmapped['ENG-2'].fields.status = status('99', category);
    const drift = provider({ issues: unmapped });
    const item = api.readJiraBoard(drift.exec, drift.gh).items[1];
    assert.equal(item.status, null);
    assert.equal(item.content.state, state);
  }

  const foreign = clone(ISSUES);
  foreign['ENG-2'].fields.project.id = '99999';
  const moved = clone(ISSUES);
  moved['ENG-2'].key = 'ENG-99';
  assert.throws(() => api.readJiraIssue('ENG-2', provider({ issues: moved }).exec), /ENG-2.*ENG-99|ENG-99.*ENG-2/);
  const badSearches = [
    { '': { issues: [ISSUES['ENG-1']], isLast: false } },
    { '': { issues: [ISSUES['ENG-1']], isLast: true, total: 2 } },
    { '': { issues: [ISSUES['ENG-1']] } },
    { '': { issues: [ISSUES['ENG-1']], isLast: false, nextPageToken: 'p2' }, p2: { issues: [ISSUES['ENG-2']], isLast: false, nextPageToken: 'p2' } },
    { '': { issues: [ISSUES['ENG-1']], isLast: false, nextPageToken: 'p2' }, p2: { issues: [ISSUES['ENG-1']], isLast: true } },
  ];
  for (const options of [{ issues: foreign }, ...badSearches.map((issuePages) => ({ issuePages })), { ghError: new Error('GitHub page failed') }, { pulls: [[PR], [PR]] }]) {
    const data = provider(options);
    assert.throws(() => api.readJiraBoard(data.exec, data.gh), /Jira|GitHub|page|duplicate|incomplete/i);
  }
  const foreignParent = clone(ISSUES);
  foreignParent['ENG-2'].fields.parent = { id: '90001', key: 'OPS-1' };
  const unavailableParent = api.jiraCardDetails(provider({ issues: foreignParent }).exec, ['ENG-2']).get('ENG-2');
  assert.match(unavailableParent.unavailable, /OPS-1|project|foreign/i);
  const childMismatch = provider({ childPages: { '': { issues: [ISSUES['ENG-1']], isLast: true, total: 1 } } });
  assert.throws(() => api.readJiraChildren('ENG-1', childMismatch.exec), /parent|child/i);
  for (const commentPages of [
    { 0: { startAt: 0, maxResults: 1, total: 2, comments: [COMMENT_1] }, 1: new Error('later comment page failed') },
    { 0: { startAt: 0, maxResults: 1, total: 2, comments: [COMMENT_1] }, 1: { startAt: 1, maxResults: 1, total: 2, comments: [COMMENT_1] } },
    { 0: { startAt: 0, maxResults: 1, total: 2, comments: [] } },
    { 0: { startAt: 1, maxResults: 1, total: 1, comments: [COMMENT_1] } },
  ]) {
    const unavailable = api.jiraCardDetails(provider({ commentPages }).exec, ['ENG-2']).get('ENG-2');
    assert.equal(unavailable.number, 'ENG-2');
    assert.match(unavailable.unavailable, /comment|page|duplicate|offset|incomplete/i);
    assert.equal(unavailable.comments, undefined);
  }
  const unsupported = clone(ISSUES);
  unsupported['ENG-2'].fields.description = { type: 'doc', version: 1, content: [{ type: 'media', attrs: { id: 'media-1', type: 'file', collection: 'documents' } }] };
  assert.match(api.jiraCardDetails(provider({ issues: unsupported }).exec, ['ENG-2']).get('ENG-2').unavailable, /ADF|media|unsupported/i);
  const limited = Object.assign(new Error('Jira rate limit'), { rateLimited: true });
  const rate = provider({ commentPages: { 0: limited } });
  const details = api.jiraCardDetails(rate.exec, ['ENG-2', 'ENG-3']);
  assert.match(details.get('ENG-2').unavailable, /rate limit/);
  assert.match(details.get('ENG-3').unavailable, /rate limit/);
  assert.equal(rate.calls.some(({ path }) => path === '/rest/api/3/issue/ENG-3'), false);
});

test('Jira metadata refuses incompatible status categories', async (t) => {
  const api = await reader(t);
  const compatible = provider();
  const project = api.readJiraProject(compatible.exec);
  assert.equal(project.id, '10000');
  assert.equal(project.key, 'ENG');
  for (const [column, id] of Object.entries(CONFIG.states)) assert.equal(project.columnOf(STATES.find((state) => state.id === id)), column);
  for (const [id, category] of [['15', 'new'], ['11', 'done']]) {
    const metadata = clone(METADATA);
    for (const type of metadata) for (const state of type.statuses) if (state.id === id) state.statusCategory.key = category;
    const data = provider({ metadata });
    assert.throws(() => api.readJiraProject(data.exec), /category|Done|Ready/i);
    assert.equal(data.calls.some(({ method }) => method !== 'GET'), false);
    assert.equal(data.calls.some(({ path }) => path.includes('/search/') || path.includes('/issue/')), false);
  }
  const missing = clone(METADATA).map((type) => ({ ...type, statuses: type.statuses.filter(({ id }) => id !== '11') }));
  const wrongHierarchy = clone(PROJECT);
  wrongHierarchy.issueTypes[0].hierarchyLevel = 0;
  for (const options of [{ metadata: missing }, { project: wrongHierarchy }, { project: { ...clone(PROJECT), id: '' } }, { links: { issueLinkTypes: [] } }]) {
    assert.throws(() => api.readJiraProject(provider(options).exec), /Jira|status|type|project|link/i);
  }
});

test('Jira child evidence refuses visible cross-project children', async (t) => {
  const { readJiraChildren } = await reader(t);
  const native = provider();
  const visibleChildren = [clone(ISSUES['ENG-2']), {
    id: '90001', key: 'OPS-1', fields: {
      ...clone(ISSUES['ENG-2'].fields), project: { id: '90000', key: 'OPS' },
      parent: { id: '20001', key: 'ENG-1' },
    },
  }];
  const exec = (request) => {
    if (request.path !== '/rest/api/3/search/jql') return native.exec(request);
    assert.equal(request.method, 'GET');
    assert.match(request.query.jql, /\bparent\s*=\s*ENG-1\b/);
    // A project predicate hides visible children belonging to another project.
    const project = /\bproject\s*=\s*([A-Z][A-Z0-9]+)\b/.exec(request.query.jql)?.[1];
    const issues = visibleChildren.filter((child) => project === undefined || child.fields.project.key === project);
    return { issues: clone(issues), isLast: true, total: issues.length };
  };
  assert.throws(() => readJiraChildren('ENG-1', exec), /outside configured project|different project|foreign/i);
});

test('Jira native text preserves link targets without hiding malformed links', async (t) => {
  const { adfText } = await reader(t);
  // Jira's link mark stores its required URI in attrs.href.
  // https://developer.atlassian.com/cloud/jira/platform/apis/document/marks/link/
  const document = { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [
      { type: 'text', text: 'Specification', marks: [{ type: 'link', attrs: { href: 'https://example.test/spec' } }] },
    ] },
  ] };
  const rendered = adfText(document);
  assert.ok(rendered.includes('Specification'), 'native link label must remain readable');
  assert.ok(rendered.includes('https://example.test/spec'), 'native link target must remain readable');

  const urlLabel = clone(document);
  urlLabel.content[0].content[0].text = 'https://example.test/spec';
  assert.equal(adfText(urlLabel).split('https://example.test/spec').length - 1, 1, 'a URL label must not duplicate its target');

  for (const attrs of [{}, { href: 42 }, { href: ' ' }]) {
    const malformed = clone(document);
    malformed.content[0].content[0].marks = [{ type: 'link', attrs }];
    assert.throws(() => adfText(malformed), /link.*(?:href|target|URI)|(?:href|target|URI).*link/i);
  }
});

test('Jira link labels cannot hide shorter targets', async (t) => {
  const { adfText } = await reader(t);
  for (const label of ['https://example.test/specification', 'https://example.test/spec/more']) {
    const document = { type: 'doc', version: 1, content: [
      { type: 'paragraph', content: [
        { type: 'text', text: label, marks: [{ type: 'link', attrs: { href: 'https://example.test/spec' } }] },
      ] },
    ] };
    const rendered = adfText(document);
    assert.ok(rendered.includes(label), 'the full native link label must remain readable');
    const urls = rendered.match(/https:\/\/example\.test\/[a-z/]+/g) ?? [];
    assert.ok(urls.includes('https://example.test/spec'), 'the actual shorter link destination must remain separately readable');
  }
});

test('Jira native document roots require complete content arrays', async (t) => {
  const api = await reader(t);
  // https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/doc/
  const empty = { type: 'doc', version: 1, content: [] };
  assert.equal(api.adfText(null), '');
  assert.equal(api.adfText(empty), '');
  const completeIssues = clone(ISSUES);
  completeIssues['ENG-2'].fields.description = empty;
  const complete = provider({ issues: completeIssues });
  const valid = api.jiraCardDetails(complete.exec, ['ENG-2']).get('ENG-2');
  assert.equal(valid.unavailable, undefined);
  assert.equal(valid.body, '');
  assert.deepEqual(complete.calls.filter(({ path }) => path.endsWith('/comment')).map(({ query }) => query.startAt), [0, 1]);

  for (const document of [{ type: 'doc', version: 1 }, { type: 'doc', version: 1, content: null }]) {
    assert.throws(() => api.adfText(document), /ADF.*content|content.*ADF/i);
    const issues = clone(ISSUES);
    issues['ENG-2'].fields.description = document;
    const description = api.jiraCardDetails(provider({ issues }).exec, ['ENG-2']).get('ENG-2');
    assert.match(description.unavailable, /ADF.*content|content.*ADF/i);
    assert.equal(description.body, undefined);

    const comments = provider({ commentPages: {
      0: { startAt: 0, maxResults: 1, total: 2, comments: [clone(COMMENT_2)] },
      1: { startAt: 1, maxResults: 1, total: 2, comments: [{ ...clone(COMMENT_1), body: document }] },
    } });
    const comment = api.jiraCardDetails(comments.exec, ['ENG-2']).get('ENG-2');
    assert.match(comment.unavailable, /ADF.*content|content.*ADF/i);
    assert.equal(comment.body, undefined);
    assert.equal(comment.comments, undefined);
    assert.deepEqual(comments.calls.filter(({ path }) => path.endsWith('/comment')).map(({ query }) => query.startAt), [0, 1]);
  }
  assert.throws(() => api.adfText(undefined), /ADF|description|document/i);
});

test('Jira board batches complete child evidence without hiding foreign children', async (t) => {
  const { readJiraBoard } = await reader(t);
  const scanned = Array.from({ length: 51 }, (_, index) => ({
    ...clone(ISSUES['ENG-1']), id: String(21001 + index), key: 'ENG-' + (1001 + index),
    fields: { ...clone(ISSUES['ENG-1'].fields), summary: 'Scanned issue ' + (index + 1), status: index === 50 ? STATES[5] : STATES[1] },
  }));
  for (const index of [49, 50]) {
    scanned[index].fields.parent = { id: '21001', key: 'ENG-1001' };
    scanned[index].fields.issuetype = { id: '10002' };
    scanned[index].fields.labels = ['task'];
  }
  const children = [clone(scanned[49]), clone(scanned[50])];
  const keys = scanned.map(({ key }) => key);
  const fields = ['summary', 'status', 'project', 'issuetype', 'labels', 'assignee', 'parent', 'issuelinks', 'description'];
  const fixture = (scenario = 'complete') => {
    const base = provider({ issuePages: { '': { issues: scanned, isLast: true, total: 51 } }, pulls: [[]] });
    const calls = [];
    const batches = [
      { '': { issues: children, isLast: true, total: 2 } },
      { '': { issues: [], isLast: true, total: 0 } },
    ];
    if (scenario === 'foreign') {
      batches[0] = {
        '': { issues: [children[0]], isLast: false, nextPageToken: 'later', total: 2 },
        later: { issues: [{ ...clone(children[1]), id: '90001', key: 'OPS-1', fields: {
          ...clone(children[1].fields), project: { id: '90000', key: 'OPS' },
        } }], isLast: true, total: 2 },
      };
    } else if (scenario === 'cursor') {
      batches[0] = {
        '': { issues: [children[0]], isLast: false, nextPageToken: 'again', total: 2 },
        again: { issues: [children[1]], isLast: false, nextPageToken: 'again', total: 2 },
      };
    } else if (scenario === 'parent') {
      const wrongParent = clone(children[0]);
      wrongParent.fields.parent.id = '99999';
      batches[0][''].issues = [wrongParent, children[1]];
    } else if (scenario === 'duplicate') {
      const repeated = clone(children[0]);
      repeated.fields.parent = { id: '21051', key: 'ENG-1051' };
      batches[1][''] = { issues: [repeated], isLast: true, total: 1 };
    }
    const exec = (request) => {
      calls.push(clone(request));
      assert.ok(calls.length <= 100, 'fixture read must progress');
      const { method, path, query = {}, body } = request;
      if (method === 'POST' && path === '/rest/api/3/search/jql') {
        assert.deepEqual(body.fields, fields);
        assert.equal(body.maxResults, 100);
        assert.doesNotMatch(body.jql, /\bproject\b/i, 'child search must not hide foreign project children');
        const match = /^parent IN \(([^)]+)\) ORDER BY key ASC$/i.exec(body.jql);
        assert.ok(match, 'expected a native parent-IN search');
        const requested = match[1].split(',').map((key) => key.trim().replace(/^"|"$/g, ''));
        assert.ok(requested.length <= 50, 'a child batch has at most 50 scanned parent keys');
        const batch = requested.includes('ENG-1001') ? 0 : 1;
        assert.deepEqual(requested, batch === 0 ? keys.slice(0, 50) : keys.slice(50));
        const page = batches[batch][body.nextPageToken ?? ''];
        assert.ok(page, 'recorded child page must exist');
        return clone(page);
      }
      assert.equal(method, 'GET', 'only exact POST enhanced search is a read');
      if (path === '/rest/api/3/search/jql') {
        const parent = /^parent = (ENG-\d+) ORDER BY key ASC$/.exec(query.jql);
        if (parent) {
          assert.ok(keys.includes(parent[1]));
          const rows = parent[1] === 'ENG-1001' ? children : [];
          return { issues: clone(rows), isLast: true, total: rows.length };
        }
      }
      const direct = scanned.find(({ key }) => path === '/rest/api/3/issue/' + key);
      return direct ? clone(direct) : base.exec(request);
    };
    return { exec, gh: base.gh, calls };
  };
  const native = fixture();
  const board = readJiraBoard(native.exec, native.gh);
  assert.equal(board.items.length, 51);
  assert.deepEqual(board.items[0].content.subIssuesSummary, { total: 2, completed: 1 });
  for (const item of board.items.slice(1)) assert.deepEqual(item.content.subIssuesSummary, { total: 0, completed: 0 });
  const batches = native.calls.filter(({ method, path, body }) => method === 'POST' && path === '/rest/api/3/search/jql' && body.nextPageToken === undefined);
  assert.equal(batches.length, 2, '51 scanned parent keys require exactly two native POST child batches');
  assert.equal(native.calls.filter(({ method, query }) => method === 'GET' && /^parent = /.test(query?.jql ?? '')).length, 0);
  assert.ok(batches[1].body.jql.includes('ENG-1051'), 'Done issues still receive child evidence');
  for (const [scenario, cause] of [
    ['foreign', /outside configured project|different project|foreign/i],
    ['cursor', /cursor|progress|incomplete/i],
    ['parent', /parent|identity|ID/i],
    ['duplicate', /duplicate/i],
  ]) {
    const invalid = fixture(scenario);
    assert.throws(() => readJiraBoard(invalid.exec, invalid.gh), cause, scenario);
  }
});

test('Jira board reuses direct relationship reads without trusting search freshness', async (t) => {
  const { readJiraBoard } = await reader(t);
  const issues = clone(ISSUES);
  issues['ENG-3'].fields.issuelinks = [{ id: '40002', type: { id: '10003' }, inwardIssue: { id: '20001', key: 'ENG-1' } }];
  const directParent = clone(ISSUES['ENG-1']);
  directParent.fields.status = STATES[5];
  const native = provider({ issues, directIssues: { 'ENG-1': directParent } });
  const first = readJiraBoard(native.exec, native.gh);
  assert.deepEqual(first.items[1].blockers, [{ number: 'ENG-1', state: 'CLOSED' }]);
  assert.deepEqual(first.items[2].blockers, [{ number: 'ENG-1', state: 'CLOSED' }]);
  const directReads = () => native.calls.filter(({ method, path }) => method === 'GET' && path === '/rest/api/3/issue/ENG-1').length;
  assert.equal(directReads(), 1, 'parent and inward blockers share one fresh direct GET per board call');
  directParent.fields.status = STATES[1];
  const second = readJiraBoard(native.exec, native.gh);
  assert.deepEqual(second.items[1].blockers, [{ number: 'ENG-1', state: 'OPEN' }]);
  assert.equal(directReads(), 2, 'a second board call fetches direct evidence anew');
  const conflicting = clone(issues);
  conflicting['ENG-3'].fields.issuelinks[0].inwardIssue.id = '99999';
  const mismatch = provider({ issues: conflicting, directIssues: { 'ENG-1': directParent } });
  assert.throws(() => readJiraBoard(mismatch.exec, mismatch.gh), /relationship.*ID|another issue ID|identity/i);
});

test('Jira outward links do not resolve non-blockers', async (t) => {
  const { readJiraBoard } = await reader(t);
  const issues = clone(ISSUES);
  const foreign = { id: '90001', key: 'OPS-1' };
  issues['ENG-2'].fields.issuelinks = [{ id: '40001', type: { id: '10003' }, outwardIssue: foreign }];
  const outward = provider({ issues });
  const board = readJiraBoard(outward.exec, outward.gh);
  assert.deepEqual(board.items[1].blockers, []);
  assert.equal(outward.calls.some(({ path }) => path === '/rest/api/3/issue/OPS-1'), false);
  issues['ENG-2'].fields.issuelinks = [{ id: '40001', type: { id: '10003' }, inwardIssue: foreign }];
  const inward = provider({ issues });
  assert.throws(() => readJiraBoard(inward.exec, inward.gh), /outside configured project|different project|foreign/i);
  for (const link of [
    { id: '40001', type: { id: '10003' }, inwardIssue: foreign, outwardIssue: foreign },
    { type: { id: '10003' }, outwardIssue: foreign },
  ]) {
    const malformed = clone(ISSUES);
    malformed['ENG-2'].fields.issuelinks = [link];
    const invalid = provider({ issues: malformed });
    assert.throws(() => readJiraBoard(invalid.exec, invalid.gh), /malformed|ambiguous|link/i);
  }
});

test('Jira inline cards preserve native URLs and reject unavailable meaning', async (t) => {
  const api = await reader(t);
  // https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/inlineCard/
  const url = 'https://example.test/spec';
  const document = { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url } }] },
  ] };
  assert.equal(api.adfText(document), url);
  const issues = clone(ISSUES);
  issues['ENG-2'].fields.description = document;
  const claim = { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Claim: ' }, { type: 'inlineCard', attrs: { url } }] },
  ] };
  const pages = {
    0: { startAt: 0, maxResults: 1, total: 2, comments: [clone(COMMENT_2)] },
    1: { startAt: 1, maxResults: 1, total: 2, comments: [{ ...clone(COMMENT_1), body: claim }] },
  };
  const details = api.jiraCardDetails(provider({ issues, commentPages: pages }).exec, ['ENG-2']).get('ENG-2');
  assert.equal(details.unavailable, undefined);
  assert.equal(details.body, url);
  assert.deepEqual(details.comments, ['Claim: ' + url, 'second']);
  for (const attrs of [undefined, {}, { url: '' }, { url: ' ' }, { url: 42 }, { data: { '@id': url } }, { url, data: { '@id': url } }]) {
    const invalidDocument = clone(document);
    invalidDocument.content[0].content[0] = { type: 'inlineCard', ...(attrs === undefined ? {} : { attrs }) };
    assert.throws(() => api.adfText(invalidDocument), /ADF|inlineCard|URL|unsupported/i);
    const invalidIssues = clone(ISSUES);
    invalidIssues['ENG-2'].fields.description = invalidDocument;
    const unavailable = api.jiraCardDetails(provider({ issues: invalidIssues }).exec, ['ENG-2']).get('ENG-2');
    assert.match(unavailable.unavailable, /ADF|inlineCard|URL|unsupported/i);
    assert.equal(unavailable.body, undefined);
    const invalidPages = clone(pages);
    invalidPages[1].comments[0].body = invalidDocument;
    const unavailableComment = api.jiraCardDetails(provider({ commentPages: invalidPages }).exec, ['ENG-2']).get('ENG-2');
    assert.match(unavailableComment.unavailable, /ADF|inlineCard|URL|unsupported/i);
    assert.equal(unavailableComment.comments, undefined);
  }
  const media = { type: 'doc', version: 1, content: [{ type: 'media', attrs: { id: 'media-1', type: 'file', collection: 'documents' } }] };
  assert.throws(() => api.adfText(media), /ADF|media|unsupported/i);
  const unsupported = clone(ISSUES);
  unsupported['ENG-2'].fields.description = media;
  assert.match(api.jiraCardDetails(provider({ issues: unsupported }).exec, ['ENG-2']).get('ENG-2').unavailable, /ADF|media|unsupported/i);
});
