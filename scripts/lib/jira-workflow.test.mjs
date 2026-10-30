// Common command acceptance uses literal Jira data, injected native reads and exact write transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JIRA_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';

const STATES = [
  { id: '10', name: 'Backlog', statusCategory: { key: 'new' } }, { id: '11', name: 'Ready', statusCategory: { key: 'new' } },
  { id: '12', name: 'In progress', statusCategory: { key: 'indeterminate' } }, { id: '13', name: 'Awaiting push', statusCategory: { key: 'indeterminate' } },
  { id: '14', name: 'In review', statusCategory: { key: 'indeterminate' } }, { id: '15', name: 'Done', statusCategory: { key: 'done' } },
];
const PROJECT = { id: '10000', key: 'ENG', issueTypes: [{ id: '10001', hierarchyLevel: 1 }, { id: '10002', hierarchyLevel: 0 }] };
const ADF = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Acceptance text' }] }] };
const ISSUES = {
  'ENG-1': { id: '20001', key: 'ENG-1', fields: { project: { id: '10000', key: 'ENG' }, summary: 'Parent', status: STATES[1], issuetype: { id: '10001' }, labels: ['epic'], assignee: null, parent: null, issuelinks: [], description: ADF } },
  'ENG-2': { id: '20002', key: 'ENG-2', fields: { project: { id: '10000', key: 'ENG' }, summary: 'Active child', status: STATES[1], issuetype: { id: '10002' }, labels: ['task'], assignee: null, parent: { id: '20001', key: 'ENG-1' }, issuelinks: [], description: ADF } },
  'ENG-3': { id: '20003', key: 'ENG-3', fields: { project: { id: '10000', key: 'ENG' }, summary: 'Done child', status: STATES[5], issuetype: { id: '10002' }, labels: ['task'], assignee: null, parent: { id: '20001', key: 'ENG-1' }, issuelinks: [], description: null } },
};
const CLAIM = { id: '30001', created: '2026-01-01T00:00:00.000Z', author: { accountId: 'acct-self' }, body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Claim: test, Codex, 2026-01-01T00:00Z' }] }] } };
const clone = (value) => structuredClone(value);
function native(options = {}) {
  const issues = clone(options.issues ?? ISSUES);
  if (options.extraIssue) issues['ENG-4'] = { id: '20004', key: 'ENG-4', fields: { ...clone(ISSUES['ENG-2'].fields), parent: null, summary: 'Unrelated' } };
  const calls = [];
  const writes = [];
  const ghCalls = [];
  const steps = [...(options.steps ?? [])];
  const exec = (request) => {
    calls.push(clone(request));
    const { method, path } = request;
    const postSearch = method === 'POST' && path === '/rest/api/3/search/jql';
    const query = postSearch ? request.body : request.query ?? {};
    if (method !== 'GET' && !postSearch) {
      writes.push(clone(request));
      const step = steps.shift();
      assert.ok(step, 'Unexpected Jira mutation: ' + JSON.stringify(request));
      assert.deepEqual(request, step.request);
      if (step.error) throw step.error;
      for (const [key, issue] of Object.entries(step.issues ?? {})) issues[key] = clone(issue);
      return null;
    }
    if (path === '/rest/api/3/project/ENG') return clone(PROJECT);
    if (path === '/rest/api/3/project/ENG/statuses') return clone(options.metadata ?? [{ id: '10001', statuses: STATES }, { id: '10002', statuses: STATES }]);
    if (path === '/rest/api/3/issueLinkType') return { issueLinkTypes: [{ id: '10003', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] };
    if (path === '/rest/api/3/search/jql') {
      const fields = 'summary,status,project,issuetype,labels,assignee,parent,issuelinks,description';
      if (postSearch) {
        assert.deepEqual(query.fields, fields.split(','));
        assert.equal(query.jql, 'parent IN (' + Object.keys(issues).join(', ') + ') ORDER BY key ASC');
      } else assert.equal(query.fields, fields);
      assert.equal(query.maxResults, 100);
      if (query.jql === 'project = ENG ORDER BY key ASC') {
        if (options.empty) return { issues: [], isLast: true, total: 0 };
        const all = Object.values(issues);
        return query.nextPageToken === undefined
          ? { issues: clone(all.slice(0, 2)), isLast: false, nextPageToken: 'board2', total: all.length }
          : { issues: clone(all.slice(2)), isLast: true, total: all.length };
      }
      if (postSearch || query.jql === 'parent = ENG-1 ORDER BY key ASC') {
        if (query.nextPageToken !== undefined && options.childFailure) throw new Error('Jira child page failed');
        const second = options.foreignChild
          ? { id: '90001', key: 'OPS-1', fields: { ...clone(issues['ENG-3'].fields), project: { id: '90000', key: 'OPS' } } }
          : issues[options.duplicateChild ? 'ENG-2' : 'ENG-3'];
        return query.nextPageToken === undefined
          ? { issues: [clone(issues['ENG-2'])], isLast: false, nextPageToken: 'child2', total: 2 }
          : { issues: [clone(second)], isLast: true, total: 2 };
      }
      if (['parent = ENG-2 ORDER BY key ASC', 'parent = ENG-3 ORDER BY key ASC', 'parent = ENG-4 ORDER BY key ASC'].includes(query.jql)) return { issues: [], isLast: true, total: 0 };
      throw new Error('Unexpected native JQL: ' + query.jql);
    }
    const target = /^\/rest\/api\/3\/issue\/(ENG-[1234])(?:\/(transitions|comment))?$/.exec(path);
    if (!target || !issues[target[1]]) throw new Error('Unexpected Jira read: ' + JSON.stringify(request));
    if (!target[2]) return clone(issues[target[1]]);
    if (target[2] === 'transitions') {
      assert.equal(query.expand, 'transitions.fields');
      return clone(options.transitions?.[target[1]] ?? { transitions: [{ id: '22', to: STATES[2], fields: {} }] });
    }
    if (target[1] !== 'ENG-2') return { comments: [], startAt: 0, maxResults: 100, total: 0 };
    if (query.startAt === 1 && options.commentFailure) throw new Error('later comment page failed');
    const comments = [CLAIM, { ...clone(CLAIM), id: '30002', created: '2026-01-02T00:00:00.000Z', body: ADF }];
    return { comments: [clone(comments[query.startAt])], startAt: query.startAt, maxResults: 1, total: 2 };
  };
  const gh = (args) => {
    ghCalls.push(args);
    if (options.noGitHub) throw new Error('publication must not call GitHub');
    assert.deepEqual(args, ['api', 'repos/example-owner/example-repo/pulls?state=all&per_page=100', '--paginate', '--slurp']);
    return '[[]]';
  };
  return { exec, gh, calls, writes, ghCalls, remaining: () => steps.length };
}

const VERIFIED = [
  'issue-publish: board presence verified for ENG-1, ENG-2, ENG-3.',
  'issue-publish: Statuses verified for ENG-1, ENG-2, ENG-3.',
  'issue-publish: exactly one kind label verified for ENG-1, ENG-2, ENG-3.',
  'issue-publish: child set verified: ENG-1 has exactly the 2 supplied child issues.',
];

test('Jira commands preserve complete publication and confirmed transitions', async (t) => {
  const toolkit = copyToolkit(JIRA_TEST_CONFIG);
  t.after(toolkit.cleanup);
  const { main: board } = await toolkit.load('board.mjs');
  const { main: add } = await toolkit.load('board-add.mjs');
  const { main: move } = await toolkit.load('board-move.mjs');
  const { main: publish } = await toolkit.load('verify-issue-publish.mjs');
  const { verifyJiraPublication } = await toolkit.load('lib/issue-publish.mjs');
  const { parseBatchArgs } = await toolkit.load('lib/board-move.mjs');
  const run = (main, args, provider) => {
    const stdout = [];
    const stderr = [];
    const status = main(args, { jiraExec: provider.exec, ghExec: provider.gh,
      linearExec: () => { throw new Error('must not call Linear'); }, fetchBoard: () => { throw new Error('must not read GitHub Projects'); },
      output: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) } });
    return { status, stdout, stderr };
  };
  const listed = run(board, [], native());
  assert.equal(listed.status, 0, listed.stderr.join('\n'));
  assert.ok(listed.stdout[0].startsWith('Board jira project ENG at https://example.atlassian.net'));
  assert.match(listed.stdout.join('\n'), /ENG-2/);
  const json = run(board, ['--all', '--json'], native());
  assert.equal(json.status, 0, json.stderr.join('\n'));
  assert.deepEqual(JSON.parse(json.stdout[0]), [
    { number: 'ENG-1', status: 'Ready', title: 'Parent', routing: null, parked: false, labels: ['epic'], state: 'OPEN', assignees: [], openBlockers: [], closingPullRequests: [], subIssues: { total: 2, completed: 1 } },
    { number: 'ENG-2', status: 'Ready', title: 'Active child', routing: null, parked: false, labels: ['task'], state: 'OPEN', assignees: [], openBlockers: [], closingPullRequests: [], subIssues: { total: 0, completed: 0 } },
    { number: 'ENG-3', status: 'Done', title: 'Done child', routing: null, parked: false, labels: ['task'], state: 'CLOSED', assignees: [], openBlockers: [], closingPullRequests: [], subIssues: { total: 0, completed: 0 } },
  ]);
  const closeout = run(board, ['--closeout'], native());
  assert.equal(closeout.status, 0);
  assert.deepEqual(closeout.stdout, ['board: no drift found.']);
  const empty = run(board, ['--all', '--json'], native({ empty: true }));
  assert.equal(empty.status, 0);
  assert.deepEqual(JSON.parse(empty.stdout[0]), []);
  const intake = run(board, ['--intake'], native());
  assert.equal(intake.status, 0, intake.stderr.join('\n'));
  assert.match(intake.stdout.join('\n'), /claim: comment 1 of 2/);
  assert.match(intake.stdout.join('\n'), /\| Acceptance text/);
  const missing = run(board, ['--intake'], native({ commentFailure: true }));
  assert.equal(missing.status, 4);
  assert.match(missing.stdout.join('\n'), /details: UNAVAILABLE.*later comment page failed/);
  assert.doesNotMatch(missing.stdout.join('\n'), /body: empty/);
  const inFlight = clone(ISSUES);
  inFlight['ENG-2'].fields.status = STATES[2];
  const advisory = run(board, ['--all'], native({ issues: inFlight }));
  assert.equal(advisory.status, 1);
  assert.match(advisory.stdout.join('\n'), /node scripts\/jira-card\.mjs assign ENG-2/);
  assert.doesNotMatch(advisory.stdout.join('\n'), /gh issue edit ENG-2/);
  const noReady = [{ id: '10001', statuses: STATES.filter(({ id }) => id !== '11') }, { id: '10002', statuses: STATES.filter(({ id }) => id !== '11') }];
  const unread = run(board, ['--intake'], native({ metadata: noReady }));
  assert.equal(unread.status, 2);
  assert.deepEqual(unread.stdout, []);
  assert.match(unread.stderr.join('\n'), /failed to read the Jira project/);
  for (const [main, args, remedy] of [[add, ['ENG-2', 'Ready'], /jira-card\.mjs create/], [move, ['--lane', 'ENG-2:none'], /Jira.*no parked lane|jira.*no parked lane/]]) {
    const provider = native();
    const result = run(main, args, provider);
    assert.equal(result.status, 1);
    assert.deepEqual(result.stdout, []);
    assert.match(result.stderr.join('\n'), remedy);
    assert.equal(provider.calls.length, 0);
    assert.equal(provider.ghCalls.length, 0);
  }
  assert.deepEqual(parseBatchArgs(['ENG-2:In progress', 'ENG-3:Ready'], 'Status', 'jira'), [{ issueNumber: 'ENG-2', statusName: 'In progress' }, { issueNumber: 'ENG-3', statusName: 'Ready' }]);
  const after = clone(ISSUES['ENG-2']);
  after.fields.status = STATES[2];
  const step = { request: { method: 'POST', path: '/rest/api/3/issue/ENG-2/transitions', body: { transition: { id: '22' } } }, issues: { 'ENG-2': after } };
  const moving = native({ steps: [step] });
  const moved = run(move, ['ENG-2', 'In progress'], moving);
  assert.equal(moved.status, 0, moved.stderr.join('\n'));
  assert.deepEqual(moved.stdout, ['board-move: ENG-2 → In progress']);
  assert.deepEqual(moving.writes, [step.request]);
  assert.equal(moving.remaining(), 0);
  const noopProvider = native();
  const noop = run(move, ['ENG-2', 'Ready'], noopProvider);
  assert.equal(noop.status, 0);
  assert.match(noop.stdout.join('\n'), /already at Ready.*no-op/);
  assert.equal(noopProvider.writes.length, 0);
  const unconfirmed = run(move, ['ENG-2', 'In progress'], native({ steps: [{ request: step.request }] }));
  assert.equal(unconfirmed.status, 1);
  assert.deepEqual(unconfirmed.stdout, []);
  assert.match(unconfirmed.stderr.join('\n'), /read.back/);
  const batchProvider = native({ steps: [step], transitions: { 'ENG-3': { transitions: [] } } });
  const batch = run(move, ['--batch', 'ENG-2:In progress', 'ENG-3:Ready'], batchProvider);
  assert.equal(batch.status, 1);
  assert.deepEqual(batch.stdout, []);
  assert.match(batch.stderr.join('\n'), /completed ENG-2 In progress/);
  assert.equal(batchProvider.writes.length, 1);

  const published = native({ noGitHub: true });
  assert.deepEqual(verifyJiraPublication(['ENG-1', 'ENG-2', 'ENG-3'], published.exec), VERIFIED);
  assert.ok(published.calls.some(({ query }) => query?.nextPageToken === 'child2'));
  const commandPublished = native({ noGitHub: true });
  const publication = run(publish, ['ENG-1', 'ENG-2', 'ENG-3'], commandPublished);
  assert.equal(publication.status, 0, publication.stderr.join('\n'));
  assert.deepEqual(publication.stdout, VERIFIED);
  assert.equal(commandPublished.ghCalls.length, 0);
  const standalone = run(publish, ['ENG-1'], native({ noGitHub: true }));
  assert.equal(standalone.status, 0);
  assert.match(standalone.stdout.join('\n'), /2 child issues \(none supplied/);
  for (const [args, options, cause] of [
    [['ENG-1', 'ENG-2'], {}, /child mismatch:.*native children but not supplied: ENG-3/],
    [['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4'], { extraIssue: true }, /child mismatch: supplied but not native children: ENG-4/],
    [['ENG-1', 'ENG-2', 'ENG-2'], {}, /duplicate issue ID ENG-2/],
    [['ENG-1', 'ENG-2', 'ENG-3'], { childFailure: true }, /Jira child page failed/],
    [['ENG-1', 'ENG-2', 'ENG-3'], { duplicateChild: true }, /duplicate issue identity ENG-2.*search pages/],
    [['ENG-1', 'ENG-2', 'ENG-3'], { foreignChild: true }, /issue OPS-1 is outside configured project ENG/],
  ]) {
    const failed = run(publish, args, native({ ...options, noGitHub: true }));
    assert.equal(failed.status, 1);
    assert.deepEqual(failed.stdout, []);
    assert.match(failed.stderr.join('\n'), cause);
  }
  for (const [fields, cause] of [
    [{ labels: [] }, /ENG-2 needs exactly one kind label/],
    [{ issuetype: { id: '10001' } }, /ENG-2.*issue type.*does not match.*task kind/],
    [{ status: { id: '99', name: 'Unmapped', statusCategory: { key: 'new' } } }, /ENG-2 has no non-empty Status/],
    [{ project: { id: '99999', key: 'ENG' } }, /ENG-2 belongs to a different project/],
  ]) {
    const issues = clone(ISSUES);
    Object.assign(issues['ENG-2'].fields, fields);
    const failed = run(publish, ['ENG-1', 'ENG-2', 'ENG-3'], native({ issues, noGitHub: true }));
    assert.equal(failed.status, 1);
    assert.deepEqual(failed.stdout, []);
    assert.match(failed.stderr.join('\n'), cause);
  }
});
