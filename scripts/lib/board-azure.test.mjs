// Literal native API examples and hand-worked totals; no live provider or subprocess per case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyToolkit, AZURE_TEST_CONFIG } from './board-toolkit-copy.mjs';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ROOT = `/${PROJECT}/_apis/wit`;
const BASE = 'https://dev.azure.com/example-org';
const AS_OF = '2026-10-29T12:00:00.000Z';
const STATES = [
  { name: 'New', category: 'Proposed' }, { name: 'Ready', category: 'Proposed' },
  { name: 'Active', category: 'InProgress' }, { name: 'Awaiting Push', category: 'Resolved' },
  { name: 'In Review', category: 'Resolved' }, { name: 'Closed', category: 'Completed' },
];
const RELATIONS = [
  ['System.LinkTypes.Hierarchy-Forward', 'System.LinkTypes.Hierarchy-Reverse'],
  ['System.LinkTypes.Hierarchy-Reverse', 'System.LinkTypes.Hierarchy-Forward'],
  ['System.LinkTypes.Dependency-Forward', 'System.LinkTypes.Dependency-Reverse'],
  ['System.LinkTypes.Dependency-Reverse', 'System.LinkTypes.Dependency-Forward'],
].map(([referenceName, oppositeEndReferenceName]) => ({ referenceName, attributes: {
  enabled: true, directional: true, usage: 'workItemLink', oppositeEndReferenceName,
} }));
const link = (rel, id) => ({ rel: 'System.LinkTypes.' + rel, url: `${BASE}/_apis/wit/workItems/${id}` });
const ITEMS = [
  { id: 297, rev: 5, fields: { 'System.TeamProject': 'Native Project', 'System.WorkItemType': 'Epic', 'System.State': 'Ready', 'System.Title': 'Parent', 'System.Tags': 'epic; untouched', 'System.Description': '<p>Parent acceptance</p>' }, relations: [link('Hierarchy-Forward', 299)] },
  { id: 299, rev: 5, fields: { 'System.TeamProject': 'Native Project', 'System.WorkItemType': 'Task', 'System.State': 'Closed', 'System.Title': 'Child', 'System.Tags': 'task', 'System.AssignedTo': { id: VIEWER, displayName: 'Identical name', uniqueName: 'other@example.test' }, 'System.Description': '<p>Acceptance <a href="https://example.test/hidden">visible label</a></p>' }, relations: [link('Hierarchy-Reverse', 297), link('Dependency-Reverse', 300), link('Dependency-Forward', 297)] },
  { id: 300, rev: 9, fields: { 'System.TeamProject': 'Native Project', 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'Blocker', 'System.Tags': 'bug' }, relations: [] },
];
const COMMENTS = [
  { id: 71, workItemId: 299, version: 1, text: '<p>Claim: active <a href="https://example.test/claim">evidence</a></p>', format: 'html', createdBy: { id: VIEWER, displayName: 'Identical name' }, createdDate: '2026-10-29T10:00:00Z', isDeleted: false },
  { commentId: 72, workItemId: 299, version: 2, text: 'Claim withdrawn: released', format: 'markdown', createdBy: { id: OTHER, displayName: 'Identical name' }, createdDate: '2026-10-29T11:00:00Z', isDeleted: false },
];
const PULL = { number: 10, state: 'open', draft: true, head: { ref: 'job/AB-299', repo: { full_name: 'example-owner/example-repo' } }, base: { ref: 'main', repo: { full_name: 'example-owner/example-repo' } }, merged_at: null,
  body: `Closes AB-299\nAzure Boards: ${BASE}/${PROJECT}/_workitems/edit/299` };
const clone = structuredClone;

async function reader(t, config = AZURE_TEST_CONFIG) {
  const toolkit = copyToolkit(config);
  t.after(toolkit.cleanup);
  return { ...await toolkit.load('lib/board-azure.mjs'), ...await toolkit.load('lib/board.mjs'), ...await toolkit.load('lib/board-rules.mjs') };
}

function provider(options = {}) {
  const calls = [];
  const exec = (request) => {
    calls.push(clone(request));
    assert.ok(calls.length < 100, 'native reads must make progress');
    const { method, path, query, body } = request;
    let result;
    if (path === '/_apis/profile/profiles/me') {
      assert.deepEqual(request, { method: 'GET', path, profile: true, query: { 'api-version': '7.1', details: true } });
      result = options.profile ?? { id: VIEWER, emailAddress: 'viewer@example.test', displayName: 'Identical name' };
    } else if (path === '/_apis/projects/' + PROJECT) {
      assert.equal(method, 'GET');
      result = options.project ?? { id: PROJECT, name: 'Native Project' };
    } else if (path === ROOT + '/workitemtypes') {
      assert.equal(method, 'GET');
      result = options.types ?? { count: 4, value: ['Epic', 'User Story', 'Task', 'Bug'].map((name) => ({ name, isDisabled: false })) };
    } else if (/\/workitemtypes\/[^/]+\/states$/.test(path)) {
      assert.equal(method, 'GET');
      assert.ok(['Epic', 'User%20Story', 'Task', 'Bug'].some((type) => path === ROOT + '/workitemtypes/' + type + '/states'));
      result = options.states ?? { count: 6, value: STATES };
    } else if (path === '/_apis/wit/workitemrelationtypes') {
      assert.equal(method, 'GET');
      result = options.relations ?? { count: 4, value: RELATIONS };
    } else if (path === ROOT + '/wiql') {
      assert.equal(method, 'POST');
      assert.deepEqual(query, { 'api-version': '7.1' });
      assert.deepEqual(body, { query: 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.Id] ASC' });
      result = options.wiql ?? { queryType: 'flat', asOf: AS_OF, workItems: [{ id: 297 }, { id: 299 }, { id: 300 }] };
    } else if (path === ROOT + '/workitemsbatch') {
      assert.equal(method, 'POST');
      assert.ok(body.ids.length <= 200);
      assert.deepEqual(body, { ids: [297, 299, 300], asOf: AS_OF, errorPolicy: 'Fail', $expand: 'All' });
      result = options.batch ?? { count: 3, value: options.items ?? ITEMS };
    } else if (path === ROOT + '/workitems/299/comments') {
      assert.equal(method, 'GET');
      const token = query.continuationToken ?? '';
      assert.deepEqual(query, { 'api-version': '7.1-preview.4', $top: 100, includeDeleted: true, order: 'asc', ...(token ? { continuationToken: token } : {}) });
      result = (options.pages ?? {
        '': { count: 1, totalCount: 2, comments: [COMMENTS[0]], continuationToken: 'next', nextPage: 'https://foreign.test/do-not-fetch' },
        next: { count: 1, totalCount: 2, comments: [COMMENTS[1]] },
      })[token];
    } else {
      assert.equal(method, 'GET');
      assert.deepEqual(query, { 'api-version': '7.1', $expand: 'All' });
      const id = Number(path.slice((ROOT + '/workitems/').length));
      assert.equal(path, ROOT + '/workitems/' + id);
      result = options.direct?.[id] ?? (options.items ?? ITEMS).find((item) => item.id === id);
    }
    if (result instanceof Error) throw result;
    assert.ok(result !== undefined, 'fixture must contain the requested native evidence');
    return clone(result);
  };
  const gh = (args) => {
    assert.deepEqual(args, ['api', 'repos/example-owner/example-repo/pulls?state=all&per_page=100', '--paginate', '--slurp']);
    if (options.ghError) throw options.ghError;
    return JSON.stringify(options.pulls ?? [[PULL]]);
  };
  return { exec, gh, calls };
}

test('Azure reads bind exact project mappings and native identities', async (t) => {
  const api = await reader(t);
  const native = provider();
  const project = api.readAzureProject(native.exec);
  assert.equal(project.id, PROJECT);
  assert.equal(project.name, 'Native Project');
  assert.equal(project.viewer.id, VIEWER);
  assert.equal(project.viewer.emailAddress, 'viewer@example.test');
  assert.equal(project.columnOf('Task', 'Closed'), 'Done');
  assert.equal(api.readAzureIssue('AB-299', native.exec).id, 299);
  assert.throws(() => api.readAzureIssue(299, native.exec), /AB-|identifier/i);
  const boardStart = native.calls.length;
  const board = api.readAzureBoard(native.exec, native.gh);
  assert.equal(native.calls.slice(boardStart).filter(({ path }) => [ROOT + '/workitems/297', ROOT + '/workitems/299', ROOT + '/workitems/300'].includes(path)).length, 0);
  assert.equal(board.items.length, 3);
  assert.deepEqual(board.items[0].content.subIssuesSummary, { total: 1, completed: 1 });
  assert.deepEqual(board.items[1].content.subIssuesSummary, { total: 0, completed: 0 });
  assert.deepEqual(board.items[1].assignees, [VIEWER]);
  assert.deepEqual(board.items[0].labels, ['epic', 'untouched']);
  assert.deepEqual(board.items[1].blockers, [{ number: 'AB-300', state: 'OPEN' }]);
  assert.equal(board.items[1].status, 'Done');
  assert.equal(board.items[1].content.number, 'AB-299');
  assert.equal(board.items[1].content.state, 'CLOSED');
  assert.deepEqual(api.readAzureChildren('AB-297', native.exec), { issues: [ITEMS[1]], total: 1, completed: 1 });
  for (const options of [
    { project: { id: OTHER, name: 'Native Project' } },
    { profile: { id: 'same-display-name', emailAddress: 'viewer@example.test' } },
    { profile: { id: VIEWER, emailAddress: '' } },
    { types: { count: 3, value: [{ name: 'Epic' }, { name: 'Task' }, { name: 'Bug' }] } },
    { states: { count: 6, value: STATES.map((state) => state.name === 'Closed' ? { ...state, category: 'Removed' } : state) } },
    { states: { count: 6, value: STATES.map((state) => state.name === 'Ready' ? { ...state, category: 'Completed' } : state) } },
    { relations: { count: 4, value: RELATIONS.map((relation, index) => index === 3 ? { ...relation, attributes: { ...relation.attributes, oppositeEndReferenceName: 'wrong' } } : relation) } },
  ]) assert.throws(() => api.readAzureProject(provider(options).exec), /Azure|identity|metadata|mapping|project|profile/i);
  for (const mutate of [
    (item) => { item.fields['System.TeamProject'] = 'Foreign Project'; },
    (item) => { item.fields['System.WorkItemType'] = 'Unknown'; },
    (item) => { item.fields['System.State'] = 'Unknown'; },
    (item) => { item.fields['System.Tags'] = 'bug'; },
    (item) => { item.fields['System.AssignedTo'].id = 'viewer@example.test'; },
    (item) => { item.rev = 0; },
    (item) => { item.id = 300; },
  ]) {
    const item = clone(ITEMS[1]); mutate(item);
    assert.throws(() => api.readAzureIssue('AB-299', provider({ direct: { 299: item } }).exec), /Azure|mapping|project|identity/i);
  }
  for (const tags of ['', 'task; bug']) {
    const items = clone(ITEMS); items[1].fields['System.Tags'] = tags;
    const data = provider({ items });
    const boardWithDrift = api.readAzureBoard(data.exec, data.gh);
    assert.deepEqual(boardWithDrift.items[1].labels, tags ? ['task', 'bug'] : [], 'missing/multiple kind tags remain visible for common advisory assessment');
  }
});

test('Azure reads reject incomplete items comments and relationships', async (t) => {
  const api = await reader(t);
  const firstBatchIds = [
    1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009,
    1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019,
    1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029,
    1030, 1031, 1032, 1033, 1034, 1035, 1036, 1037, 1038, 1039,
    1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047, 1048, 1049,
    1050, 1051, 1052, 1053, 1054, 1055, 1056, 1057, 1058, 1059,
    1060, 1061, 1062, 1063, 1064, 1065, 1066, 1067, 1068, 1069,
    1070, 1071, 1072, 1073, 1074, 1075, 1076, 1077, 1078, 1079,
    1080, 1081, 1082, 1083, 1084, 1085, 1086, 1087, 1088, 1089,
    1090, 1091, 1092, 1093, 1094, 1095, 1096, 1097, 1098, 1099,
    1100, 1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109,
    1110, 1111, 1112, 1113, 1114, 1115, 1116, 1117, 1118, 1119,
    1120, 1121, 1122, 1123, 1124, 1125, 1126, 1127, 1128, 1129,
    1130, 1131, 1132, 1133, 1134, 1135, 1136, 1137, 1138, 1139,
    1140, 1141, 1142, 1143, 1144, 1145, 1146, 1147, 1148, 1149,
    1150, 1151, 1152, 1153, 1154, 1155, 1156, 1157, 1158, 1159,
    1160, 1161, 1162, 1163, 1164, 1165, 1166, 1167, 1168, 1169,
    1170, 1171, 1172, 1173, 1174, 1175, 1176, 1177, 1178, 1179,
    1180, 1181, 1182, 1183, 1184, 1185, 1186, 1187, 1188, 1189,
    1190, 1191, 1192, 1193, 1194, 1195, 1196, 1197, 1198, 1199,
  ];
  const secondBatchIds = [1200];
  const expectedIds = [...firstBatchIds, ...secondBatchIds];
  const expectedBatches = [firstBatchIds, secondBatchIds];
  const responses = expectedBatches.map((ids) => ({ count: ids.length, value: ids.map((id) => ({
    id, rev: 5, fields: {
      'System.TeamProject': 'Native Project', 'System.WorkItemType': 'Task',
      'System.State': 'Ready', 'System.Title': 'Task ' + id, 'System.Tags': 'task',
    }, relations: [],
  })) }));
  const nativeBatches = provider({ pulls: [[]] });
  let wiqlCount = 0;
  let batchCount = 0;
  const batchExec = (request) => {
    if (request.path === ROOT + '/wiql') {
      wiqlCount++;
      assert.deepEqual(request, { method: 'POST', path: ROOT + '/wiql', query: { 'api-version': '7.1' }, body: {
        query: 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.Id] ASC',
      } });
      return { queryType: 'flat', asOf: AS_OF, workItems: expectedIds.map((id) => ({ id })) };
    }
    if (request.path === ROOT + '/workitemsbatch') {
      assert.ok(request.body.ids.length <= 200, 'the native batch accepts at most 200 IDs');
      assert.deepEqual(request, { method: 'POST', path: ROOT + '/workitemsbatch', query: { 'api-version': '7.1' }, body: {
        ids: expectedBatches[batchCount], asOf: AS_OF, errorPolicy: 'Fail', $expand: 'All',
      } });
      return clone(responses[batchCount++]);
    }
    return nativeBatches.exec(request);
  };
  const completeBatches = api.readAzureBoard(batchExec, nativeBatches.gh);
  assert.equal(wiqlCount, 1);
  assert.equal(batchCount, 2, '201 IDs require the explicit first 200 and final one');
  assert.equal(completeBatches.items.length, 201);
  assert.equal(new Set(completeBatches.items.map(({ id }) => id)).size, 201);
  assert.deepEqual(completeBatches.items.map(({ id }) => id), expectedIds);
  for (const options of [
    { batch: { count: 2, value: [ITEMS[0], ITEMS[2]] } },
    { batch: { count: 3, value: [ITEMS[0], ITEMS[0], ITEMS[2]] } },
    { wiql: { queryType: 'flat', asOf: AS_OF, workItems: [{ id: 297 }, { id: 297 }] } },
    { wiql: { queryType: 'tree', asOf: AS_OF, workItems: [] } },
    { wiql: { queryType: 'flat', workItems: [] } },
  ]) { const native = provider(options); assert.throws(() => api.readAzureBoard(native.exec, native.gh), /Azure|batch|duplicate|incomplete/i); }
  for (const change of [
    (items) => { items[1].fields['System.State'] = 'Unknown'; },
    (items) => { items[1].fields['System.TeamProject'] = 'Foreign Project'; },
    (items) => { items[1].relations = []; },
  ]) {
    const items = clone(ITEMS); change(items);
    assert.throws(() => api.readAzureChildren('AB-297', provider({ items }).exec), /Azure|child|project|mapping/i);
  }
  assert.throws(() => api.readAzureChildren('AB-297', provider({ direct: { 299: new Error('child inaccessible') } }).exec), /inaccessible/i);
  for (const url of [`${BASE}/Other/_apis/wit/workItems/300`, 'https://foreign.test/_apis/wit/workItems/300', `${BASE}/_apis/wit/workItems/300?secret=value`, `${BASE}:443/_apis/wit/workItems/300`, `${BASE}/_apis/wit/workItems/0`]) {
    const items = clone(ITEMS); items[1].relations[1].url = url;
    const native = provider({ items });
    assert.throws(() => api.readAzureBoard(native.exec, native.gh), /Azure|relationship|target|URL/i);
  }
  const opposite = clone(ITEMS);
  opposite[1].relations = [link('Hierarchy-Reverse', 297), link('Dependency-Forward', 300), link('Dependency-Reverse', 297)];
  const directions = provider({ items: opposite });
  assert.deepEqual(api.readAzureBoard(directions.exec, directions.gh).items[1].blockers, [{ number: 'AB-297', state: 'OPEN' }]);
  const first = { count: 1, totalCount: 2, comments: [COMMENTS[0]], continuationToken: 'next' };
  for (const pages of [
    { '': first, next: new Error('later comment page inaccessible') },
    { '': first, next: { count: 1, totalCount: 2, comments: [COMMENTS[0]] } },
    { '': first, next: { count: 1, totalCount: 2, comments: [COMMENTS[1]], continuationToken: 'next' } },
    { '': { count: 0, totalCount: 2, comments: [], continuationToken: 'next' } },
    { '': { ...first, continuationToken: undefined } },
    { '': first, next: { count: 1, totalCount: 3, comments: [COMMENTS[1]] } },
    { '': { count: 1, totalCount: 1, comments: [{ ...COMMENTS[0], workItemId: 300 }] } },
    { '': { count: 1, totalCount: 1, comments: [{ ...COMMENTS[0], commentId: 99 }] } },
    { '': { count: 1, totalCount: 1, comments: [{ ...COMMENTS[0], createdBy: { id: 'email@example.test' } }] } },
  ]) {
    const details = api.azureCardDetails(provider({ pages }).exec, ['AB-299']).get('AB-299');
    assert.match(details.unavailable, /comment|page|incomplete|cursor|identity|author/i);
    assert.equal(details.comments, undefined);
  }
  const limited = Object.assign(new Error('Azure rate limit'), { rateLimited: true });
  const rate = provider({ pages: { '': limited } });
  const unavailable = api.azureCardDetails(rate.exec, ['AB-299', 'AB-300']);
  assert.match(unavailable.get('AB-300').unavailable, /rate limit/);
  assert.equal(rate.calls.some(({ path }) => path === ROOT + '/workitems/300'), false);
});

test('Azure evidence preserves native text and GitHub delivery boundaries', async (t) => {
  const api = await reader(t);
  const native = provider();
  const comments = api.readAzureComments('AB-299', native.exec);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].nativeFormat, 'html');
  assert.equal(comments[1].nativeFormat, 'markdown');
  assert.deepEqual(comments.map(({ id, accountId, body, format, position }) => ({ id, accountId, body, format, position })), [
    { id: 71, accountId: VIEWER, body: COMMENTS[0].text, format: 'html', position: 1 },
    { id: 72, accountId: OTHER, body: COMMENTS[1].text, format: 'markdown', position: 2 },
  ]);
  const detail = api.azureCardDetails(native.exec, ['AB-299']).get('AB-299');
  assert.equal(detail.body, ITEMS[1].fields['System.Description']);
  assert.equal(detail.bodyFormat, 'html');
  assert.equal(detail.parent, 'AB-297');
  assert.equal(detail.commentCount, 2);
  assert.match(detail.claim, /review.*native comments/i);
  assert.doesNotMatch(detail.claim, /none/i);
  assert.ok(detail.comments[0].includes(COMMENTS[0].text));
  assert.ok(detail.comments[1].includes(COMMENTS[1].text));
  assert.ok(detail.comments[0].includes(VIEWER));
  assert.ok(detail.comments[1].includes(OTHER));
  const tombstone = { ...COMMENTS[1], id: 72, isDeleted: true, text: 'Claim: deleted', format: undefined };
  const deleted = provider({ pages: { '': { count: 1, totalCount: 1, comments: [tombstone] } } });
  const deletedComments = api.readAzureComments('AB-299', deleted.exec);
  assert.equal(deletedComments[0].isDeleted, true);
  assert.equal(deletedComments[0].format, 'unknown legacy');
  assert.equal(deletedComments[0].nativeFormat, null);
  for (const format of ['legacy-native-text', null]) {
    const legacy = provider({ pages: { '': { count: 1, totalCount: 1, comments: [{ ...COMMENTS[0], format }] } } });
    const comment = api.readAzureComments('AB-299', legacy.exec)[0];
    assert.equal(comment.body, COMMENTS[0].text);
    assert.equal(comment.format, 'unknown legacy');
    assert.equal(comment.nativeFormat, format);
    if (typeof format === 'string') assert.ok(api.azureCardDetails(legacy.exec, ['AB-299']).get('AB-299').comments[0].includes(format));
  }
  const malformedFormat = provider({ pages: { '': { count: 1, totalCount: 1, comments: [{ ...COMMENTS[0], format: {} }] } } });
  assert.match(api.azureCardDetails(malformedFormat.exec, ['AB-299']).get('AB-299').unavailable, /comment|format|native/i);
  assert.match(api.azureCardDetails(deleted.exec, ['AB-299']).get('AB-299').comments[0], /deleted.*Claim: deleted/is);
  assert.deepEqual(api.readAzureBoard(native.exec, native.gh).items[1].closingPullRequests, [{ number: 10 }]);
  const merged = { ...clone(PULL), state: 'closed', merged_at: '2026-10-29T11:00:00Z' };
  const accepted = provider({ pulls: [[], [merged]] });
  assert.deepEqual(api.readAzureBoard(accepted.exec, accepted.gh).items[1].closingPullRequests, [{ number: 10 }]);
  for (const change of [
    (pull) => { pull.head.ref = 'job/299'; },
    (pull) => { pull.head.repo.full_name = 'foreign/repo'; },
    (pull) => { pull.base.repo.full_name = 'foreign/repo'; },
    (pull) => { pull.base.ref = 'develop'; },
    (pull) => { pull.state = 'closed'; },
    (pull) => { pull.body = PULL.body.replace('Closes AB-299', 'Closes #299'); },
    (pull) => { pull.body = PULL.body.replace('Closes AB-299', 'prefix Closes AB-299'); },
    (pull) => { pull.body = PULL.body.replace(PROJECT, OTHER); },
    (pull) => { pull.body = PULL.body.replace('Azure Boards: ', 'prefix Azure Boards: '); },
    (pull) => { pull.body = 'Closes AB-299'; },
  ]) {
    const pull = clone(PULL); change(pull);
    const data = provider({ pulls: [[pull]] });
    assert.deepEqual(api.readAzureBoard(data.exec, data.gh).items[1].closingPullRequests, []);
  }
  for (const pulls of [[], {}, [[PULL], [PULL]], [[{ ...PULL, draft: undefined }]]]) {
    const data = provider({ pulls });
    assert.throws(() => api.readAzureBoard(data.exec, data.gh), /GitHub|pull|page|duplicate/i);
  }
});
