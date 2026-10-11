// board-portability.test.mjs — the adoption contract for the board toolkit.
// Run: node --test scripts/lib/board-portability.test.mjs
//
// Another repository adopts the toolkit by copying exactly the toolkit's named files
// (TOOLKIT_LIB and CLI_ENTRY_POINTS below) unchanged and editing only board-config.mjs.
// These tests do exactly that into a temp directory, alongside TEST_SUPPORT_LIB's one
// fixture helper the tests need but no adopter ships, and import the copies, so each test
// runs against fresh module instances wired to the literal config written here, never to
// this repository's own board-config.mjs. An incomplete TOOLKIT_LIB fails these tests at
// import, the same way it would fail a real adopter.
//
// Price tag: recurring cost is roughly 1 s per suite run (27 temp-directory copies of the
// toolkit, one per test, 3 spawned board.mjs CLI processes and 1 spawned board-move.mjs).
// Removal condition: retire it when the board toolkit is no longer copied into another
// repository.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeGh } from './fake-gh.mjs';

const LIB = fileURLToPath(new URL('.', import.meta.url));
const SCRIPTS = fileURLToPath(new URL('..', import.meta.url));
const CLI_ENTRY_POINTS = ['board.mjs', 'board-add.mjs', 'board-move.mjs', 'verify-issue-publish.mjs'];

// The transitive closure of relative imports from the four CLI entry points above. Copying
// exactly this set, no more, is the adoption contract itself: a file the toolkit no longer
// imports must fall out of here or an adopter carries dead weight neither test nor doc admits to.
const TOOLKIT_LIB = [
  'board.mjs',
  'board-rules.mjs',
  'board-config.mjs',
  'board-add.mjs',
  'board-move.mjs',
  'issue-publish.mjs',
  'gh-exec.mjs',
  'cli-flags.mjs',
];

// Not part of the toolkit an adopter ships: a test helper, copied only so it builds fixtures
// against the adopted board-config.mjs rather than this repository's own.
const TEST_SUPPORT_LIB = ['board-fixtures.mjs'];

// Written out literally, as an adopter would, so an export the real config gains that
// this copy lacks fails at import exactly as it would for them.
const CONFIG_TAIL = `
export const STATUS_OPTIONS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
export const PICKABLE_STATUSES = ['Backlog', 'Ready'];
export const WAIT_STATUSES = ['Awaiting push'];
export const TERMINAL_STATUSES = ['Done'];
export const ROUTING_FIELD = 'Workstream';
export const ROUTING_OPTIONS = ['Go-to-market', 'Product', 'Platform'];
export const KIND_LABELS = { epic: 'epic', feature: 'enhancement', task: 'task', bug: 'bug', docs: 'documentation' };
export const PARKED_LANE = null;
`;

const ORGANISATION_CONFIG = `export const BOARD_OWNER = 'acme-org';
export const BOARD_OWNER_TYPE = 'organization';
export const BOARD_PROJECT_NUMBER = 7;
export const BOARD_REPOSITORY = 'widgets';
${CONFIG_TAIL}`;

const USER_CONFIG = `export const BOARD_OWNER = 'example-owner';
export const BOARD_OWNER_TYPE = 'user';
export const BOARD_PROJECT_NUMBER = 2;
export const BOARD_REPOSITORY = 'example-repo';
${CONFIG_TAIL}`;

function adoptToolkit(t, configSource) {
  const tmp = mkdtempSync(join(tmpdir(), 'board-portability-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const lib = join(tmp, 'scripts', 'lib');
  mkdirSync(lib, { recursive: true });
  for (const file of [...TOOLKIT_LIB, ...TEST_SUPPORT_LIB]) copyFileSync(join(LIB, file), join(lib, file));
  for (const file of CLI_ENTRY_POINTS) copyFileSync(join(SCRIPTS, file), join(tmp, 'scripts', file));
  writeFileSync(join(lib, 'board-config.mjs'), configSource);
  return tmp;
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
function recordingGh(rootKey, boardPage, currentValues = { Status: 'Ready' }) {
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
    if (query.includes('projectItems(first:10)') && valueField) {
      const current = currentValues[valueField[1]];
      const nodes = [{ id: 'PVTI_11', project: { number: boardPage.data[rootKey].projectV2.number }, value: current ? { name: current } : null }];
      return JSON.stringify({ data: { repository: { issue: { projectItems: { nodes } } } } });
    }
    if (query.includes('subIssues')) {
      return JSON.stringify({ data: { repository: { issue: { subIssues: { totalCount: 0, nodes: [] } } } } });
    }
    if (query.includes('addProjectV2ItemById')) return JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'PVTI_11' } } } });
    if (query.includes('updateProjectV2ItemFieldValue')) {
      return JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_11' } } } });
    }
    if (query.includes('{ id } } }')) return JSON.stringify({ data: { repository: { issue: { id: 'I_11' } } } });
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
  const silent = { log() {}, error() {} };
  const { moveCards } = await load(root, 'lib/board-move.mjs');
  const { main: boardAdd } = await load(root, 'board-add.mjs');
  const { main: verifyPublish } = await load(root, 'verify-issue-publish.mjs');
  await load(root, 'board-move.mjs');

  const move = recordingGh(rootKey, page);
  assert.deepEqual(moveCards([{ issueNumber: 11, statusName: 'Done' }], move.exec), [
    { issueNumber: 11, statusName: 'Done', skipped: false, cleared: false },
  ]);
  const add = recordingGh(rootKey, page);
  assert.equal(boardAdd(['11', 'Ready', 'Product'], { ghExec: add.exec, output: silent }), 0);
  const verify = recordingGh(rootKey, page);
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
  const { exec, sent } = recordingGh('organization', await boardPageFor(root));
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
  const { parseIssueItemId } = await load(root, 'lib/board-move.mjs');
  const offBoard = { data: { repository: { issue: { projectItems: { nodes: [{ id: 'x', project: { number: 8 } }] } } } } };

  assert.throws(() => parseIssueItemId(offBoard, 999), {
    message: 'issue #999 is not on the board — add it with a Status: node scripts/board-add.mjs 999 <Status>',
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
  const { exec: answer } = recordingGh('organization', await boardPageFor(root));
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
  const gh = recordingGh('organization', await boardPageFor(root), currentValues);
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
  const item = (id, lane) => ({
    data: { repository: { issue: { projectItems: { nodes: [{ id, project: { number: 7 }, value: lane ? { name: lane } : null }] } } } },
  });
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
