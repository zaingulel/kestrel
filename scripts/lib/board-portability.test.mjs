// board-portability.test.mjs — the adoption contract for the board toolkit.
// Run: node --test scripts/lib/board-portability.test.mjs
//
// Another repository adopts the toolkit by copying exactly the toolkit's named files
// (TOOLKIT_LIB and CLI_ENTRY_POINTS in board-toolkit-copy.mjs) unchanged and editing only
// board-config.mjs. These tests do exactly that through copyToolkit into a temp directory and
// import the copies, so each test runs against fresh module instances wired to the literal
// config written here, never to this repository's own board-config.mjs. An incomplete
// TOOLKIT_LIB fails these tests at import, the same way it would fail a real adopter.
//
// Price tag: recurring cost is roughly 8 s per suite run, measured on Linux (one temp-directory copy
// of the toolkit per test, the spawned board CLI processes, plus the markdown tests' temporary
// repositories and the commands that fill them; the markdown lifecycle test alone is about 2.3 s, with
// three clones and about 45 spawned commands, and the linear lifecycle test about 2.4 s, with 20 spawned
// commands each answered by the fake transport).
// Removal condition: retire it when the board toolkit is no longer copied into another
// repository.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installFakeGh, installFakeTransport } from './fake-gh.mjs';
import { gitEnvironment } from './factory-sync.mjs';
import { CARDS_DIR } from './board-markdown.mjs';
import { CONFIG_TAIL, GITHUB_TEST_CONFIG as USER_CONFIG, LINEAR_TEST_CONFIG, MARKDOWN_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';

const ORGANISATION_CONFIG = `export const BOARD_OWNER = 'acme-org';
export const BOARD_OWNER_TYPE = 'organization';
export const BOARD_PROJECT_NUMBER = 7;
export const BOARD_REPOSITORY = 'widgets';
${CONFIG_TAIL}`;

function adoptToolkit(t, configSource) {
  const toolkit = copyToolkit(configSource);
  t.after(toolkit.cleanup);
  return toolkit.root;
}

// A board with no routing field, as AlpGuard's is.
const NO_ROUTING_CONFIG = `export const BOARD_OWNER = 'acme-org';
export const BOARD_OWNER_TYPE = 'organization';
export const BOARD_PROJECT_NUMBER = 7;
export const BOARD_REPOSITORY = 'widgets';
export const STATUS_OPTIONS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
export const PICKABLE_STATUSES = ['Backlog', 'Ready'];
export const WAIT_STATUSES = ['Awaiting push'];
export const TERMINAL_STATUSES = ['Done'];
export const ROUTING_FIELD = null;
export const ROUTING_OPTIONS = [];
export const KIND_LABELS = { epic: 'epic', feature: 'enhancement', task: 'task', bug: 'bug', docs: 'documentation' };
export const PARKED_LANE = null;
`;

const load = (root, path) => import(pathToFileURL(join(root, 'scripts', path)).href);

const OPTIONS_BY_FIELD = {
  Status: ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'],
  Workstream: ['Go-to-market', 'Product', 'Platform'],
  Lane: ['Ours', 'To Sebastiano'],
};

// Answers every read and write the toolkit sends, keying the project-rooted responses
// under `rootKey` the way GitHub would, and records every command it is handed. An
// unanticipated query throws, so a new query surfaces as a failure, not a guessed answer.
// `currentValues` is card #11's value per field, read back through the issue-item query;
// a field it omits carries no value, which GitHub returns as null.
function recordingGh(rootKey, boardPage, currentValues = { Status: 'Ready' }, issueItemReply) {
  const sent = [];
  const exec = (args) => {
    sent.push(args);
    if (args[0] === 'project' && args[1] === 'item-edit') return '';
    const query = args.find((arg) => arg.startsWith('query=')).slice('query='.length);
    if (args.includes('--paginate')) return JSON.stringify([boardPage]);
    const field = query.match(/field\(name:"([^"]+)"\)/);
    if (field) {
      const options = OPTIONS_BY_FIELD[field[1]].map((name) => ({ id: `opt-${name}`, name }));
      return JSON.stringify({ data: { [rootKey]: { projectV2: { id: 'PVT_adopted', field: { id: `F_${field[1]}`, options } } } } });
    }
    const valueField = query.match(/value: fieldValueByName\(name: "([^"]+)"\)/);
    if (query.includes('projectItems(first:20)')) {
      const current = valueField ? currentValues[valueField[1]] : null;
      const nodes = [{ id: 'PVTI_11', isArchived: false, project: { number: boardPage.data[rootKey].projectV2.number, owner: { login: boardPage.data[rootKey].login } }, value: current ? { name: current } : null }];
      return JSON.stringify(issueItemReply(nodes, { issueId: 'I_11' }));
    }
    if (query.includes('subIssues')) {
      return JSON.stringify({ data: { repository: { issue: { subIssues: { totalCount: 0, nodes: [] } } } } });
    }
    if (query.includes('addProjectV2ItemById')) return JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'PVTI_11' } } } });
    if (query.includes('updateProjectV2ItemFieldValue')) {
      return JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_11' } } } });
    }
    throw new Error(`unanticipated gh call: ${args.join(' ')}`);
  };
  return { exec, sent };
}

async function boardPageFor(root) {
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  return leanBoardPage([
    leanNode({ id: 'PVTI_11', content: { __typename: 'Issue', number: 11, title: 'Adopted card', labels: ['task'] }, status: 'Ready', routing: 'Product' }),
  ]);
}

// Drives every read and write entry point the toolkit exports, each through its own
// recorder, and returns what each one sent.
async function driveEveryPath(root, rootKey) {
  const page = await boardPageFor(root);
  const { issueItemReply } = await load(root, 'lib/board-fixtures.mjs');
  const silent = { log() {}, error() {} };
  const { moveCards } = await load(root, 'lib/board-move.mjs');
  const { main: boardAdd } = await load(root, 'board-add.mjs');
  const { main: verifyPublish } = await load(root, 'verify-issue-publish.mjs');
  await load(root, 'board-move.mjs');

  const move = recordingGh(rootKey, page, undefined, issueItemReply);
  assert.deepEqual(moveCards([{ issueNumber: 11, statusName: 'Done' }], move.exec), [
    { issueNumber: 11, statusName: 'Done', skipped: false, cleared: false },
  ]);
  const add = recordingGh(rootKey, page, undefined, issueItemReply);
  assert.equal(boardAdd(['11', 'Ready', 'Product'], { ghExec: add.exec, output: silent }), 0);
  const verify = recordingGh(rootKey, page, undefined, issueItemReply);
  assert.equal(verifyPublish(['11'], { ghExec: verify.exec, output: silent }), 0);
  return { move: move.sent, add: add.sent, verify: verify.sent };
}

// Every project-rooted query in every path starts from the configured owner root, and
// each path sent at least one, so the assertion can never pass on an empty list.
function assertProjectRoot(sentByPath, expectedRoot, forbiddenRoot) {
  for (const [path, sent] of Object.entries(sentByPath)) {
    const args = sent.flat();
    assert.equal(args.some((arg) => arg.includes(forbiddenRoot)), false, `${path} sent ${forbiddenRoot}: ${args.join(' ')}`);
    const projectRooted = args.filter((arg) => arg.includes('projectV2('));
    assert.ok(projectRooted.length > 0, `${path} sent no project-rooted query`);
    for (const query of projectRooted) assert.ok(query.includes(`${expectedRoot} {`), `${path}: ${query}`);
  }
}

test('an organisation-configured board read queries the organization root and parses the organisation-keyed page', async (t) => {
  const root = adoptToolkit(t, ORGANISATION_CONFIG);
  const { fetchBoard } = await load(root, 'lib/board.mjs');
  const { exec, sent } = recordingGh('organization', await boardPageFor(root));

  const items = fetchBoard(exec);

  assert.deepEqual(items.map((i) => [i.content.number, i.status, i.routing]), [[11, 'Ready', 'Product']]);
  assert.equal(sent.length, 1);
  const query = sent[0].find((arg) => arg.startsWith('query='));
  assert.ok(query.includes('organization(login:"acme-org") { login projectV2(number:7)'), query);
  assert.equal(query.includes('user('), false, query);
});

test('an organisation-configured reader handed a user-keyed page fails loud naming the configured owner type', async (t) => {
  const root = adoptToolkit(t, ORGANISATION_CONFIG);
  const { fetchBoard } = await load(root, 'lib/board.mjs');
  const { data: { organization } } = await boardPageFor(root);
  const { exec } = recordingGh('organization', { data: { user: organization } });

  assert.throws(() => fetchBoard(exec), /board page carried no organization data/);
});

test('every board read and write an organisation-configured toolkit sends is rooted at the organisation, never at a user', async (t) => {
  const root = adoptToolkit(t, ORGANISATION_CONFIG);
  assertProjectRoot(await driveEveryPath(root, 'organization'), 'organization(login:"acme-org")', 'user(');
});

test('a user-owned config still roots every board query at user(login:"example-owner")', async (t) => {
  const root = adoptToolkit(t, USER_CONFIG);
  assertProjectRoot(await driveEveryPath(root, 'user'), 'user(login:"example-owner")', 'organization(');
});

function recordingOutput() {
  const lines = { log: [], error: [] };
  return { lines, log: (line) => lines.log.push(line), error: (line) => lines.error.push(line) };
}

const issue = (number) => ({ __typename: 'Issue', number, title: `Card ${number}` });

// The drift rows the copied scan produces for `nodes`, read through the copied board read.
async function scanRows(root, rootKey, nodes) {
  const { fetchBoard } = await load(root, 'lib/board.mjs');
  const { scanBoard } = await load(root, 'lib/board-rules.mjs');
  const { leanBoardPage } = await load(root, 'lib/board-fixtures.mjs');
  const { exec } = recordingGh(rootKey, leanBoardPage(nodes));
  return scanBoard(fetchBoard(exec)).drifted.map((row) => [row.number, row.reason]);
}

test('with no routing field, a card with a Status is fielded and a card without one is missing Status only', async (t) => {
  const root = adoptToolkit(t, NO_ROUTING_CONFIG);
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  assert.deepEqual(leanBoardPage([]).data.organization.projectV2.fields.nodes.map((f) => f.name), ['Title', 'Status']);

  const rows = await scanRows(root, 'organization', [
    leanNode({ id: 'PVTI_11', content: issue(11), status: 'Ready' }),
    leanNode({ id: 'PVTI_12', content: issue(12) }),
  ]);

  assert.deepEqual(rows, [[12, 'card missing Status — set the field(s); item-add leaves them empty']]);
});

test('with no routing field, a whole board of Status-only cards is clean, with no board-wide missing-field summary', async (t) => {
  const root = adoptToolkit(t, NO_ROUTING_CONFIG);
  const { fetchBoard } = await load(root, 'lib/board.mjs');
  const { scanBoard } = await load(root, 'lib/board-rules.mjs');
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  const nodes = Array.from({ length: 30 }, (_, i) => leanNode({ id: `PVTI_${i + 1}`, content: issue(i + 1), status: 'Ready' }));
  const { exec } = recordingGh('organization', leanBoardPage(nodes));

  const { drifted, unreadable } = scanBoard(fetchBoard(exec));

  assert.deepEqual(drifted, []);
  assert.deepEqual(unreadable, []);
});

test('with no routing field, board-add takes an issue number and a Status only', async (t) => {
  const root = adoptToolkit(t, NO_ROUTING_CONFIG);
  const { main } = await load(root, 'board-add.mjs');
  const { issueItemReply } = await load(root, 'lib/board-fixtures.mjs');
  const { exec, sent } = recordingGh('organization', await boardPageFor(root), undefined, issueItemReply);
  const output = recordingOutput();

  assert.equal(main(['12', 'Backlog'], { ghExec: exec, output }), 0);
  const fieldNames = sent.flat().map((arg) => arg.match(/field\(name:"([^"]+)"\)/)?.[1]).filter(Boolean);
  assert.deepEqual(fieldNames, ['Status']);
  assert.equal(sent.flat().some((arg) => arg.includes('Workstream')), false);
  assert.deepEqual(output.lines, {
    log: ['board-add: #12 on the board (item PVTI_11)', 'board-add: Status = Backlog'],
    error: [],
  });

  const rejected = recordingOutput();
  assert.equal(main(['12', 'Backlog', 'Product'], { ghExec: exec, output: rejected }), 1);
  assert.deepEqual(rejected.lines.error, ['board-add: usage: node scripts/board-add.mjs <issue#> <Status>']);
});

test('with no routing field, the publish verifier checks Status only', async (t) => {
  const root = adoptToolkit(t, NO_ROUTING_CONFIG);
  const { fetchBoard } = await load(root, 'lib/board.mjs');
  const { verifyIssuePublication } = await load(root, 'lib/issue-publish.mjs');
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  const page = leanBoardPage([leanNode({ id: 'PVTI_11', content: { ...issue(11), labels: ['task'] }, status: 'Ready' })]);
  const { exec } = recordingGh('organization', page);

  const lines = verifyIssuePublication(['11'], { fetchBoard, ghExec: exec });

  assert.equal(lines[1], 'issue-publish: Statuses verified for #11.');
});

test('with no routing field, board-move names a board-add command that takes a Status only for an issue not on the board', async (t) => {
  const root = adoptToolkit(t, NO_ROUTING_CONFIG);
  const { moveCards } = await load(root, 'lib/board-move.mjs');
  const { issueItemReply } = await load(root, 'lib/board-fixtures.mjs');
  const offBoard = issueItemReply([{ id: 'x', isArchived: false, project: { number: 8, owner: { login: 'acme-org' } }, value: null }]);
  const { exec } = recordingGh('organization', await boardPageFor(root));
  assert.throws(() => moveCards([{ issueNumber: 999, statusName: 'Ready' }], (args) =>
    args[3]?.includes('projectItems') ? offBoard : exec(args)), (error) => {
    assert.equal(error.cause.message, 'issue #999 is not on the board — add it with a Status: node scripts/board-add.mjs 999 <Status>');
    return true;
  });
});

test('with no routing field, the pick view prints each card with no Unfielded group heading', async (t) => {
  const root = adoptToolkit(t, NO_ROUTING_CONFIG);
  const { fetchBoard, formatGrouped } = await load(root, 'lib/board.mjs');
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  const page = leanBoardPage([
    leanNode({ id: 'PVTI_12', content: issue(12), status: 'Backlog' }),
    leanNode({ id: 'PVTI_11', content: issue(11), status: 'Ready' }),
  ]);

  const view = formatGrouped(fetchBoard(recordingGh('organization', page).exec));

  assert.equal(view, '#11 [Ready] Card 11\n    —\n#12 [Backlog] Card 12\n    —');
  assert.equal(view.includes('Unfielded'), false, view);
  assert.equal(view.includes('──'), false, view);
});

test('with no routing field, board-add names a Status-only retry command when the Status update fails after the add', async (t) => {
  const root = adoptToolkit(t, NO_ROUTING_CONFIG);
  const { main } = await load(root, 'board-add.mjs');
  const { issueItemReply } = await load(root, 'lib/board-fixtures.mjs');
  const { exec: answer } = recordingGh('organization', await boardPageFor(root), undefined, issueItemReply);
  const unset = { data: { node: { fieldValues: { totalCount: 0, nodes: [] } } } };
  const exec = (args) => {
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    if (query.includes('updateProjectV2ItemFieldValue')) throw new Error('HTTP 502');
    if (query.includes('node(id:')) return JSON.stringify(unset);
    return answer(args);
  };
  const output = recordingOutput();

  assert.equal(main(['12', 'Backlog'], { ghExec: exec, output }), 1);
  assert.equal(output.lines.error.length, 1);
  assert.ok(
    output.lines.error[0].includes("safely re-run the whole command: node scripts/board-add.mjs 12 'Backlog' — HTTP 502"),
    output.lines.error[0],
  );
  assert.equal(output.lines.error[0].includes('undefined'), false, output.lines.error[0]);
});

test('with no routing field, an unreadable card with a Status is reported as unread and does not fail the scan', async (t) => {
  const root = adoptToolkit(t, NO_ROUTING_CONFIG);
  const { fetchBoard } = await load(root, 'lib/board.mjs');
  const { scanBoard, scanOutcome } = await load(root, 'lib/board-rules.mjs');
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  const outcome = (node) => scanOutcome({ ...scanBoard(fetchBoard(recordingGh('organization', leanBoardPage([node])).exec)), closeout: false });

  assert.deepEqual(outcome(leanNode({ id: 'PVTI_11', content: null, status: 'Ready' })), {
    lines: [
      '⚠ BOARD READ INCOMPLETE — card(s) whose content did not resolve on this read:',
      'PVTI_11 [Ready] (no title) — card content could not be read on this scan — nothing is known about it, including whether it drifted; re-run the read',
      'board: no drift found, but 1 card(s) could not be read — this scan did not cover the whole board.',
    ],
    exitCode: 0,
  });
  assert.equal(outcome(leanNode({ id: 'PVTI_11', content: null })).exitCode, 1);
});

test('with a Workstream configured, a card missing it is still reported and board-add still requires it', async (t) => {
  const root = adoptToolkit(t, USER_CONFIG);
  const { leanNode } = await load(root, 'lib/board-fixtures.mjs');

  const rows = await scanRows(root, 'user', [leanNode({ id: 'PVTI_11', content: issue(11), status: 'Ready' })]);
  assert.deepEqual(rows, [[11, 'card missing Workstream — set the field(s); item-add leaves them empty']]);

  const { main } = await load(root, 'board-add.mjs');
  const { exec, sent } = recordingGh('user', await boardPageFor(root));
  const output = recordingOutput();
  assert.equal(main(['12', 'Backlog'], { ghExec: exec, output }), 1);
  assert.deepEqual(output.lines.error, ['board-add: usage: node scripts/board-add.mjs <issue#> <Status> <Workstream>']);
  assert.deepEqual(sent, []);
});

// A board with no routing field and a parked lane, as AlpGuard's is.
const PARKED_CONFIG = `export const BOARD_OWNER = 'acme-org';
export const BOARD_OWNER_TYPE = 'organization';
export const BOARD_PROJECT_NUMBER = 7;
export const BOARD_REPOSITORY = 'widgets';
export const STATUS_OPTIONS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
export const PICKABLE_STATUSES = ['Backlog', 'Ready'];
export const WAIT_STATUSES = ['Awaiting push'];
export const TERMINAL_STATUSES = ['Done'];
export const ROUTING_FIELD = null;
export const ROUTING_OPTIONS = [];
export const KIND_LABELS = { epic: 'epic', feature: 'enhancement', task: 'task', bug: 'bug', docs: 'documentation' };
export const PARKED_LANE = { field: 'Lane', option: 'To Sebastiano' };
`;

// The fake `gh` the copied CLIs are spawned against. It answers the single-process board
// walk from FAKE_BOARD, as board-cli.test.mjs's does, and, only when FAKE_LANE is set, the
// Lane field query, the item query of each issue FAKE_LANE.items holds, and item-edit
// writes. Anything else fails loud. With FAKE_GH_CALLS set it logs each argv as a JSON line.
const fakeGh = installFakeGh('board-portability-cli-', `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_GH_CALLS) appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + '\\n');
const query = args.find((arg) => arg.startsWith('query=')) ?? '';
const lane = process.env.FAKE_LANE ? JSON.parse(process.env.FAKE_LANE) : null;
const itemReply = lane?.items[query.match(/issue\\(number:(\\d+)\\)/)?.[1]];
if (args[0] === 'api' && args[1] === 'graphql' && args.includes('--paginate') && args.includes('--slurp')) {
  process.stdout.write(process.env.FAKE_BOARD);
} else if (lane && args[0] === 'project' && args[1] === 'item-edit') {
  // A successful write prints nothing the caller reads.
} else if (lane && query.includes('field(name:"Lane")')) {
  process.stdout.write(JSON.stringify(lane.field));
} else if (itemReply) {
  process.stdout.write(JSON.stringify(itemReply));
} else {
  process.stderr.write('unexpected gh invocation: ' + args.join(' '));
  process.exitCode = 2;
}
`);
after(() => fakeGh.cleanup());

// Spawned by its real path: the CLI runs main() only when argv[1] resolves to its own
// module URL, and the temp directory can sit behind a symlink (macOS /var → /private/var).
function runCopiedBoard(root, page, args = []) {
  return spawnSync(process.execPath, [realpathSync(join(root, 'scripts', 'board.mjs')), ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: fakeGh.env({ FAKE_BOARD: JSON.stringify([page]) }),
  });
}

test('a parked card keeps its Ready column but is never pickable, and parked() names exactly it', async (t) => {
  const root = adoptToolkit(t, PARKED_CONFIG);
  const { fetchBoard, parked, pickable } = await load(root, 'lib/board.mjs');
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  const page = leanBoardPage([
    leanNode({ id: 'PVTI_11', content: issue(11), status: 'Ready' }),
    leanNode({ id: 'PVTI_12', content: issue(12), status: 'Ready', lane: 'To Sebastiano' }),
    leanNode({ id: 'PVTI_13', content: issue(13), status: 'Ready', lane: 'Ours' }),
  ]);
  page.data.organization.projectV2.fields.nodes.find((f) => f.name === 'Lane').options.push({ name: 'Ours' });

  const items = fetchBoard(recordingGh('organization', page).exec);

  assert.deepEqual(pickable(items).map((i) => i.content.number), [11, 13]);
  assert.deepEqual(parked(items).map((i) => [i.content.number, i.status]), [[12, 'Ready']]);
  assert.deepEqual(items.filter((i) => i.status === 'Ready').map((i) => i.content.number), [11, 12, 13]);
});

test('the copied CLI names a parked card on its own line and leaves it out of the pick view', async (t) => {
  const root = adoptToolkit(t, PARKED_CONFIG);
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  const page = leanBoardPage([
    leanNode({ id: 'PVTI_11', content: issue(11), status: 'Ready' }),
    leanNode({ id: 'PVTI_12', content: issue(12), status: 'Ready', lane: 'To Sebastiano' }),
  ]);

  const run = runCopiedBoard(root, page);

  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split('\n');
  assert.ok(lines.includes('Parked (Lane: To Sebastiano), not pickable: #12'), run.stdout);
  assert.ok(lines.includes('#11 [Ready] Card 11'), run.stdout);
  assert.equal(lines.some((line) => line.startsWith('#12 ')), false, run.stdout);
});

test('parkedLine names the parked cards ascending, numberless last as #?, only for the default pick view', async (t) => {
  const root = adoptToolkit(t, PARKED_CONFIG);
  const { fetchBoard, parkedLine, parseBoardArgs } = await load(root, 'lib/board.mjs');
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  const read = (nodes) => fetchBoard(recordingGh('organization', leanBoardPage(nodes)).exec);
  const items = read([
    leanNode({ id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, title: 'a draft note', status: 'Backlog', lane: 'To Sebastiano' }),
    leanNode({ id: 'PVTI_30', content: issue(30), status: 'Ready', lane: 'To Sebastiano' }),
    leanNode({ id: 'PVTI_11', content: issue(11), status: 'Ready' }),
    leanNode({ id: 'PVTI_12', content: issue(12), status: 'Backlog', lane: 'To Sebastiano' }),
  ]);

  assert.equal(parkedLine(items, parseBoardArgs([])), 'Parked (Lane: To Sebastiano), not pickable: #12, #30, #?');
  assert.equal(parkedLine(items, parseBoardArgs(['--json'])), 'Parked (Lane: To Sebastiano), not pickable: #12, #30, #?');
  assert.equal(parkedLine(items, parseBoardArgs(['--all'])), null);
  assert.equal(parkedLine(items, parseBoardArgs(['--status=Ready'])), null);
  assert.equal(parkedLine(read([leanNode({ id: 'PVTI_11', content: issue(11), status: 'Ready' })]), parseBoardArgs([])), null);
});

test('the copied CLI under --json keeps stdout a parked-free JSON document and sends the parked line to stderr', async (t) => {
  const root = adoptToolkit(t, PARKED_CONFIG);
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  const page = leanBoardPage([
    leanNode({ id: 'PVTI_11', content: issue(11), status: 'Ready' }),
    leanNode({ id: 'PVTI_12', content: issue(12), status: 'Ready', lane: 'To Sebastiano' }),
  ]);

  const run = runCopiedBoard(root, page, ['--json']);

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).map((i) => i.number), [11]);
  assert.equal(run.stdout.includes('Parked'), false, run.stdout);
  assert.ok(run.stderr.split('\n').includes('Parked (Lane: To Sebastiano), not pickable: #12'), run.stderr);
});

test('a parked-lane board whose Lane field is missing or lacks the parked option fails loud naming board-config.mjs', async (t) => {
  const root = adoptToolkit(t, PARKED_CONFIG);
  const { fetchBoard } = await load(root, 'lib/board.mjs');
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  const pageWithLane = (options) => {
    const page = leanBoardPage([leanNode({ id: 'PVTI_11', content: issue(11), status: 'Ready' })]);
    const fields = page.data.organization.projectV2.fields;
    fields.nodes = fields.nodes.filter((f) => f.name !== 'Lane');
    if (options) fields.nodes.push({ name: 'Lane', dataType: 'SINGLE_SELECT', options: options.map((name) => ({ name })) });
    fields.totalCount = fields.nodes.length;
    return page;
  };

  assert.throws(
    () => fetchBoard(recordingGh('organization', pageWithLane(null)).exec),
    /the board has no "Lane" field for PARKED_LANE .*scripts\/lib\/board-config\.mjs/,
  );
  assert.throws(
    () => fetchBoard(recordingGh('organization', pageWithLane(['Ours'])).exec),
    /the board's "Lane" field offers Ours but PARKED_LANE in scripts\/lib\/board-config\.mjs parks "To Sebastiano"/,
  );
});

test('a parked claim with no closing pull request is not reported as stalled; the identical unparked claim is', async (t) => {
  const root = adoptToolkit(t, PARKED_CONFIG);
  const { fetchBoard, normalizeItem } = await load(root, 'lib/board.mjs');
  const { scanBoard } = await load(root, 'lib/board-rules.mjs');
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  const claim = (number) => ({ ...issue(number), assignees: ['acme-dev'] });
  const page = leanBoardPage([
    leanNode({ id: 'PVTI_11', content: claim(11), status: 'In progress', lane: 'To Sebastiano' }),
    leanNode({ id: 'PVTI_12', content: claim(12), status: 'In progress', lane: null }),
  ]);

  const items = fetchBoard(recordingGh('organization', page).exec);

  assert.deepEqual(items.map((i) => [i.content.number, normalizeItem(i).parked]), [[11, true], [12, false]]);
  assert.deepEqual(scanBoard(items).drifted.map((row) => [row.number, row.reason]), [
    [12, 'claimed in "In progress" but no closing pull request exists — if no session is actively building it, resume it or return it to Ready'],
  ]);
});

test('with no parked lane configured, a card carrying a Lane value is still pickable, not parked, and the CLI prints no parked line', async (t) => {
  const root = adoptToolkit(t, USER_CONFIG);
  const { fetchBoard, normalizeItem, parked, pickable } = await load(root, 'lib/board.mjs');
  const { leanBoardPage, leanNode } = await load(root, 'lib/board-fixtures.mjs');
  assert.throws(() => leanNode({ status: 'Ready', lane: 'To Sebastiano' }), /configures no PARKED_LANE/);
  const fieldValues = (lane) => [
    { name: 'Ready', field: { name: 'Status' } },
    { name: 'Product', field: { name: 'Workstream' } },
    ...(lane ? [{ name: lane, field: { name: 'Lane' } }] : []),
  ];
  const page = leanBoardPage([
    leanNode({ id: 'PVTI_11', content: issue(11), fieldValues: fieldValues(null) }),
    leanNode({ id: 'PVTI_12', content: issue(12), fieldValues: fieldValues('To Sebastiano') }),
  ]);

  const items = fetchBoard(recordingGh('user', page).exec);
  assert.deepEqual(pickable(items).map((i) => i.content.number), [11, 12]);
  assert.deepEqual(parked(items), []);
  assert.equal('lane' in items[1], false);
  assert.deepEqual(items.map((i) => normalizeItem(i).parked), [false, false]);

  const run = runCopiedBoard(root, page);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes('#12 [Ready] Card 12'), run.stdout);
  assert.equal(`${run.stdout}${run.stderr}`.includes('Parked'), false, run.stdout);
});

// The copied moveLanes against the parked-lane board: every write names the Lane field and
// the parked option by the literal ids the organisation-rooted field query answered with.
async function laneMove(t, currentValues, lane) {
  const root = adoptToolkit(t, PARKED_CONFIG);
  const { moveLanes } = await load(root, 'lib/board-move.mjs');
  const { issueItemReply } = await load(root, 'lib/board-fixtures.mjs');
  const gh = recordingGh('organization', await boardPageFor(root), currentValues, issueItemReply);
  const run = () => moveLanes([{ issueNumber: 11, statusName: lane }], gh.exec);
  const edits = () => gh.sent.filter((args) => args[0] === 'project');
  return { run, edits, sent: gh.sent };
}

test('the copied moveLanes parks a card by writing the Lane field id and the parked option id', async (t) => {
  const { run, edits, sent } = await laneMove(t, { Status: 'Ready' }, 'To Sebastiano');

  assert.deepEqual(run(), [{ issueNumber: 11, statusName: 'To Sebastiano', skipped: false, cleared: false }]);
  assert.ok(sent[0].at(-1).includes('organization(login:"acme-org")') && sent[0].at(-1).includes('field(name:"Lane")'), sent[0].at(-1));
  assert.deepEqual(edits(), [[
    'project', 'item-edit', '--id', 'PVTI_11', '--project-id', 'PVT_adopted',
    '--field-id', 'F_Lane', '--single-select-option-id', 'opt-To Sebastiano',
  ]]);
});

test('the copied moveLanes releases a parked card with none by clearing the Lane field, naming no option', async (t) => {
  const { run, edits } = await laneMove(t, { Status: 'Ready', Lane: 'To Sebastiano' }, 'none');

  assert.deepEqual(run(), [{ issueNumber: 11, statusName: 'none', skipped: false, cleared: true }]);
  assert.deepEqual(edits(), [[
    'project', 'item-edit', '--id', 'PVTI_11', '--project-id', 'PVT_adopted', '--field-id', 'F_Lane', '--clear',
  ]]);
});

test('the copied moveLanes writes nothing for a card already in the target lane', async (t) => {
  const { run, edits } = await laneMove(t, { Status: 'Ready', Lane: 'To Sebastiano' }, 'to sebastiano');

  assert.deepEqual(run(), [{ issueNumber: 11, statusName: 'to sebastiano', skipped: true, cleared: false }]);
  assert.deepEqual(edits(), []);
});

test('the copied moveLanes writes nothing when releasing a card whose Lane is already clear', async (t) => {
  const { run, edits } = await laneMove(t, { Status: 'Ready' }, 'None');

  assert.deepEqual(run(), [{ issueNumber: 11, statusName: 'None', skipped: true, cleared: true }]);
  assert.deepEqual(edits(), []);
});

test('the copied moveLanes refuses an unknown lane, listing the Lane options', async (t) => {
  const { run, edits } = await laneMove(t, { Status: 'Ready' }, 'To Nobody');

  assert.throws(run, /unknown Lane "To Nobody" — valid options: Ours, To Sebastiano/);
  assert.deepEqual(edits(), []);
});

test('the copied moveCards never clears Status: none is an unknown Status', async (t) => {
  const root = adoptToolkit(t, PARKED_CONFIG);
  const { moveCards } = await load(root, 'lib/board-move.mjs');
  const { exec, sent } = recordingGh('organization', await boardPageFor(root));

  assert.throws(
    () => moveCards([{ issueNumber: 11, statusName: 'none' }], exec),
    /unknown Status "none" — valid options: Backlog, Ready, In progress, Awaiting push, In review, Done/,
  );
  assert.deepEqual(sent.filter((args) => args[0] === 'project'), []);
});

test('the copied board-move CLI parks one card and releases another with --lane, writing each by literal ids', async (t) => {
  const root = adoptToolkit(t, PARKED_CONFIG);
  const { issueItemReply } = await load(root, 'lib/board-fixtures.mjs');
  const item = (id, lane) => issueItemReply([{ id, isArchived: false, project: { number: 7, owner: { login: 'acme-org' } }, value: lane ? { name: lane } : null }]);
  const lane = {
    field: {
      data: {
        organization: {
          projectV2: {
            id: 'PVT_acme',
            field: { id: 'PVTSSF_lane', options: [{ id: 'PVTSSO_ours', name: 'Ours' }, { id: 'PVTSSO_sebastiano', name: 'To Sebastiano' }] },
          },
        },
      },
    },
    items: { 12: item('PVTI_12', null), 13: item('PVTI_13', 'To Sebastiano') },
  };
  const callsFile = fakeGh.newCallsFile();
  writeFileSync(callsFile, '');

  const run = spawnSync(process.execPath, [realpathSync(join(root, 'scripts', 'board-move.mjs')), '--lane', '12:To Sebastiano', '13:none'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: fakeGh.env({ FAKE_LANE: JSON.stringify(lane), FAKE_GH_CALLS: callsFile }),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'board-move: #12 → Lane: To Sebastiano\nboard-move: #13 → Lane cleared\n');
  const calls = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(calls.filter((args) => args[0] === 'project'), [
    ['project', 'item-edit', '--id', 'PVTI_12', '--project-id', 'PVT_acme', '--field-id', 'PVTSSF_lane', '--single-select-option-id', 'PVTSSO_sebastiano'],
    ['project', 'item-edit', '--id', 'PVTI_13', '--project-id', 'PVT_acme', '--field-id', 'PVTSSF_lane', '--clear'],
  ]);
});

// The markdown tracker, run as a spawned CLI against real temporary repositories: a bare origin
// and a working copy that is the toolkit copy itself, whose root the reader takes from its own
// location. The fake `gh` answers `pr list` only, from FAKE_PULLS keyed by head branch, and logs
// every argv as a JSON line.
const markdownGh = installFakeGh('board-portability-markdown-', `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') {
  const head = args[args.indexOf('--head') + 1];
  process.stdout.write(JSON.stringify(JSON.parse(process.env.FAKE_PULLS)[head] ?? []));
} else {
  process.stderr.write('unexpected gh invocation: ' + args.join(' '));
  process.exitCode = 2;
}
`);
after(() => markdownGh.cleanup());

function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnvironment(),
  });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

const cardFile = (title, status, extra = []) =>
  [`# ${title}`, '', `Status: ${status}`, 'Kind: task', 'Workstream: Product', ...extra, '', 'Body of the card.', ''].join('\n');

// A markdown install whose `main`, with the given cards, is published on a bare origin.
function markdownInstall(t, cards) {
  const toolkit = copyToolkit(MARKDOWN_TEST_CONFIG);
  t.after(toolkit.cleanup);
  const origin = mkdtempSync(join(tmpdir(), 'board-portability-origin-'));
  t.after(() => rmSync(origin, { recursive: true, force: true }));
  git(origin, 'init', '--bare', '-b', 'main');
  git(toolkit.root, 'init', '-b', 'main');
  mkdirSync(join(toolkit.root, CARDS_DIR), { recursive: true });
  for (const [number, text] of Object.entries(cards)) writeFileSync(join(toolkit.root, CARDS_DIR, `${number}.md`), text);
  git(toolkit.root, 'add', '.agents/cards');
  git(toolkit.root, 'commit', '-m', 'file the cards');
  git(toolkit.root, 'remote', 'add', 'origin', origin);
  git(toolkit.root, 'push', 'origin', 'main');
  return toolkit;
}

// Any copied CLI of a checkout, spawned from an unrelated folder: the reader's root is its own location,
// never the working folder. `env` adds to the fake `gh`'s environment; `calls` is the argv log it wrote.
function runScript(root, name, args, pulls = {}, env = {}) {
  const callsFile = markdownGh.newCallsFile();
  writeFileSync(callsFile, '');
  const run = spawnSync(process.execPath, [join(root, 'scripts', name), ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: tmpdir(),
    env: markdownGh.env({ FAKE_GH_CALLS: callsFile, FAKE_PULLS: JSON.stringify(pulls), ...env }),
  });
  const calls = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { ...run, calls };
}

// A linked job worktree of a markdown install, carrying the toolkit, since a move is refused in the integration checkout.
function jobWorktree(t, toolkit, number) {
  const worktree = join(realpathSync(mkdtempSync(join(tmpdir(), 'board-portability-worktree-'))), 'job-worktree');
  t.after(() => rmSync(join(worktree, '..'), { recursive: true, force: true }));
  git(toolkit.root, 'add', '-A');
  git(toolkit.root, 'commit', '-m', 'add the toolkit');
  git(toolkit.root, 'worktree', 'add', '-b', `job/${number}`, worktree, 'main');
  return worktree;
}

test('markdown board: intake shows the columns derived from real local, origin and origin/main refs, with only this repository\'s pull requests counted', (t) => {
  const toolkit = markdownInstall(t, {
    1: cardFile('Card one', 'Ready'),
    2: cardFile('Card two', 'Backlog', ['Blocked by: 1']),
    3: cardFile('Card three', 'Ready'),
    4: cardFile('Card four', 'Ready'),
    5: cardFile('Card five', 'Ready'),
    6: cardFile('Card six', 'Done'),
    7: cardFile('Card seven', 'Ready'),
  });
  const { root } = toolkit;
  git(root, 'branch', 'job/3');
  git(root, 'branch', 'job/4');
  git(root, 'push', 'origin', 'job/4');
  git(root, 'push', 'origin', 'main:refs/heads/job/7');
  git(root, 'switch', '-c', 'job/5');
  writeFileSync(join(root, CARDS_DIR, '5.md'), cardFile('Card five', 'Done'));
  git(root, 'commit', '-a', '-m', 'close card five');
  git(root, 'switch', 'main');
  const pulls = {
    'job/4': [{ number: 12, headRefName: 'job/4', isCrossRepository: false }],
    'job/7': [{ number: 99, headRefName: 'job/7', isCrossRepository: true }],
  };

  const run = runScript(toolkit.root, 'board.mjs', ['--intake'], pulls);

  assert.equal(run.status, 3, run.stderr);
  const document = run.stdout.split('\n');
  assert.equal(document[0], 'Board markdown .agents/cards — Backlog/Ready: 2 of 7 item(s)');
  assert.deepEqual(document.filter((line) => line.startsWith('=== ')), [
    '=== #1 [Ready] Card one ===',
    '=== #2 [Backlog] Card two ===',
    '=== #3 [In progress] Card three ===',
    '=== #5 [Awaiting push] Card five ===',
    '=== #7 [In progress] Card seven ===',
  ]);
  assert.deepEqual(document.filter((line) => line.startsWith('claim: ')), [
    'claim: none',
    'claim: none',
    'claim: branch job/3 (local)',
    'claim: branch job/5 (local)',
    'claim: branch job/7 (origin)',
  ]);
  assert.ok(document.includes('open blockers: #1'), run.stdout);
  assert.ok(document.includes('| Body of the card.'), run.stdout);
  // The two pushed branches with no counted draft are the stalled claims; the Awaiting push card is not.
  const stalled = (number, word) =>
    `#${number} [In progress] Card ${word} — claimed in "In progress" but no closing pull request exists — if no session is actively building it, resume it or return it to Ready`;
  const stderr = run.stderr.split('\n');
  assert.deepEqual(stderr.filter((line) => line.startsWith('#')), [stalled(3, 'three'), stalled(7, 'seven')]);
  assert.ok(stderr.includes('⚠ BOARD DRIFT — cards out of sync with reality:'), run.stderr);
  assert.ok(stderr.includes('board intake: details complete for 5 card(s).'), run.stderr);
  // Only the two cards whose branch origin lists were asked, each bound to this repository.
  assert.deepEqual(run.calls, ['job/4', 'job/7'].map((head) => [
    'pr', 'list', '--repo', 'example-owner/example-repo', '--head', head, '--state', 'open', '--json', 'number,headRefName,isCrossRepository',
  ]));

  const all = runScript(toolkit.root, 'board.mjs', ['--all'], pulls);

  assert.equal(all.status, 1, all.stderr);
  const rows = all.stdout.split('\n');
  assert.equal(rows[0], 'Board markdown .agents/cards — all columns: 7 of 7 item(s)');
  // The listing puts the last pickable column first, then ascending card number; the two stalled-claim
  // drift rows follow it on stdout in this mode.
  assert.deepEqual(rows.filter((line) => line.startsWith('#')).slice(0, 7), [
    '#1 [Ready] Card one',
    '#2 [Backlog] Card two',
    '#3 [In progress] Card three',
    '#4 [In review] Card four',
    '#5 [Awaiting push] Card five',
    '#6 [Done] Card six',
    '#7 [In progress] Card seven',
  ]);
});

test('markdown board: a corrupt card fails the read with exit 2, naming the file and line', (t) => {
  const toolkit = markdownInstall(t, {
    1: cardFile('Card one', 'Ready'),
    2: ['# Card two', '', 'Status: Ready', 'Colour: red', 'Kind: task', 'Workstream: Product', '', 'Body', ''].join('\n'),
  });

  const run = runScript(toolkit.root, 'board.mjs', ['--intake']);

  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, `board: failed to read the markdown cards — ${CARDS_DIR}/2.md:4: unknown field "Colour"\n`);
  assert.deepEqual(run.calls, []);
});

test('markdown board: a linked .agents/cards is refused and the outside card is untouched', (t) => {
  const toolkit = copyToolkit(MARKDOWN_TEST_CONFIG);
  t.after(toolkit.cleanup);
  const outside = mkdtempSync(join(tmpdir(), 'board-portability-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const outsideCard = join(outside, '1.md');
  writeFileSync(outsideCard, cardFile('Outside card', 'Ready'));
  mkdirSync(join(toolkit.root, '.agents'));
  // A junction needs no privilege on Windows and is a directory link everywhere else.
  symlinkSync(outside, join(toolkit.root, CARDS_DIR), 'junction');
  const before = readFileSync(outsideCard);

  const run = runScript(toolkit.root, 'board.mjs', ['--intake']);

  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /^board: failed to read the markdown cards — /);
  assert.ok(run.stderr.includes(`its parent ${join(toolkit.root, CARDS_DIR)} is a symlink`), run.stderr);
  assert.deepEqual(readFileSync(outsideCard), before);

  const write = runScript(toolkit.root, 'board-move.mjs', ['1', 'Done']);

  assert.equal(write.status, 1, write.stderr);
  assert.equal(write.stdout, '');
  assert.match(write.stderr, /^board-move: /);
  assert.ok(write.stderr.includes(`its parent ${join(toolkit.root, CARDS_DIR)} is a symlink`), write.stderr);
  assert.deepEqual(readFileSync(outsideCard), before);
});

test('markdown board-move: a status the tracker cannot write or check, and a lane, are refused', (t) => {
  const toolkit = markdownInstall(t, { 1: cardFile('Card one', 'Ready') });
  const cardBefore = readFileSync(join(toolkit.root, CARDS_DIR, '1.md'));

  const unknown = runScript(toolkit.root, 'board-move.mjs', ['1', 'Parked']);

  assert.equal(unknown.status, 1, unknown.stderr);
  assert.equal(unknown.stdout, '');
  assert.equal(
    unknown.stderr,
    'board-move: failed to move #1 → "Parked" (already completed: none) — unknown Status "Parked" — valid options: Backlog, Ready, Done, In progress, Awaiting push, In review\n',
  );
  const batch = runScript(toolkit.root, 'board-move.mjs', ['--batch', '1:Ready', '1:Parked']);
  assert.equal(batch.status, 1, batch.stderr);
  assert.equal(batch.stdout, '');
  assert.ok(batch.stderr.startsWith('board-move: failed to move #1 → "Parked" (already completed: #1 → Ready) — '), batch.stderr);
  assert.deepEqual(readFileSync(join(toolkit.root, CARDS_DIR, '1.md')), cardBefore);

  const noLane = runScript(toolkit.root, 'board-move.mjs', ['--lane', '1:Ours']);

  assert.equal(noLane.status, 1, noLane.stderr);
  assert.equal(noLane.stderr, 'board-move: --lane needs a parked lane, but scripts/lib/board-config.mjs sets PARKED_LANE = null\n');

  const handLane = copyToolkit(MARKDOWN_TEST_CONFIG.replace('export const PARKED_LANE = null;', "export const PARKED_LANE = { field: 'Lane', option: 'Ours' };"));
  t.after(handLane.cleanup);
  const byHand = runScript(handLane.root, 'board-move.mjs', ['--lane', '1:Ours']);

  assert.equal(byHand.status, 1, byHand.stderr);
  assert.equal(byHand.stderr, 'board-move: the markdown tracker has no parked lane\n');
});

test('markdown board-move: only the real Status line is rewritten, whatever the title holds and the line endings are', (t) => {
  const crlf = (text) => text.replaceAll('\n', '\r\n');
  const titles = { 1: 'Card one\u2028Status: Ready', 2: 'Card two\rStatus: Ready' };
  const toolkit = markdownInstall(t, { 1: cardFile(titles[1], 'Ready'), 2: crlf(cardFile(titles[2], 'Ready')) });
  const worktree = jobWorktree(t, toolkit, 1);

  const move = runScript(worktree, 'board-move.mjs', ['--batch', '1:Backlog', '2:Backlog']);

  assert.equal(move.status, 0, move.stderr);
  assert.equal(readFileSync(join(worktree, CARDS_DIR, '1.md'), 'utf8'), cardFile(titles[1], 'Backlog'));
  assert.equal(readFileSync(join(worktree, CARDS_DIR, '2.md'), 'utf8'), crlf(cardFile(titles[2], 'Backlog')));
});

test('markdown board: ANTI-REGRESSION: a card file that is a link is refused on read and on write and the file it points to is untouched', (t) => {
  const toolkit = markdownInstall(t, { 2: cardFile('Card two', 'Ready') });
  const worktree = jobWorktree(t, toolkit, 2);
  const outside = mkdtempSync(join(tmpdir(), 'board-portability-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const outsideCard = join(outside, '1.md');
  writeFileSync(outsideCard, cardFile('Outside card', 'Ready'));
  try {
    symlinkSync(outsideCard, join(worktree, CARDS_DIR, '1.md'), 'file');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip(`this account cannot create a file symlink (${error.code})`);
    return;
  }
  const before = readFileSync(outsideCard);

  const read = runScript(worktree, 'board.mjs', ['--intake']);

  assert.equal(read.status, 2, read.stderr);
  assert.equal(read.stdout, '');
  assert.ok(read.stderr.includes(`${CARDS_DIR}/1.md: only regular files named <N>.md`), read.stderr);
  assert.ok(read.stderr.endsWith('found a symlink\n'), read.stderr);
  assert.deepEqual(readFileSync(outsideCard), before);

  const write = runScript(worktree, 'board-move.mjs', ['1', 'Backlog']);

  assert.equal(write.status, 1, write.stderr);
  assert.equal(write.stdout, '');
  assert.ok(write.stderr.includes(`${CARDS_DIR}/1.md: only regular files named <N>.md`), write.stderr);
  assert.ok(write.stderr.endsWith('found a symlink\n'), write.stderr);
  assert.deepEqual(readFileSync(outsideCard), before);
});

// The markdown lifecycle, every step through the spawned CLIs: a bare origin, an integration clone A
// with a linked job worktree, and a second clone B. The expectations are written from the card
// format and from the repository's own refs and files, never read back from the module.
test('markdown lifecycle: file, claim, close, interrupted push, race, draft, integration checkout, merge', (t) => {
  const N = 3;
  const UNPUBLISHED = 4;
  const NO_CARD = 9;
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'board-portability-lifecycle-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const origin = join(scratch, 'origin');
  const cloneB = join(scratch, 'b');
  const worktree = join(scratch, 'job-worktree');
  const cardPath = (root, number) => join(root, CARDS_DIR, `${number}.md`);
  const view = (root, pulls) => {
    const run = runScript(root, 'board.mjs', ['--all', '--json'], pulls);
    assert.notEqual(run.stdout, '', run.stderr);
    return Object.fromEntries(JSON.parse(run.stdout).map((entry) => [entry.number, [entry.status, entry.state]]));
  };
  const intake = (root, pulls) => {
    const run = runScript(root, 'board.mjs', ['--intake'], pulls);
    const out = run.stdout.split('\n');
    return {
      run,
      sections: out.filter((line) => line.startsWith('=== ')),
      claimed: out.find((line) => line.startsWith('Card details: ')),
      claims: out.filter((line) => line.startsWith('claim: ')),
    };
  };
  const claimCount = (count) => `Card details: 0 pickable card(s), then ${count} claimed card(s) with no closing pull request.`;
  const draft = { 'job/3': [{ number: 21, headRefName: 'job/3', isCrossRepository: false }] };

  // The integration clone A holds the toolkit and the filed card on main, published to the bare origin.
  const toolkit = copyToolkit(MARKDOWN_TEST_CONFIG);
  t.after(toolkit.cleanup);
  const cloneA = toolkit.root;
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-b', 'main');
  git(cloneA, 'init', '-b', 'main');
  git(cloneA, 'remote', 'add', 'origin', origin);

  // 1. Filing is refused by the CLI; the card is a file, committed and published as Ready.
  const filing = runScript(cloneA, 'board-add.mjs', [String(N), 'Ready']);
  assert.equal(filing.status, 1, filing.stderr);
  assert.equal(filing.stdout, '');
  assert.equal(filing.stderr, 'board-add: the markdown tracker files a card by writing .agents/cards/<N>.md; see docs/MARKDOWN-CARDS.md\n');
  mkdirSync(join(cloneA, CARDS_DIR), { recursive: true });
  writeFileSync(cardPath(cloneA, N), cardFile('Card three', 'Ready'));
  git(cloneA, 'add', '-A');
  git(cloneA, 'commit', '-m', 'file card three');
  git(cloneA, 'push', 'origin', 'main');
  git(cloneA, 'worktree', 'add', '-b', `job/${N}`, worktree, 'main');
  git(scratch, 'clone', origin, cloneB);

  const verified = runScript(worktree, 'verify-issue-publish.mjs', [String(N)]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stderr, '');
  assert.equal(verified.stdout, [
    'issue-publish: card files verified for #3.',
    'issue-publish: Statuses and Workstreams verified for #3.',
    'issue-publish: exactly one kind verified for #3.',
    'issue-publish: #3 verified as a standalone card; it has 0 child cards (none supplied; pass them as arguments to verify an Epic).',
    '',
  ].join('\n'));
  const missing = runScript(worktree, 'verify-issue-publish.mjs', [String(NO_CARD)]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, `issue-publish: #9 has no card file ${CARDS_DIR}/9.md in this checkout\n`);

  const claim = runScript(worktree, 'board-move.mjs', [String(N), 'In progress']);
  assert.equal(claim.status, 0, claim.stderr);
  assert.equal(claim.stdout, 'board-move: #3 at In progress — branch job/3\n');
  const claimed = intake(worktree);
  assert.deepEqual(claimed.sections, ['=== #3 [In progress] Card three ===']);
  assert.equal(claimed.claimed, claimCount(1));

  // 2. A card never published cannot be closed or read Done; a closing edit stays pending until the merge.
  const unpublished = cardFile('Card four', 'Ready');
  writeFileSync(cardPath(worktree, UNPUBLISHED), unpublished);
  const refused = runScript(worktree, 'board-move.mjs', [String(UNPUBLISHED), 'Done']);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stdout, '');
  assert.ok(refused.stderr.includes('#4 is not on origin/main; publish the card as Backlog or Ready through a merged change before closing it'), refused.stderr);
  assert.equal(readFileSync(cardPath(worktree, UNPUBLISHED), 'utf8'), unpublished);
  writeFileSync(cardPath(worktree, UNPUBLISHED), cardFile('Card four', 'Done'));
  const handDone = runScript(worktree, 'board.mjs', ['--intake']);
  assert.equal(handDone.status, 2, handDone.stderr);
  assert.equal(handDone.stdout, '');
  assert.ok(handDone.stderr.includes(`${CARDS_DIR}/4.md says Done but is not on origin/main; a card is first published as Backlog or Ready through a merged change`), handDone.stderr);
  rmSync(cardPath(worktree, UNPUBLISHED));

  // A published card moves between Ready and Backlog by rewriting its Status line alone.
  for (const status of ['Backlog', 'Ready']) {
    const rewrite = runScript(worktree, 'board-move.mjs', [String(N), status]);
    assert.equal(rewrite.status, 0, rewrite.stderr);
    assert.equal(rewrite.stdout, `board-move: #3 → ${status}\n`);
    assert.equal(readFileSync(cardPath(worktree, N), 'utf8'), cardFile('Card three', status));
  }

  const closing = runScript(worktree, 'board-move.mjs', [String(N), 'Done']);
  assert.equal(closing.status, 0, closing.stderr);
  assert.equal(closing.stdout, 'board-move: #3 → Done\n');
  assert.equal(readFileSync(cardPath(worktree, N), 'utf8'), cardFile('Card three', 'Done'));
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-m', 'close card three');
  assert.deepEqual(view(worktree), { 3: ['Awaiting push', 'OPEN'] });
  const pending = intake(worktree);
  assert.deepEqual(pending.sections, ['=== #3 [Awaiting push] Card three ===']);
  assert.equal(pending.claimed, claimCount(1));
  const waiting = runScript(worktree, 'board-move.mjs', [String(N), 'Awaiting push']);
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.equal(waiting.stdout, 'board-move: #3 at Awaiting push — branch job/3\n');

  // 3. The push is interrupted before its draft: the card stays a visible claim, and In review is refused.
  git(worktree, 'push', 'origin', `job/${N}`);
  const originTip = git(origin, 'rev-parse', `refs/heads/job/${N}`).trim();
  const noDraft = runScript(worktree, 'board-move.mjs', [String(N), 'In review']);
  assert.equal(noDraft.status, 1, noDraft.stderr);
  assert.equal(noDraft.stdout, '');
  assert.ok(noDraft.stderr.includes('no open pull request from job/3 in example-owner/example-repo'), noDraft.stderr);
  const stillWaiting = intake(worktree);
  assert.deepEqual(stillWaiting.sections, ['=== #3 [Awaiting push] Card three ===']);
  assert.equal(stillWaiting.claimed, claimCount(1));
  git(cloneB, 'fetch', 'origin');
  const other = intake(cloneB);
  assert.deepEqual(other.sections, ['=== #3 [In progress] Card three ===']);
  assert.equal(other.claimed, claimCount(1));
  assert.deepEqual(other.claims, ['claim: branch job/3 (origin)']);
  assert.ok(other.run.stderr.includes('#3 [In progress] Card three — claimed in "In progress" but no closing pull request exists'), other.run.stderr);

  // 4. The race: B's own job/3 does not hold origin's tip, so B's claim command refuses.
  git(cloneB, 'switch', '-c', `job/${N}`, 'main');
  const race = runScript(cloneB, 'board-move.mjs', [String(N), 'In progress']);
  assert.equal(race.status, 1, race.stderr);
  assert.equal(race.stdout, '');
  assert.ok(race.stderr.includes(`origin's job/3 (${originTip}) is not in this branch`), race.stderr);
  assert.equal(git(origin, 'rev-parse', `refs/heads/job/${N}`).trim(), originTip);

  // 5. The draft opens: In review holds, and the card leaves the claims list on both clones.
  const review = runScript(worktree, 'board-move.mjs', [String(N), 'In review'], draft);
  assert.equal(review.status, 0, review.stderr);
  assert.equal(review.stdout, 'board-move: #3 at In review — branch job/3\n');
  for (const root of [worktree, cloneB]) {
    assert.deepEqual(view(root, draft), { 3: ['In review', 'OPEN'] });
    assert.equal(intake(root, draft).claimed, claimCount(0));
  }

  // 6. Nothing is written to the integration checkout, plainly or through an inherited GIT_DIR.
  const integrationCard = readFileSync(cardPath(cloneA, N));
  const worktreeGitDir = git(worktree, 'rev-parse', '--absolute-git-dir').trim();
  for (const env of [{}, { GIT_DIR: worktreeGitDir }]) {
    const integration = runScript(cloneA, 'board-move.mjs', [String(N), 'Done'], {}, env);
    assert.equal(integration.status, 1, integration.stderr);
    assert.equal(integration.stdout, '');
    assert.ok(integration.stderr.includes('this is the integration checkout'), integration.stderr);
    assert.deepEqual(readFileSync(cardPath(cloneA, N)), integrationCard);
  }

  // 7. The merge publishes the closing edit: Done and CLOSED everywhere, and closeout is clean.
  git(cloneA, 'push', 'origin', `job/${N}:refs/heads/main`);
  git(cloneA, 'fetch', 'origin');
  git(cloneB, 'fetch', 'origin');
  git(cloneA, 'merge', '--ff-only', 'origin/main');
  for (const root of [worktree, cloneB]) assert.deepEqual(view(root, draft), { 3: ['Done', 'CLOSED'] });
  const noop = runScript(cloneA, 'board-move.mjs', [String(N), 'Done']);
  assert.equal(noop.status, 0, noop.stderr);
  assert.equal(noop.stdout, 'board-move: #3 already at Done — no-op\n');
  const closeout = runScript(cloneA, 'board.mjs', ['--closeout']);
  assert.equal(closeout.status, 0, closeout.stdout + closeout.stderr);
});

// The Linear tracker, run as a spawned CLI: the fake transport stands in for the child that carries a
// request to api.linear.app. It answers each query from FAKE_LINEAR, keyed by what the query asks for,
// or fails with FAKE_LINEAR_FAIL as the real child does, on stderr with exit 1.
const linearTransport = installFakeTransport('board-portability-linear-', `
const { appendFileSync, readFileSync } = require('node:fs');
const { query, variables } = JSON.parse(readFileSync(0, 'utf8'));
if (process.env.FAKE_LINEAR_LOG) appendFileSync(process.env.FAKE_LINEAR_LOG, JSON.stringify({ query, variables }) + '\\n');
if (process.env.FAKE_LINEAR_FAIL) {
  process.stderr.write(process.env.FAKE_LINEAR_FAIL + '\\n');
  process.exitCode = 1;
} else {
  const answers = JSON.parse(process.env.FAKE_LINEAR);
  const answer = query.includes('teams(') ? answers.team
    : query.includes('issueLabels(') ? answers.labels
    : query.includes('issueCreate') ? answers.created
    : query.includes('issueRelationCreate') ? answers.related
    : query.includes('commentCreate') ? answers.commented
    : query.includes('commentUpdate') ? answers.commentEdits[variables.id]
    : query.includes('viewer') ? answers.viewer[variables.id]
    : query.includes('comments(') ? answers.cards[variables.id]
    : query.includes('children(') ? answers.childrenOf[variables.id]
    : query.includes('inverseRelations(') && variables.id !== undefined ? answers.relations[variables.id]
    : query.includes('filter: { parent:') ? answers.children
    : query.includes('title: { eq: $title }') ? answers.sameTitle
    : query.includes('IssueUpdateInput') ? answers.cardUpdates[variables.id]
    : query.includes('issueUpdate') ? answers.updates[variables.id]
    : variables.id !== undefined ? answers.moveReads[variables.id]
    : answers.issues;
  process.stdout.write(JSON.stringify(answer));
}
`, { variable: 'BOARD_TOOLKIT_LINEAR', file: 'linear.cjs' });
after(() => linearTransport.cleanup());

const linearState = (id, name, type) => ({ id, name, type });
const linearNode = (identifier, title, state, { parent = null, relations = [], description = null } = {}) => ({
  id: `id-${identifier}`,
  identifier,
  title,
  state,
  assignee: null,
  parent: parent && { identifier: parent },
  labels: { nodes: [{ name: 'task' }], pageInfo: { hasNextPage: false } },
  inverseRelations: { nodes: relations.map((from) => ({ type: 'blocks', issue: { identifier: from, state: { type: 'unstarted' } } })), pageInfo: { hasNextPage: false } },
  attachments: { nodes: [], pageInfo: { hasNextPage: false } },
  description,
});

const LINEAR_BACKLOG = linearState('s-backlog', 'Backlog', 'backlog');
const LINEAR_TODO = linearState('s-todo', 'Todo', 'unstarted');
const LINEAR_NODES = [
  linearNode('ENG-12', 'Card twelve', LINEAR_BACKLOG, { relations: ['ENG-2'], description: 'Do the twelve thing.' }),
  linearNode('ENG-2', 'Card two', LINEAR_TODO),
  linearNode('ENG-11', 'Card eleven', LINEAR_TODO, { parent: 'ENG-2' }),
];
const LINEAR_ANSWERS = {
  team: {
    teams: {
      nodes: [{
        id: 'team-eng',
        key: 'ENG',
        states: {
          nodes: [LINEAR_BACKLOG, LINEAR_TODO, linearState('s-progress', 'In Progress', 'started'), linearState('s-awaiting', 'Awaiting Push', 'started'), linearState('s-review', 'In Review', 'started'), linearState('s-done', 'Done', 'completed')],
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
  },
  issues: { issues: { nodes: LINEAR_NODES, pageInfo: { hasNextPage: false, endCursor: null } } },
  // The single-issue read a move makes, and the answer to moving ENG-12 to Ready.
  moveReads: Object.fromEntries(LINEAR_NODES.map((node) => [node.identifier, { issue: { id: node.id, identifier: node.identifier, team: { key: 'ENG' }, state: node.state } }])),
  updates: { 'id-ENG-12': { issueUpdate: { issue: { id: 'id-ENG-12', state: LINEAR_TODO } } } },
  children: { issues: { nodes: [{ identifier: 'ENG-11', parent: { identifier: 'ENG-2' }, state: { type: 'unstarted' } }], pageInfo: { hasNextPage: false, endCursor: null } } },
  cards: Object.fromEntries(LINEAR_NODES.map((node) => [node.identifier, {
    issue: {
      identifier: node.identifier,
      description: node.description,
      parent: node.parent,
      comments: { nodes: [{ id: `c-${node.identifier}`, createdAt: '2026-01-01T00:00:00.000Z', body: `Comment on ${node.identifier}` }], pageInfo: { hasNextPage: false, endCursor: null } },
    },
  }])),
};

function runLinearScript(root, script, args, env = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: tmpdir(),
    env: linearTransport.env({ FAKE_LINEAR: JSON.stringify(LINEAR_ANSWERS), ...env }),
  });
}

const runLinearBoard = (root, args, env) => runLinearScript(root, 'board.mjs', args, env);

test('linear board: the copied CLI prints the pick view and the intake document by identifier from the fake transport, and exits 2 naming the cause when the read fails', (t) => {
  const root = adoptToolkit(t, LINEAR_TEST_CONFIG);

  const pick = runLinearBoard(root, []);

  assert.equal(pick.status, 0, pick.stderr);
  // The Ready card nearest being worked leads, and ENG-2 sorts before ENG-11 as a number, not as text.
  assert.deepEqual(pick.stdout.split('\n').filter((line) => line.startsWith('Board ') || line.startsWith('ENG-')), [
    'Board linear team ENG — Backlog/Ready: 3 of 3 item(s)',
    'ENG-2 [Ready] Card two',
    'ENG-11 [Ready] Card eleven',
    'ENG-12 [Backlog] Card twelve',
  ]);

  const intake = runLinearBoard(root, ['--intake']);

  assert.equal(intake.status, 0, intake.stderr);
  const document = intake.stdout.split('\n');
  assert.equal(document[0], 'Board linear team ENG — Backlog/Ready: 3 of 3 item(s)');
  assert.deepEqual(document.filter((line) => line.startsWith('=== ')), [
    '=== ENG-2 [Ready] Card two ===',
    '=== ENG-11 [Ready] Card eleven ===',
    '=== ENG-12 [Backlog] Card twelve ===',
  ]);
  assert.ok(document.includes('parent: ENG-2'), intake.stdout);
  assert.ok(document.includes('open blockers: ENG-2'), intake.stdout);
  assert.ok(document.includes('| Do the twelve thing.'), intake.stdout);
  assert.ok(document.includes('| Comment on ENG-12'), intake.stdout);
  assert.ok(intake.stderr.includes('board intake: details complete for 3 card(s).'), intake.stderr);

  const failed = runLinearBoard(root, ['--intake'], { FAKE_LINEAR_FAIL: 'Linear refused the API key (HTTP 401)' });

  assert.equal(failed.status, 2, failed.stderr);
  assert.equal(failed.stdout, '');
  assert.ok(failed.stderr.includes('board: failed to read the Linear team ENG — Linear refused the API key (HTTP 401)'), failed.stderr);
});

test('linear board-move: the copied CLI moves a card by identifier, refuses a lane, and board-add refuses filing, naming linear-card.mjs', (t) => {
  const root = adoptToolkit(t, LINEAR_TEST_CONFIG);
  // Each request the fake transport receives, one JSON line apiece.
  const log = join(root, 'linear-requests.log');
  const writes = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter(({ query }) => query.includes('issueUpdate')) : []);
  const move = (args) => runLinearScript(root, 'board-move.mjs', args, { FAKE_LINEAR_LOG: log });

  const moved = move(['ENG-12', 'Ready']);

  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(moved.stdout, 'board-move: ENG-12 → Ready\n');
  assert.deepEqual(writes().map(({ variables }) => variables), [{ id: 'id-ENG-12', stateId: 's-todo' }]);

  rmSync(log);
  const noop = move(['ENG-2', 'Ready']);

  assert.equal(noop.status, 0, noop.stderr);
  assert.equal(noop.stdout, 'board-move: ENG-2 already at Ready — no-op\n');
  assert.deepEqual(writes(), []);

  const lane = move(['--lane', 'ENG-12:none']);

  assert.equal(lane.status, 1, lane.stderr);
  assert.equal(lane.stdout, '');
  assert.equal(lane.stderr, 'board-move: the linear tracker has no parked lane\n');
  assert.deepEqual(writes(), []);

  const add = runLinearScript(root, 'board-add.mjs', ['ENG-12', 'Ready']);

  assert.equal(add.status, 1, add.stderr);
  assert.equal(add.stdout, '');
  assert.equal(add.stderr, 'board-add: the linear tracker files a card with node scripts/linear-card.mjs create; see docs/LINEAR-CARDS.md\n');
});

// The rows a card command printed, one JSON array a line.
const cardRows = (result) => result.stdout.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));

// resume's completeness rules ("3. Start the job"): the rows of a complete read, or null.
function completeCardRead(result) {
  if (result.status !== 0) return null;
  const read = cardRows(result);
  const count = (name) => read.filter(([key]) => key === name).length;
  return count('state') === 1 && count('assignees') === 1 && read.at(-1)?.[0] === 'comments' ? read : null;
}

function completeBoardRead(result) {
  if (result.status !== 0) return null;
  const read = cardRows(result);
  const boards = read.filter(([key]) => key === 'board');
  return boards.length === 1 && !boards[0].slice(1).includes(null) && JSON.stringify(read.at(-1)) === '["boards",1]' ? read : null;
}

// resume's free check against the intake document, with the decision 6 identity on Linear: the board line's
// tracker and team are the ones the document's `Board linear team <KEY>` header names, and its column the one
// in the card's heading.
function freeAgainst(document, id, cardRead, boardRead) {
  const [, team] = /^Board linear team (\S+) — /.exec(document[0]);
  const start = document.findIndex((line) => line.startsWith(`=== ${id} [`));
  const section = document.slice(start, document.indexOf('', start));
  const [, column] = /^=== \S+ \[([^\]]+)\] /.exec(section[0]);
  const listed = section.find((line) => line.startsWith('assignees: ')).slice('assignees: '.length);
  const documentAssignees = listed === 'none' ? [] : listed.split(', ').map((name) => name.slice(1));
  const claimAt = section.findIndex((line) => line.startsWith('claim: '));
  const documentClaim = section[claimAt].startsWith('claim: none')
    ? null
    : [Number(/^claim: comment (\d+) of /.exec(section[claimAt])[1]), section[claimAt + 1].slice('| '.length)];
  const field = (name) => cardRead.find(([key]) => key === name)[1];
  const claims = cardRead.filter(([key]) => key === 'claim');
  const lastClaim = claims.length === 0 ? null : [claims.at(-1)[1], claims.at(-1)[5]];
  const [, tracker, key, boardColumn] = boardRead.find(([name]) => name === 'board');
  const assignees = field('assignees');
  return field('state') === 'OPEN' && tracker === 'linear' && key === team && boardColumn === column
    && assignees.length === documentAssignees.length && assignees.every((name) => documentAssignees.includes(name))
    && JSON.stringify(lastClaim) === JSON.stringify(documentClaim);
}

test('linear lifecycle: file, claim through the card and board reads judged by the resume rules, In progress, Awaiting push, In review and Done by Linear, and the closeout check', (t) => {
  const root = adoptToolkit(t, LINEAR_TEST_CONFIG);
  const log = join(root, 'linear-requests.log');
  const states = Object.fromEntries(LINEAR_ANSWERS.team.teams.nodes[0].states.nodes.map((state) => [state.name, state]));
  const pageEnd = { hasNextPage: false, endCursor: null };
  const BODY = '## Outcome\n\nThe thirteenth thing.\n';
  const CLAIM = 'Claim: laptop, Claude Code, 2026-01-02T00:00Z';
  const CLAIM_ID = '0000000c-0000-4000-8000-00000000000c';
  const CLAIM_URL = 'https://linear.app/acme/issue/ENG-13#comment-0000000c';
  const PENDING_ID = '0000000d-0000-4000-8000-00000000000d';
  const PENDING_URL = 'https://linear.app/acme/issue/ENG-13#comment-0000000d';
  const claimComment = { id: CLAIM_ID, body: CLAIM, createdAt: '2026-01-02T00:00:00.000Z', url: CLAIM_URL, user: { displayName: 'me' } };

  // Linear's answers while ENG-13, filed as a child of ENG-2 and blocked by ENG-12, is in `state`. Its blocker is
  // open while it is filed and done by the time it is picked. A move board-move writes is answered with `moveTo`;
  // In review and Done are the states Linear's own rules set.
  const answersAt = ({ state, blockerDone = true, moveTo = state, assignee = null, comments = [], attachments = [] }) => {
    const blocker = blockerDone ? states.Done : states.Backlog;
    const node = {
      ...linearNode('ENG-13', 'Card thirteen', state, { parent: 'ENG-2', description: BODY }),
      assignee: assignee && { displayName: assignee },
      inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'ENG-12', state: { type: blocker.type } } }], pageInfo: { hasNextPage: false } },
      attachments: { nodes: attachments.map((url) => ({ url, metadata: { linkKind: 'closes' } })), pageInfo: { hasNextPage: false } },
    };
    const nodes = LINEAR_NODES.map((other) => (other.identifier === 'ENG-12' ? { ...other, state: blocker } : other));
    return {
      ...LINEAR_ANSWERS,
      issues: { issues: { nodes: [...nodes, node], pageInfo: pageEnd } },
      moveReads: { ...LINEAR_ANSWERS.moveReads, 'ENG-13': { issue: { id: 'id-ENG-13', identifier: 'ENG-13', team: { key: 'ENG' }, state } } },
      children: { issues: { nodes: [...LINEAR_ANSWERS.children.issues.nodes, { identifier: 'ENG-13', parent: { identifier: 'ENG-2' }, state: { type: state.type } }], pageInfo: pageEnd } },
      cards: {
        ...LINEAR_ANSWERS.cards,
        'ENG-13': { issue: { identifier: 'ENG-13', description: BODY, parent: { identifier: 'ENG-2' }, state, assignee: node.assignee, comments: { nodes: comments, pageInfo: pageEnd } } },
      },
      relations: { 'ENG-13': { issue: { title: 'Card thirteen', description: BODY, parent: { identifier: 'ENG-2' }, inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'ENG-12' } }], pageInfo: pageEnd } } } },
      childrenOf: { 'ENG-2': { issue: { children: { nodes: [{ identifier: 'ENG-11' }, { identifier: 'ENG-13' }], pageInfo: pageEnd } } } },
      labels: { issueLabels: { nodes: [{ id: 'label-task', team: null }], pageInfo: pageEnd } },
      sameTitle: { issues: { nodes: [], pageInfo: pageEnd } },
      created: { issueCreate: { issue: { id: 'id-ENG-13', identifier: 'ENG-13' } } },
      related: { issueRelationCreate: { issueRelation: { id: 'relation-ENG-12-ENG-13' } } },
      viewer: {
        'ENG-13': { viewer: { id: 'user-me', displayName: 'me' }, issue: { assignee: assignee && { id: 'user-me', displayName: assignee } } },
        // edit-comment's read of the pending comment, which the viewer wrote on ENG-13.
        [PENDING_ID]: { viewer: { id: 'user-me' }, comment: { user: { id: 'user-me' }, issue: { identifier: 'ENG-13', team: { key: 'ENG' } } } },
      },
      commented: { commentCreate: { comment: comments.length === 0 ? { id: CLAIM_ID, url: CLAIM_URL } : { id: PENDING_ID, url: PENDING_URL } } },
      commentEdits: { [PENDING_ID]: { commentUpdate: { comment: { id: PENDING_ID, url: PENDING_URL } } } },
      updates: { 'id-ENG-13': { issueUpdate: { issue: { id: 'id-ENG-13', state: moveTo } } } },
      cardUpdates: { 'id-ENG-13': { issueUpdate: { issue: { assignee: { displayName: 'me' }, parent: { identifier: 'ENG-2' } } } } },
    };
  };
  const step = (script, args, at) => runLinearScript(root, script, args, { FAKE_LINEAR: JSON.stringify(answersAt(at)), FAKE_LINEAR_LOG: log });
  const card = (args, at) => {
    const result = step('linear-card.mjs', args, at);
    assert.equal(result.status, 0, result.stderr);
    return cardRows(result);
  };
  const filed = { state: states.Backlog, blockerDone: false };
  const ready = { state: states.Todo };
  const claimed = { state: states['In Progress'], assignee: 'me', comments: [claimComment] };

  // File: to-issues creates the card, checks its publication and reads its blockers back.
  const bodyFile = join(root, 'body.md');
  writeFileSync(bodyFile, BODY);
  assert.deepEqual(card(['create', '--title', 'Card thirteen', '--body-file', bodyFile, '--status', 'Backlog', '--kind', 'task', '--parent', 'ENG-2', '--blocked-by', 'ENG-12'], filed), [
    ['created', 'ENG-13'],
    ['block', 'ENG-13', 'ENG-12'],
  ]);
  const published = step('verify-issue-publish.mjs', ['ENG-2', 'ENG-11', 'ENG-13'], filed);
  assert.equal(published.status, 0, published.stderr);
  assert.ok(published.stdout.endsWith('issue-publish: child set verified: ENG-2 has exactly the 2 supplied child issues.\n'), published.stdout);
  assert.deepEqual(card(['text', 'ENG-13'], filed).slice(0, 4), [['title', 'Card thirteen'], ['body', BODY], ['parent', 'ENG-2'], ['blockedBy', ['ENG-12']]]);

  // Claim, once the blocker is done and the card is in Ready: the intake document, then the card and board
  // reads, complete and free against it.
  const intake = step('board.mjs', ['--intake'], ready);
  assert.equal(intake.status, 0, intake.stderr);
  const document = intake.stdout.split('\n');
  assert.equal(document[0], 'Board linear team ENG — Backlog/Ready: 3 of 4 item(s)');
  const cardRead = completeCardRead(step('linear-card.mjs', ['view', 'ENG-13'], ready));
  const boardRead = completeBoardRead(step('linear-card.mjs', ['view', 'ENG-13', '--board'], ready));
  assert.deepEqual(cardRead, [['state', 'OPEN'], ['assignees', []], ['comments', 0]]);
  assert.deepEqual(boardRead, [['board', 'linear', 'ENG', 'Ready'], ['boards', 1]]);
  assert.equal(freeAgainst(document, 'ENG-13', cardRead, boardRead), true);

  const moved = step('board-move.mjs', ['ENG-13', 'In progress'], { ...ready, moveTo: states['In Progress'] });
  assert.equal(moved.stdout, 'board-move: ENG-13 → In progress\n', moved.stderr);
  assert.deepEqual(card(['assign', 'ENG-13'], { state: states['In Progress'] }), [['assignees', ['me']]]);
  assert.deepEqual(card(['comment', 'ENG-13', '--body', CLAIM], { state: states['In Progress'], assignee: 'me' }), [['comment', CLAIM_ID, CLAIM_URL]]);

  // The read after the claim shows the recorded address as the first claim the read before did not show,
  // and the same reads judged against the intake document are no longer free.
  const heldRead = completeCardRead(step('linear-card.mjs', ['view', 'ENG-13'], claimed));
  const heldBoard = completeBoardRead(step('linear-card.mjs', ['view', 'ENG-13', '--board'], claimed));
  assert.deepEqual(heldRead, [['state', 'OPEN'], ['assignees', ['me']], ['claim', 1, 'me', claimComment.createdAt, CLAIM_URL, CLAIM, CLAIM_ID], ['comments', 1]]);
  assert.deepEqual(heldBoard, [['board', 'linear', 'ENG', 'In progress'], ['boards', 1]]);
  assert.equal(freeAgainst(document, 'ENG-13', heldRead, heldBoard), false);

  const awaiting = step('board-move.mjs', ['ENG-13', 'Awaiting push'], { ...claimed, moveTo: states['Awaiting Push'] });
  assert.equal(awaiting.stdout, 'board-move: ENG-13 → Awaiting push\n', awaiting.stderr);

  // Linear's own pull request rules move the card to In review and Done; board-move only checks each.
  const pull = ['https://github.com/example-owner/example-repo/pull/40'];
  const review = step('board-move.mjs', ['ENG-13', 'In review'], { ...claimed, state: states['In Review'], attachments: pull });
  assert.equal(review.stdout, 'board-move: ENG-13 at In review — moved by Linear\n', review.stderr);
  const done = { ...claimed, state: states.Done, attachments: pull };
  const merged = step('board-move.mjs', ['ENG-13', 'Done'], done);
  assert.equal(merged.stdout, 'board-move: ENG-13 at Done — moved by Linear\n', merged.stderr);

  // Closeout: the card's state, its pending comment and the edit that settles it, and the closeout check.
  assert.deepEqual(card(['view', 'ENG-13'], done)[0], ['state', 'CLOSED']);
  assert.deepEqual(card(['comment', 'ENG-13', '--body', 'Cleanup pending: job/ENG-13'], done), [['comment', PENDING_ID, PENDING_URL]]);
  assert.deepEqual(card(['edit-comment', PENDING_ID, '--body', 'Cleanup done: job/ENG-13'], done), [['comment', PENDING_ID, PENDING_URL]]);
  const closeout = step('board.mjs', ['--closeout'], done);
  assert.equal(closeout.status, 0, closeout.stdout + closeout.stderr);

  // Every write, in order: none for a read, a no-op or a move Linear made.
  const writes = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter(({ query }) => query.startsWith('mutation'))
    .map(({ query, variables }) => [/^mutation\([^)]*\) \{ (\w+)\(/.exec(query)[1], variables]);
  assert.deepEqual(writes, [
    ['issueCreate', { input: { teamId: 'team-eng', title: 'Card thirteen', description: BODY, stateId: 's-backlog', labelIds: ['label-task'], parentId: 'id-ENG-2' } }],
    ['issueRelationCreate', { issueId: 'id-ENG-12', relatedIssueId: 'id-ENG-13' }],
    ['issueUpdate', { id: 'id-ENG-13', stateId: 's-progress' }],
    ['issueUpdate', { id: 'id-ENG-13', input: { assigneeId: 'user-me' } }],
    ['commentCreate', { issueId: 'id-ENG-13', body: CLAIM }],
    ['issueUpdate', { id: 'id-ENG-13', stateId: 's-awaiting' }],
    ['commentCreate', { issueId: 'id-ENG-13', body: 'Cleanup pending: job/ENG-13' }],
    ['commentUpdate', { id: PENDING_ID, body: 'Cleanup done: job/ENG-13' }],
  ]);
});
