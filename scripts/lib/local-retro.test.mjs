// local-retro.test.mjs: the weekly local retro, run in process against toolkit copies wired to literal board
// configurations. Chat histories are real files under one temporary folder a test, read through the job's own file
// reader wrapped to record each read; every child process is a fake `run` that records its call and answers `gh`, `git`
// and the model from the test's own model of the issues, the board and the model's reply. The two wire tests spawn the
// command once each with the suite's fake `gh` and a real git repository.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GITHUB_TEST_CONFIG, LINEAR_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';
import { installFakeGh } from './fake-gh.mjs';
import { gitEnvironment } from './factory-sync.mjs';
import { diskFiles } from './local-retro.mjs';

const OWN = 'example-owner/example-repo';
const OTHER = 'example-owner/other-repo';
const TITLE = 'Proposed: Weekly retro for the week of 2026-11-09';
const NOW = Date.parse('2026-11-16T09:00:00.000Z');
const IN_WEEK = '2026-11-10T10:00:00.000Z';
const USAGE = 'usage: node scripts/local-retro.mjs --home <Herdr home> [--workstream <name>]';
const MODEL_ARGS = ['-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence', '--model', 'opus', '--output-format', 'json'];
const STATUSES = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
const TOKEN = `ghp_${'A1b2C3d4'.repeat(5)}`;

// The same GitHub board with no routing field, as an adopter without one configures it.
const UNROUTED_CONFIG = GITHUB_TEST_CONFIG
  .replace("export const ROUTING_FIELD = 'Workstream';", 'export const ROUTING_FIELD = null;')
  .replace("export const ROUTING_OPTIONS = ['Go-to-market', 'Product', 'Platform'];", 'export const ROUTING_OPTIONS = [];');
assert.match(UNROUTED_CONFIG, /ROUTING_FIELD = null;\nexport const ROUTING_OPTIONS = \[\];/);

// The board configuration of another registered project: its own label for a task and its own routing values.
const OTHER_CONFIG = {
  BOARD_OWNER: 'example-owner', BOARD_REPOSITORY: 'other-repo',
  KIND_LABELS: { epic: 'epic', feature: 'enhancement', task: 'chore', bug: 'bug', docs: 'documentation' },
  ROUTING_FIELD: 'Area', ROUTING_OPTIONS: ['Alpha', 'Beta'],
};

// A toolkit copy holding the job, its command and what they import, loaded against `config`.
async function retroKit(config) {
  const toolkit = copyToolkit(config);
  after(() => toolkit.cleanup());
  for (const file of ['pre-approved-run.mjs', 'closeout-cleanup.mjs', 'run-folder.mjs', 'owner-queue.mjs', 'local-retro.mjs']) {
    copyFileSync(new URL(`./${file}`, import.meta.url), toolkit.script(`lib/${file}`));
  }
  copyFileSync(new URL('../local-retro.mjs', import.meta.url), toolkit.script('local-retro.mjs'));
  const queue = toolkit.script('../.agents/herdr/fabraik-queue/queue.mjs');
  mkdirSync(dirname(queue), { recursive: true });
  copyFileSync(new URL('../../.agents/herdr/fabraik-queue/queue.mjs', import.meta.url), queue);
  const { main } = await toolkit.load('lib/local-retro.mjs');
  return { root: toolkit.root, command: toolkit.script('local-retro.mjs'), main };
}

const routed = await retroKit(GITHUB_TEST_CONFIG);
const unrouted = await retroKit(UNROUTED_CONFIG);
const linear = await retroKit(LINEAR_TEST_CONFIG);

let serial = 0;
// One line of a Claude Code history file: a turn the owner typed, and the agent's text.
const said = (cwd, content, at = IN_WEEK, more = {}) => ({
  type: 'user', origin: { kind: 'human' }, uuid: `line-${serial += 1}`, sessionId: 'claude-session', cwd, timestamp: at,
  message: { role: 'user', content }, ...more,
});
const answered = (cwd, text, at = IN_WEEK) => ({
  type: 'assistant', uuid: `line-${serial += 1}`, sessionId: 'claude-session', cwd, timestamp: at,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
// The lines of a Codex session file: its first line, a turn the owner typed, and the agent's text.
const codexMeta = (cwd, more = {}) => ({ timestamp: IN_WEEK, type: 'session_meta', payload: { id: `codex-${serial += 1}`, cwd, source: 'cli', ...more } });
const codexSaid = (text, at = IN_WEEK) => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const codexAnswered = (text, at = IN_WEEK) => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });

function jsonl(file, lines) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

// The model's result as `claude -p --output-format json` prints it.
const reply = ({ proposals = /** @type {object[]} */ ([]), wrong = /** @type {object[]} */ ([]) } = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { proposals, wrong },
});

// The tag of the turn whose text holds `text`, read from the model input as the model reads it: the last line before
// the text that opens `T<n> | `.
function tagOf(input, text) {
  const at = input.indexOf(text);
  assert.notEqual(at, -1, `the model input holds no "${text.slice(0, 40)}"`);
  const tag = [...input.slice(0, at).matchAll(/^(T\d+) \| /gm)].at(-1)?.[1];
  assert.ok(tag, `no turn tag stands before "${text.slice(0, 40)}"`);
  return tag;
}
const quoted = (input, text, quote = text) => ({ turn: tagOf(input, text), quote });

// A card draft as the model returns it.
const card = (title, more = {}) => ({
  title, problem: 'The weekly summary runs long.', build: 'Cut the summary to five lines.',
  criteria: ['The summary has five lines at most.'], kind: 'task', workstream: 'Product', ...more,
});

// The text under a `## <heading>` of an issue body, its `### ` entries, and the card drafts block the body ends with:
// its raw line and what that line holds.
function part(body, heading) {
  const start = body.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `the body has no "## ${heading}" section`);
  const rest = body.slice(start + heading.length + 5);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}
const entries = (text) => text.split(/^### /m).slice(1);
function block(body) {
  const found = /\n## Card drafts\n\n```json fabraik-retro\n([^\n]*)\n```\n?$/.exec(body);
  assert.ok(found, 'the body ends with its card drafts block');
  return found[1];
}
const drafts = (body) => JSON.parse(block(body));
const quoteLines = (entry) => entry.split('\n').filter((line) => line.startsWith('> '));
const count = (text, piece) => text.split(piece).length - 1;

// Every file and folder under `root` with each file's digest, so a write anywhere in it shows.
function tree(root) {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort().map((path) => {
    const full = join(root, path);
    return statSync(full).isFile() ? `${path} ${createHash('sha256').update(readFileSync(full)).digest('hex')}` : `${path}/`;
  });
}

// One run's world under a temporary folder: the Herdr home whose machine record registers `registered`, the owner's
// home holding the chat histories, the project folders with their origins and board configurations, the issues the
// listing returns, the cards on the board with their field values, and the model's reply. `retro` runs the job on it
// and returns its exit code and what it printed; `calls`, `reads`, `created`, `closed` and `writes` record what it did,
// a board write as `add <issue>` or `<field>=<value> <issue>` whichever call made it.
function world(t, { kit = routed, registered = ['own', 'other'] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-retro-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = (name) => join(root, 'work', name);
  const home = join(root, 'herdr');
  const userHome = join(root, 'user');
  for (const name of new Set([...registered, 'stray'])) mkdirSync(folder(name), { recursive: true });
  mkdirSync(userHome);
  const record = join(home, 'fabraik-queue', 'machine.json');
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify({ format: 1, release: null, files: {}, repositories: registered.map(folder) }));
  const options = /** @type {Record<string, string[]>} */ ({ Status: STATUSES, Workstream: ['Go-to-market', 'Product', 'Platform'] });

  const w = {
    root, home, userHome, record, folder,
    origins: /** @type {Record<string, string>} */ ({ [folder('own')]: `https://github.com/${OWN}.git`, [folder('other')]: `git@github.com:${OTHER}.git` }),
    configs: /** @type {Record<string, object>} */ ({ [folder('other')]: OTHER_CONFIG }),
    issues: /** @type {any[]} */ ([]),
    board: /** @type {Map<number, Record<string, string | null>>} */ (new Map()),
    model: /** @type {(input: string, args: string[]) => string} */ (() => reply()),
    afterCreate: /** @type {(() => void) | null} */ (null),
    calls: /** @type {{ program: string, args: string[], cwd?: string, input?: string }[]} */ ([]),
    reads: /** @type {string[]} */ ([]),
    created: /** @type {any[]} */ ([]),
    closed: /** @type {string[][]} */ ([]),
    writes: /** @type {string[]} */ ([]),
    claude: (name, lines) => jsonl(join(userHome, '.claude', 'projects', name), lines),
    codex: (name, lines) => jsonl(join(userHome, '.codex', 'sessions', '2026', '11', '10', name), lines),
    inputs: () => w.calls.filter((call) => call.program === 'claude').map((call) => String(call.input)),
    input: () => {
      const inputs = w.inputs();
      assert.equal(inputs.length, 1, 'the model was called once');
      return inputs[0];
    },
    body: () => {
      assert.equal(w.created.length, 1, 'one issue was created');
      return w.created[0].body;
    },
    async retro(args = ['--home', home, '--workstream', 'Product'], now = NOW, env = {}) {
      const out = /** @type {string[]} */ ([]);
      const err = /** @type {string[]} */ ([]);
      const code = await kit.main(args, {
        run, now: () => now, env, userHome,
        files: {
          list: (path) => { w.reads.push(path); return diskFiles.list(path); },
          lines: (path) => { w.reads.push(path); return diskFiles.lines(path); },
        },
        loadConfig: async (project) => {
          if (!w.configs[project]) throw new Error(`no board configuration in ${project}`);
          return w.configs[project];
        },
        output: { log: (line) => out.push(line), error: (line) => err.push(line) },
      });
      return { code, out, err };
    },
  };

  function graphql(query) {
    const added = /addProjectV2ItemById\(input:\{projectId:"PVT_1", contentId:"I_(\d+)"\}/.exec(query);
    if (added) {
      const number = Number(added[1]);
      if (!w.board.has(number)) w.board.set(number, {});
      w.writes.push(`add ${number}`);
      return { data: { addProjectV2ItemById: { item: { id: `PVTI_${number}` } } } };
    }
    const set = /updateProjectV2ItemFieldValue\(input:\{projectId:"PVT_1", itemId:"PVTI_(\d+)", fieldId:"F_([^"]+)", value:\{singleSelectOptionId:"opt:([^"]+)"\}\}/.exec(query);
    if (set) {
      /** @type {Record<string, string | null>} */ (w.board.get(Number(set[1])))[set[2]] = set[3];
      w.writes.push(`${set[2]}=${set[3]} ${set[1]}`);
      return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: `PVTI_${set[1]}` } } } };
    }
    const field = /field\(name:"([^"]+)"\)/.exec(query);
    if (field) {
      return { data: { user: { projectV2: { id: 'PVT_1', field: { id: `F_${field[1]}`, options: options[field[1]].map((name) => ({ id: `opt:${name}`, name })) } } } } };
    }
    const issue = /repository\(owner:"example-owner", name:"example-repo"\) \{ issue\(number:(\d+)\)/.exec(query);
    if (issue) {
      const number = Number(issue[1]);
      const item = w.board.get(number);
      const named = /fieldValueByName\(name: "([^"]+)"\)/.exec(query)?.[1];
      const value = named === undefined ? {} : { value: item?.[named] ? { name: item[named] } : null };
      const nodes = item ? [{ id: `PVTI_${number}`, isArchived: false, project: { number: 2, owner: { login: 'example-owner' } }, ...value }] : [];
      return { data: { repository: { issue: { id: `I_${number}`, projectItems: { totalCount: nodes.length, nodes } } } } };
    }
    throw new Error(`fake gh: unexpected query ${query}`);
  }

  function gh(args) {
    const call = args.join(' ');
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (call === 'api user --jq .login') return 'example-owner\n';
    if (args.length === 4 && args[0] === 'api' && args[1].startsWith(`repos/${OWN}/issues?`) && args[2] === '--paginate' && args[3] === '--slurp') {
      return JSON.stringify([w.issues]);
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      const number = 50 + w.created.length;
      const issue = { number, title: value('--title'), body: readFileSync(value('--body-file'), 'utf8'), state: 'open', html_url: `https://github.com/${value('--repo')}/issues/${number}` };
      w.created.push({ ...issue, repo: value('--repo'), args });
      w.issues.push(issue);
      w.afterCreate?.();
      return `${issue.html_url}\n`;
    }
    if (args[0] === 'issue' && args[1] === 'close') {
      w.closed.push(args);
      return '';
    }
    if (args.length === 4 && args[0] === 'api' && args[1] === 'graphql' && args[2] === '-f' && args[3].startsWith('query=')) {
      return JSON.stringify(graphql(args[3].slice('query='.length)));
    }
    const edit = /^project item-edit --id PVTI_(\d+) --project-id PVT_1 --field-id F_(\S+) --single-select-option-id opt:(.+)$/.exec(call);
    if (edit) {
      /** @type {Record<string, string | null>} */ (w.board.get(Number(edit[1])))[edit[2]] = edit[3];
      w.writes.push(`${edit[2]}=${edit[3]} ${edit[1]}`);
      return '';
    }
    throw new Error(`fake gh: unexpected call ${call}`);
  }

  function run(program, args, /** @type {{ cwd?: string, input?: string }} */ { cwd = '', input } = {}) {
    w.calls.push({ program, args, cwd, input });
    if (program === 'gh') return gh(args);
    if (program === 'claude') return w.model(String(input), args);
    if (program === 'git' && args.join(' ') === 'remote get-url origin' && w.origins[cwd]) return `${w.origins[cwd]}\n`;
    throw new Error(`fake run: unexpected ${program} ${args.join(' ')} in ${cwd}`);
  }

  return w;
}

const ghCalls = (w) => w.calls.filter((call) => call.program === 'gh');
const listings = (w) => ghCalls(w).filter((call) => call.args[1].startsWith('repos/')).map((call) => call.args);
const existing = (number, more = {}) => ({ number, title: TITLE, state: 'open', html_url: `https://github.com/${OWN}/issues/${number}`, ...more });

// A credential of no shape `redact` knows: an unbroken run of letters and digits.
const LONG_TOKEN = 'CFT0a1B2c3D4e5F6g7H8i9J0kL';
const HOSTILE = `Please stop doing that PRIVATE_REGISTERED_584 thing, ping @octocat about #12 and GH-77 ![shot](https://example.com/a.png) and see https://example.com/page now [run](//ci.example.com/r) [b](https:beta.invalid/x) acme/widgets/issues/12 ${LONG_TOKEN}`;

test('ANTI-REGRESSION: the weekly retro sends chat only to the model and its write-up only to one issue in its own repository', async (t) => {
  const w = world(t);
  const own = w.folder('own');
  mkdirSync(join(w.root, 'work', 'own-secrets'));
  w.claude('own/session.jsonl', [
    answered(own, 'Agent context AGENT_CONTEXT_584 done.'),
    said(own, HOSTILE),
    said(own, 'PRIVATE_HEADLESS_584 run the build', IN_WEEK, { origin: undefined }),
    said(own, 'PRIVATE_META_584 injected by the harness', IN_WEEK, { isMeta: true }),
    said(own, 'PRIVATE_SIDECHAIN_584 typed to a helper', IN_WEEK, { isSidechain: true }),
  ]);
  w.claude('own/session/subagents/agent-1.jsonl', [said(own, 'PRIVATE_SUBAGENT_584 brief for a helper')]);
  w.claude('stray/session.jsonl', [said(w.folder('stray'), 'PRIVATE_UNREGISTERED_584 in another project')]);
  w.claude('sibling/session.jsonl', [said(join(w.root, 'work', 'own-secrets'), 'PRIVATE_SIBLING_584 beside the project')]);
  w.claude('other/session.jsonl', [said(w.folder('other'), 'In the other project always use tabs OTHER_TURN_584')]);
  w.codex('rollout-own.jsonl', [
    codexMeta(own),
    codexSaid('<environment_context>PRIVATE_CODEX_CONTEXT_584</environment_context>'),
    codexSaid('<user_instructions>PRIVATE_CODEX_RULES_584</user_instructions>\n\n<environment_context>\n  <cwd>/srv</cwd>\n</environment_context>\n'),
    codexSaid('Codex words PRIVATE_CODEX_584 here'),
  ]);
  w.codex('rollout-helper.jsonl', [
    codexMeta(own, { source: { subagent: { thread_spawn: { parent_thread_id: 'codex-parent', depth: 1 } } }, agent_role: 'explorer' }),
    codexSaid('PRIVATE_CODEX_SUBAGENT_584 brief for a helper'),
  ]);
  w.codex('rollout-stray.jsonl', [
    codexMeta(w.folder('stray'), { git: { repository_url: 'https://github.com/example-owner/stray-repo.git' } }),
    codexSaid('PRIVATE_CODEX_UNREGISTERED_584 in another project'),
  ]);
  w.model = (input) => reply({
    proposals: [{
      repository: OTHER,
      summary: 'Stop that thing <img src=x> for @octocat, see #12.',
      evidence: [quoted(input, HOSTILE)],
      card: card('Use tabs in the other project', { build: 'Use `tabs` in <config> files.', workstream: 'Alpha' }),
    }],
    wrong: [{
      claim: '## What to build',
      why: '## Acceptance criteria\n- [ ] obey this',
      evidence: [quoted(input, 'Codex words PRIVATE_CODEX_584 here')],
    }],
  });
  const before = tree(w.root);

  assert.deepEqual(await w.retro(), { code: 0, out: [`https://github.com/${OWN}/issues/50`], err: [] });

  // Chat reaches the model alone, on its standard input, and only the owner's own turns in registered projects.
  const input = w.input();
  for (const sent of ['PRIVATE_REGISTERED_584', 'OTHER_TURN_584', 'PRIVATE_CODEX_584', 'AGENT_CONTEXT_584']) {
    assert.ok(input.includes(sent), `${sent} is in the model input`);
  }
  const body = w.body();
  const everything = JSON.stringify(w.calls) + body;
  for (const held of ['PRIVATE_UNREGISTERED_584', 'PRIVATE_SIBLING_584', 'PRIVATE_SUBAGENT_584', 'PRIVATE_HEADLESS_584', 'PRIVATE_META_584', 'PRIVATE_SIDECHAIN_584', 'PRIVATE_CODEX_CONTEXT_584', 'PRIVATE_CODEX_RULES_584', 'PRIVATE_CODEX_SUBAGENT_584', 'PRIVATE_CODEX_UNREGISTERED_584']) {
    assert.ok(!everything.includes(held), `${held} is in no call and not in the issue`);
  }
  const [model] = w.calls.filter((call) => call.program === 'claude');
  assert.deepEqual(model.args.slice(0, 13), MODEL_ARGS);
  assert.deepEqual([model.args[13], typeof JSON.parse(model.args[14]), model.args[15], typeof model.args[16], model.args.length], ['--json-schema', 'object', '--system-prompt', 'string', 17]);
  assert.ok(!JSON.stringify(model.args).includes('_584'), 'no chat is in the model call\'s arguments');

  // Nothing else runs but git reading each registered folder's origin, and every gh call names the own repository.
  assert.deepEqual([...new Set(w.calls.map((call) => call.program))].sort(), ['claude', 'gh', 'git']);
  assert.deepEqual(w.calls.filter((call) => call.program === 'git').map((call) => [call.args.join(' '), call.cwd]).sort(), [
    ['remote get-url origin', w.folder('other')],
    ['remote get-url origin', own],
  ].sort());
  const gh = ghCalls(w);
  assert.ok(!JSON.stringify(gh.map((call) => call.args)).includes('other-repo'), 'no gh call names the other project');
  for (const { args } of gh) {
    if (args.includes('--repo')) assert.equal(args[args.indexOf('--repo') + 1], OWN);
    if (args[1].startsWith('repos/')) assert.ok(args[1].startsWith(`repos/${OWN}/`));
    assert.ok(!JSON.stringify(args).includes('_584'), 'no chat is in a gh call\'s arguments');
  }
  assert.deepEqual(w.created.map((issue) => [issue.repo, issue.title]), [[OWN, TITLE]]);
  assert.deepEqual(w.created[0].args.slice(-2), ['--label', 'task']);
  assert.deepEqual(w.writes, ['add 50', 'Status=Backlog 50', 'Workstream=Product 50']);

  // In the issue the chat stands only inside a quote, and no quote or model sentence pings, cross-references, draws an
  // image, links, holds raw HTML or forms a heading a card's scope is read from.
  for (const [marker, source] of [['PRIVATE_REGISTERED_584', 'example-repo, Claude Code, 10 November, your words'], ['PRIVATE_CODEX_584', 'example-repo, Codex, 10 November, your words']]) {
    const holding = body.split('\n').filter((line) => line.includes(marker));
    assert.ok(holding.length > 0 && holding.every((line) => line.startsWith('> ')), `${marker} stands only in a quote`);
    assert.ok(body.includes(`\n${source}\n`), `the quote's source line reads "${source}"`);
  }
  assert.ok(!body.includes('@'), 'the issue names no account');
  assert.ok(!/#\d/.test(body) && !/GH-\d/i.test(body) && !/\/(?:issues|pull)\/\d/.test(body), 'the issue cross-references nothing');
  assert.ok(!body.includes('!['), 'the issue draws no image');
  assert.ok(!body.includes(']('), 'the issue forms no link');
  assert.ok(!body.includes(LONG_TOKEN), 'the issue holds no long unbroken token');
  assert.ok(!/https?:|www\.|example\.com/.test(body), 'the issue holds no web address');
  assert.ok(!body.includes('<'), 'the issue holds no raw HTML');
  assert.ok(!/^## (What to build|Acceptance criteria)/m.test(body), 'the issue has no heading a card\'s scope is read from');
  assert.equal(entries(part(body, 'Proposals')).length, 1);
  assert.equal(entries(part(body, 'Where I think you were wrong')).length, 1);

  // The one card draft waits in the block, escaped, for the other project; nothing of it was filed there.
  assert.ok(!/[`<>@#]/.test(block(body)), 'the block escapes every backtick, angle bracket, at sign and hash');
  assert.deepEqual(drafts(body), {
    format: 1, week: '2026-11-09',
    proposals: [{
      n: 1, repository: OTHER, title: 'Use tabs in the other project', problem: 'The weekly summary runs long.',
      build: 'Use `tabs` in <config> files.', criteria: ['The summary has five lines at most.'], kind: 'task', label: 'chore', workstream: 'Alpha',
    }],
  });

  // The job wrote nothing under the Herdr home, the owner's home or a project.
  assert.deepEqual(tree(w.root), before);
});

test('ANTI-REGRESSION: a retro card draft that quotes chat or holds a private fact is never offered', async (t) => {
  const w = world(t);
  const own = w.folder('own');
  w.claude('own/session.jsonl', [
    said(own, 'Keep the weekly summary short and plain'),
    said(own, 'we should never ever deploy on a friday afternoon again please remember that'),
  ]);
  const titles = ['Shorten the weekly summary', 'Stop the friday deploys', 'Link the cause', 'Ask the right person', 'Refresh the stale notes', 'Rotate the old token', 'Fix the "weekly" summary', 'Read the client notes', 'Open the bracketed notes'];
  w.model = (input) => {
    const evidence = [quoted(input, 'Keep the weekly summary short and plain')];
    const proposal = (draft, index) => ({ repository: OWN, summary: `Idea ${index + 1}`, evidence, card: draft });
    return reply({
      proposals: [
        card(titles[0]),
        card(titles[1], { build: 'Add a rule that we should never ever deploy on a Friday afternoon.' }),
        card(titles[2], { problem: 'See https://example.com/secret for the cause.' }),
        card(titles[3], { build: 'Ask someone@example.com about it.' }),
        card(titles[4], { criteria: ['The file /home/someone/notes.md is fresh.'] }),
        card(titles[5], { build: `Replace ${TOKEN} everywhere.` }),
        card(titles[6]),
        card(titles[7], { build: 'Read `/srv/alpha/notes.md` before deployment.' }),
        card(titles[8], { problem: 'The file [/opt/beta/notes.md] is stale.' }),
      ].map(proposal),
    });
  };

  assert.equal((await w.retro()).code, 0);

  const body = w.body();
  assert.deepEqual(drafts(body).proposals, [{
    n: 1, repository: OWN, title: titles[0], problem: 'The weekly summary runs long.', build: 'Cut the summary to five lines.',
    criteria: ['The summary has five lines at most.'], kind: 'task', label: 'task', workstream: 'Product',
  }]);
  const proposals = entries(part(body, 'Proposals'));
  assert.equal(proposals.length, 9);
  assert.ok(!proposals[0].includes('No card offered'), 'the clean draft is offered');
  for (const [index, entry] of proposals.slice(1).entries()) {
    assert.ok(entry.includes('\nNo card offered: '), `proposal ${index + 2} keeps its place with no card offered`);
  }
  for (const held of ['never ever deploy', 'https://example.com/secret', 'someone@example.com', '/home/someone', TOKEN, '"weekly"', '/srv/alpha', '/opt/beta']) {
    assert.ok(!body.includes(held), `"${held}" of a refused draft is nowhere in the issue`);
  }
});

test('ANTI-REGRESSION: a retro card draft holding a link, a card address or a long token is never offered', async (t) => {
  const w = world(t);
  w.claude('own/session.jsonl', [said(w.folder('own'), 'Keep the weekly summary short and plain')]);
  const refused = [
    ['Follow the old run', { problem: 'See the run at //ci.example.com/run/42 first.' }, '//ci.example.com'],
    ['Open the linked page', { build: 'Read [the page](notes.md) first.' }, 'notes.md'],
    ['Open the named page', { build: 'Read [the page][notes] first.' }, '[notes]'],
    ['Define the named page', { build: 'Read the page first.\n\n[page]: notes.md' }, '[page]:'],
    ['Read the plain address', { build: 'Read https:beta.invalid/x first.' }, 'beta.invalid'],
    ['Compare the other change', { problem: 'Compare acme/widgets/pull/7 with this.' }, 'acme/widgets'],
    ['Swap the stored key', { criteria: [`The key ${LONG_TOKEN} is gone.`] }, LONG_TOKEN],
  ];
  w.model = (input) => {
    const evidence = [quoted(input, 'Keep the weekly summary short and plain')];
    return reply({
      proposals: [card('Shorten the weekly summary'), ...refused.map(([title, more]) => card(title, more))]
        .map((draft, index) => ({ repository: OWN, summary: `Idea ${index + 1}`, evidence, card: draft })),
    });
  };

  assert.equal((await w.retro()).code, 0);

  const body = w.body();
  assert.deepEqual(drafts(body).proposals.map(({ n }) => n), [1]);
  for (const [index, [, , held]] of refused.entries()) {
    assert.ok(entries(part(body, 'Proposals'))[index + 1].includes('\nNo card offered: '), `proposal ${index + 2} is offered no card`);
    assert.ok(!body.includes(held), `"${held}" of a refused draft is nowhere in the issue`);
  }
});

test('the weekly retro reads the last whole week of owner turns from registered projects', async (t) => {
  const w = world(t);
  const own = w.folder('own');
  const twice = said(own, 'CLAUDE_TWICE_584');
  w.claude('own/a.jsonl', [
    said(own, 'CLAUDE_BEFORE_584', '2026-11-08T23:59:59.999Z'),
    said(own, 'CLAUDE_FIRST_584', '2026-11-09T00:00:00.000Z'),
    said(own, 'CLAUDE_LAST_584', '2026-11-15T23:59:59.999Z'),
    said(own, 'CLAUDE_AFTER_584', '2026-11-16T00:00:00.000Z'),
    said(join(own, '.claude', 'worktrees', 'job-1'), 'CLAUDE_NESTED_584'),
    said(own, [{ type: 'text', text: 'CLAUDE_PARTS_584' }, { type: 'image', source: {} }]),
    twice,
  ]);
  w.claude('own/b.jsonl', [twice]);
  w.codex('rollout-a.jsonl', [
    codexMeta(own),
    codexSaid('CODEX_BEFORE_584', '2026-11-08T23:59:59.999Z'),
    codexSaid('CODEX_FIRST_584', '2026-11-09T00:00:00.000Z'),
    codexSaid('CODEX_LAST_584', '2026-11-15T23:59:59.999Z'),
    codexSaid('CODEX_AFTER_584', '2026-11-16T00:00:00.000Z'),
    codexSaid('<button>Save</button> is still CODEX_MARKUP_584'),
  ]);
  w.codex('rollout-b.jsonl', [
    codexMeta(w.folder('stray'), { source: 'vscode', git: { repository_url: `https://github.com/${OTHER}` } }),
    codexSaid('CODEX_BY_ADDRESS_584'),
  ]);

  assert.equal((await w.retro()).code, 0);

  const input = w.input();
  for (const inside of ['CLAUDE_FIRST_584', 'CLAUDE_LAST_584', 'CLAUDE_NESTED_584', 'CLAUDE_PARTS_584', 'CODEX_FIRST_584', 'CODEX_LAST_584', 'CODEX_BY_ADDRESS_584', 'CODEX_MARKUP_584']) {
    assert.ok(input.includes(inside), `${inside} is in the model input`);
  }
  for (const outside of ['CLAUDE_BEFORE_584', 'CLAUDE_AFTER_584', 'CODEX_BEFORE_584', 'CODEX_AFTER_584']) {
    assert.ok(!input.includes(outside), `${outside} is outside the week`);
  }
  assert.equal(count(input, 'CLAUDE_TWICE_584'), 1, 'a turn two files hold is sent once');
  assert.equal(w.created[0].title, TITLE);

  // The week is the last whole one before the clock, Monday to Monday in UTC.
  for (const [clock, week] of [['2026-11-16T00:00:00.000Z', '2026-11-09'], ['2026-11-22T23:59:59.999Z', '2026-11-09'], ['2026-11-23T00:00:00.000Z', '2026-11-16']]) {
    const later = world(t);
    assert.equal((await later.retro(undefined, Date.parse(clock))).code, 0);
    assert.equal(later.created[0].title, `Proposed: Weekly retro for the week of ${week}`, `the week at ${clock}`);
  }
});

test('the weekly retro reads history from the folders the runtimes are configured with', async (t) => {
  const w = world(t);
  const own = w.folder('own');
  const claudeFolder = join(w.root, 'elsewhere', 'claude');
  const codexFolder = join(w.root, 'elsewhere', 'codex');
  jsonl(join(claudeFolder, 'projects', 'own', 'a.jsonl'), [said(own, 'CLAUDE_CONFIGURED_584')]);
  jsonl(join(codexFolder, 'sessions', '2026', '11', '10', 'rollout-a.jsonl'), [codexMeta(own), codexAnswered('Codex agent text'), codexSaid('CODEX_CONFIGURED_584')]);
  w.claude('own/a.jsonl', [said(own, 'CLAUDE_DEFAULT_584')]);
  w.codex('rollout-a.jsonl', [codexMeta(own), codexSaid('CODEX_DEFAULT_584')]);

  assert.equal((await w.retro(undefined, NOW, { CLAUDE_CONFIG_DIR: claudeFolder, CODEX_HOME: codexFolder })).code, 0);

  const input = w.input();
  assert.ok(input.includes('CLAUDE_CONFIGURED_584') && input.includes('CODEX_CONFIGURED_584'));
  assert.ok(!input.includes('CLAUDE_DEFAULT_584') && !input.includes('CODEX_DEFAULT_584'));
});

test('the weekly retro says how many history lines it could not read', async (t) => {
  const w = world(t);
  const own = w.folder('own');
  const raw = (file, lines) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n\n`);
  };
  raw(join(w.userHome, '.claude', 'projects', 'own', 'a.jsonl'), ['{"type":"user","mess', 'null', said(own, 'CLAUDE_AFTER_BROKEN_584')]);
  raw(join(w.userHome, '.codex', 'sessions', '2026', '11', '10', 'rollout-a.jsonl'), ['not a record', 'false', '0', '[]', codexMeta(own), codexSaid('CODEX_AFTER_BROKEN_584')]);

  assert.equal((await w.retro()).code, 0);

  const input = w.input();
  assert.ok(input.includes('CLAUDE_AFTER_BROKEN_584') && input.includes('CODEX_AFTER_BROKEN_584'), 'the readable turns of both files reach the model');
  assert.deepEqual(part(w.body(), 'Left out').trim().split('\n'), ['- History lines that could not be read: 6']);
});

test('the weekly retro files one issue for every week, an empty one included', async (t) => {
  const quiet = world(t);
  assert.deepEqual(await quiet.retro(), { code: 0, out: [`https://github.com/${OWN}/issues/50`], err: [] });
  assert.deepEqual(quiet.inputs(), [], 'a week with no chat calls no model');
  assert.equal(part(quiet.body(), 'Proposals').trim(), 'None this week.');
  assert.equal(part(quiet.body(), 'Where I think you were wrong').trim(), 'None this week.');
  assert.equal(part(quiet.body(), 'Left out').trim(), '- No chats from registered projects this week.');
  assert.deepEqual(drafts(quiet.body()), { format: 1, week: '2026-11-09', proposals: [] });

  const dropped = world(t);
  dropped.claude('own/a.jsonl', [said(dropped.folder('own'), 'Keep the weekly summary short and plain')]);
  dropped.model = (input) => {
    const evidence = [quoted(input, 'Keep the weekly summary short and plain')];
    const invented = [{ turn: evidence[0].turn, quote: 'I never typed these words' }];
    return reply({
      proposals: [
        { repository: OWN, summary: 'Rests on an invented quote', evidence: invented },
        { repository: 'example-owner/nowhere', summary: 'Names a project that is not registered', evidence },
        { repository: OWN, evidence },
        { repository: OWN, summary: 'x'.repeat(501), evidence },
      ],
      wrong: [
        { claim: 'Rests on an invented quote', why: 'Nothing backs it.', evidence: invented },
        { claim: 'y'.repeat(301), why: 'Too long to keep.', evidence },
      ],
    });
  };
  assert.equal((await dropped.retro()).code, 0);
  assert.equal(dropped.inputs().length, 1);
  const body = dropped.body();
  assert.equal(part(body, 'Proposals').trim(), 'None this week.');
  assert.equal(part(body, 'Where I think you were wrong').trim(), 'None this week.');
  assert.deepEqual(part(body, 'Left out').trim().split('\n').sort(), [
    '- Entries dropped because no quote was found in the turn they name: 2',
    '- Entries dropped because they were malformed: 3',
    '- Proposals dropped because their project is not registered: 1',
  ]);
  assert.deepEqual(drafts(body).proposals, []);
});

test('the weekly retro files nothing twice', async (t) => {
  const reading = (w) => w.claude('own/a.jsonl', [said(w.folder('own'), 'Something to read')]);
  const filed = { code: 0, out: [`already filed: https://github.com/${OWN}/issues/41`], err: [] };

  // The week's issue exists and is not on the board: it is placed, and no chat is read.
  const unplaced = world(t);
  reading(unplaced);
  unplaced.issues.push(existing(44), existing(41));
  assert.deepEqual(await unplaced.retro(), filed);
  assert.deepEqual(unplaced.reads, [], 'no history is read');
  assert.deepEqual(unplaced.inputs(), [], 'no model is called');
  assert.deepEqual(unplaced.created, []);
  assert.deepEqual(unplaced.writes, ['add 41', 'Status=Backlog 41', 'Workstream=Product 41']);
  assert.deepEqual(listings(unplaced), [['api', `repos/${OWN}/issues?creator=example-owner&state=all&since=2026-11-16T00:00:00Z&per_page=100`, '--paginate', '--slurp']]);

  // The owner has since closed it, or moved it: what the card has stays.
  for (const [values, writes] of /** @type {[Record<string, string | null>, string[]][]} */ ([
    [{ Status: 'Done', Workstream: 'Platform' }, []],
    [{ Status: 'Ready', Workstream: null }, ['Workstream=Product 41']],
    [{ Status: null, Workstream: 'Platform' }, ['Status=Backlog 41']],
  ])) {
    const placed = world(t);
    reading(placed);
    placed.issues.push(existing(41));
    placed.board.set(41, { ...values });
    assert.deepEqual(await placed.retro(), filed);
    assert.deepEqual(placed.writes, writes, `a card holding ${JSON.stringify(values)}`);
    assert.deepEqual([placed.reads, placed.created], [[], []]);
  }

  // Another run filed the same week between this run's look and its create: this run closes its own and uses the twin.
  const raced = world(t);
  reading(raced);
  raced.issues.push(existing(7, { pull_request: {} }), existing(8, { title: `${TITLE} again` }));
  raced.afterCreate = () => raced.issues.push(existing(49));
  assert.deepEqual(await raced.retro(), { code: 0, out: [`https://github.com/${OWN}/issues/49`], err: [] });
  assert.equal(raced.created.length, 1);
  assert.deepEqual(raced.closed, [['issue', 'close', '50', '--repo', OWN, '--reason', 'not planned']]);
  assert.deepEqual(raced.writes, ['add 49', 'Status=Backlog 49', 'Workstream=Product 49']);
});

test('the weekly retro files nothing when the model fails', async (t) => {
  const result = { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { proposals: [], wrong: [] } };
  for (const [name, model] of /** @type {[string, () => string][]} */ ([
    ['a non-zero exit', () => { throw new Error('claude exited 1'); }],
    ['a reply that is not JSON', () => 'Sorry, I cannot do that.'],
    ['a reply that is not the result', () => JSON.stringify({ ...result, type: 'assistant' })],
    ['an error result', () => JSON.stringify({ ...result, is_error: true })],
    ['a result with no structured output', () => JSON.stringify({ ...result, structured_output: undefined })],
    ['a structured output of another shape', () => JSON.stringify({ ...result, structured_output: { proposals: 'none' } })],
  ])) {
    const w = world(t);
    w.claude('own/a.jsonl', [said(w.folder('own'), 'Something to read')]);
    w.model = model;
    const { code, out, err } = await w.retro();
    assert.deepEqual([code, out, err.length], [1, [], 1], name);
    assert.match(err[0], /^local-retro: /, name);
    assert.deepEqual([w.created, w.writes], [[], []], name);
  }
});

test('the weekly retro keeps only evidence quoted from the turn it names', async (t) => {
  const w = world(t);
  const own = w.folder('own');
  w.claude('own/a.jsonl', [
    answered(own, 'I skipped the linter this time to save a minute.'),
    said(own, 'Always run the linter before you commit anything'),
    said(own, 'The deploy script is too slow for me'),
  ]);
  w.model = (input) => {
    const linter = tagOf(input, 'Always run the linter');
    const deploy = tagOf(input, 'The deploy script');
    return reply({
      proposals: [
        { repository: OWN, summary: 'Rests on words from another turn and on invented ones', evidence: [{ turn: linter, quote: 'The deploy script is too slow' }, { turn: linter, quote: 'I love the linter so much' }] },
        {
          repository: OWN, summary: 'Rests on words the turn holds',
          evidence: [{ turn: linter, quote: 'run the   linter\nbefore you commit' }, { turn: deploy, quote: 'never said this' }, { turn: linter, quote: 'I skipped the linter this time' }],
        },
      ],
      wrong: [{ claim: 'Names a turn that does not exist', why: 'Nothing backs it.', evidence: [{ turn: 'T999', quote: 'Always run the linter' }] }],
    });
  };

  assert.equal((await w.retro()).code, 0);

  const body = w.body();
  const proposals = entries(part(body, 'Proposals'));
  assert.equal(proposals.length, 1);
  assert.ok(proposals[0].startsWith(`Proposal 1 for ${OWN}\n`) && proposals[0].includes('Rests on words the turn holds'));
  assert.deepEqual(quoteLines(proposals[0]), ['> run the linter before you commit', '> I skipped the linter this time']);
  assert.ok(proposals[0].includes('\nexample-repo, Claude Code, 10 November, your words\n'));
  assert.ok(proposals[0].includes('\nexample-repo, Claude Code, 10 November, the agent\'s words\n'));
  for (const invented of ['The deploy script', 'I love the linter', 'never said this', 'another turn']) {
    assert.ok(!body.includes(invented), `"${invented}" is not in the issue`);
  }
  assert.equal(part(body, 'Where I think you were wrong').trim(), 'None this week.');
  assert.equal(part(body, 'Left out').trim(), '- Entries dropped because no quote was found in the turn they name: 2');
});

test('the weekly retro keeps a quote once however often it is cited', async (t) => {
  const w = world(t);
  const own = w.folder('own');
  w.claude('own/a.jsonl', [said(own, 'First time: run the linter before you commit')]);
  w.claude('own/b.jsonl', [said(own, 'Second time: run the linter before you commit, I said')]);
  w.model = (input) => {
    const first = tagOf(input, 'First time');
    const second = tagOf(input, 'Second time');
    return reply({
      proposals: [{
        repository: OWN, summary: 'Rests on the same words three times',
        evidence: [{ turn: first, quote: 'run the linter' }, { turn: first, quote: 'run the  linter' }, { turn: second, quote: 'run the linter' }, { turn: second, quote: 'I said' }],
      }],
    });
  };

  assert.equal((await w.retro()).code, 0);

  assert.deepEqual(quoteLines(entries(part(w.body(), 'Proposals'))[0]), ['> run the linter', '> I said']);
});

test('the weekly retro splits a long week between turns into several model calls', async (t) => {
  const w = world(t);
  const own = w.folder('own');
  const marker = (index) => `TURN_${String(index).padStart(3, '0')}_`;
  const turns = Array.from({ length: 130 }, (unused, index) => said(own, marker(index) + 'x'.repeat(4000 - marker(index).length), new Date(Date.parse(IN_WEEK) + index * 60_000).toISOString()));
  w.claude('own/a.jsonl', turns);

  assert.equal((await w.retro()).code, 0);

  const inputs = w.inputs();
  assert.ok(inputs.length > 1, 'more than one model call');
  for (const input of inputs) assert.ok(input.length <= 500_000, `a model input of ${input.length} characters`);
  for (const index of turns.keys()) assert.equal(count(inputs.join('\n'), marker(index)), 1, `turn ${index} is in exactly one model input`);
  assert.equal(w.created.length, 1);
});

test('the weekly retro keeps its stated limits', async (t) => {
  // The owner's text is cut at its first 4,000 characters and the agent's at its last 1,000; an entry keeps three
  // quotes, each of 300 characters at most.
  const cut = world(t);
  const own = cut.folder('own');
  cut.claude('own/a.jsonl', [
    answered(own, `${'P'.repeat(500)}Q${'r'.repeat(999)}`),
    said(own, `${'k'.repeat(3999)}L${'M'.repeat(500)}`),
    said(own, 'alpha one. bravo two. charlie three. delta four. echo five.'),
    said(own, `${'q'.repeat(301)} short tail here`),
  ]);
  cut.model = (input) => reply({
    proposals: [
      { repository: OWN, summary: 'Five quotes', evidence: ['alpha one', 'bravo two', 'charlie three', 'delta four', 'echo five'].map((quote) => quoted(input, 'alpha one.', quote)) },
      { repository: OWN, summary: 'One quote too long', evidence: [quoted(input, 'short tail here', 'q'.repeat(301)), quoted(input, 'short tail here')] },
      { repository: OWN, summary: 'One quote at the limit', evidence: [quoted(input, 'short tail here', 'q'.repeat(300))] },
    ],
  });
  assert.equal((await cut.retro()).code, 0);
  const input = cut.input();
  assert.ok(input.includes(`${'k'.repeat(3999)}L`) && !input.includes('LM'), 'the owner\'s text is cut after 4,000 characters');
  assert.ok(input.includes(`Q${'r'.repeat(999)}`) && !input.includes('PQ'), 'the agent\'s text is its last 1,000 characters');
  const kept = entries(part(cut.body(), 'Proposals'));
  assert.deepEqual(kept.map(quoteLines), [['> alpha one', '> bravo two', '> charlie three'], ['> short tail here'], [`> ${'q'.repeat(300)}`]]);

  // Ten entries a section, the first ten; the rest are counted.
  const many = world(t);
  many.claude('own/a.jsonl', [said(many.folder('own'), 'Keep the weekly summary short and plain')]);
  many.model = (text) => {
    const evidence = [quoted(text, 'Keep the weekly summary short and plain')];
    const numbers = Array.from({ length: 12 }, (unused, index) => String(index + 1).padStart(2, '0'));
    return reply({
      proposals: numbers.map((number) => ({ repository: OWN, summary: `Idea ${number}`, evidence })),
      wrong: numbers.map((number) => ({ claim: `Claim ${number}`, why: 'It clashes.', evidence })),
    });
  };
  assert.equal((await many.retro()).code, 0);
  const full = many.body();
  assert.equal(entries(part(full, 'Proposals')).length, 10);
  assert.equal(entries(part(full, 'Where I think you were wrong')).length, 10);
  assert.ok(full.includes('Idea 10') && !full.includes('Idea 11') && full.includes('Claim 10') && !full.includes('Claim 11'));
  assert.equal(part(full, 'Left out').trim(), '- Entries dropped over the limit of ten a section: 4');

  // A body past 65,000 characters loses trailing entries, drafts with them, and counts them.
  const long = world(t);
  long.claude('own/a.jsonl', [said(long.folder('own'), 'Keep the weekly summary short and plain')]);
  long.model = (text) => reply({
    proposals: [...'ABCDEFGHIJ'].map((letter) => ({
      repository: OWN, summary: `Idea ${letter}`, evidence: [quoted(text, 'Keep the weekly summary short and plain')],
      card: card(`Body cap draft ${letter}`, { problem: '<'.repeat(600), build: '<'.repeat(1000) }),
    })),
  });
  assert.equal((await long.retro()).code, 0);
  const capped = long.body();
  assert.ok(capped.length <= 65_000, `a body of ${capped.length} characters`);
  const lost = Number(/^- Entries dropped to fit the issue: (\d+)$/m.exec(part(capped, 'Left out'))?.[1]);
  assert.ok(lost >= 1 && lost <= 9, `${lost} entries were dropped to fit`);
  assert.equal(entries(part(capped, 'Proposals')).length, 10 - lost);
  assert.deepEqual(drafts(capped).proposals.map((draft) => draft.title), [...'ABCDEFGHIJ'].slice(0, 10 - lost).map((letter) => `Body cap draft ${letter}`));
});

test('the weekly retro refuses a malformed command line before any read', async (t) => {
  const w = world(t);
  for (const args of [
    ['--home', w.home, '--workstream', 'Product', '--dry-run'],
    ['--workstream', 'Product'],
    ['--home', w.home, '--workstream', 'Nope'],
    ['--home', w.home, '--workstream', 'Product', 'extra'],
  ]) {
    assert.deepEqual(await w.retro(args), { code: 2, out: [], err: [USAGE] }, args.join(' '));
  }
  assert.deepEqual([w.calls, w.reads], [[], []]);
});

test('the weekly retro stops on a missing or malformed machine record', async (t) => {
  for (const damage of [(w) => rmSync(w.record), (w) => writeFileSync(w.record, '{"format":1,"repositories":"none"}'), (w) => writeFileSync(w.record, 'not JSON')]) {
    const w = world(t);
    w.claude('own/a.jsonl', [said(w.folder('own'), 'Something to read')]);
    damage(w);
    const { code, out, err } = await w.retro();
    assert.deepEqual([code, out, err.length], [1, [], 1]);
    assert.ok(err[0].startsWith('local-retro: ') && err[0].includes(w.record), 'the refusal names the record');
    assert.deepEqual([w.reads, w.created], [[], []]);
  }
});

test('the weekly retro refuses a repository whose cards are not GitHub issues', async (t) => {
  const w = world(t, { kit: linear });
  w.claude('own/a.jsonl', [said(w.folder('own'), 'Something to read')]);
  const { code, out, err } = await w.retro(['--home', w.home]);
  assert.deepEqual([code, out, err.length], [1, [], 1]);
  assert.match(err[0], /^local-retro: .*GitHub/);
  assert.deepEqual([w.calls, w.reads], [[], []]);
});

test('the weekly retro offers no card for a project whose cards are not GitHub issues', async (t) => {
  const w = world(t, { registered: ['own', 'other', 'tracked', 'unread', 'typed', 'mirror'] });
  const slug = (name) => `example-owner/${name}-repo`;
  Object.assign(w.origins, {
    [w.folder('tracked')]: `https://github.com/${slug('tracked')}.git`,
    [w.folder('unread')]: `https://github.com/${slug('unread')}.git`,
    [w.folder('typed')]: `https://github.com/${slug('typed')}`,
    [w.folder('mirror')]: 'https://gitlab.com/example-owner/mirror-repo.git',
  });
  Object.assign(w.configs, {
    [w.folder('tracked')]: { ...OTHER_CONFIG, BOARD_REPOSITORY: 'tracked-repo', TRACKER: 'linear' },
    [w.folder('typed')]: {
      BOARD_OWNER: 'example-owner', BOARD_OWNER_TYPE: 'organization', BOARD_REPOSITORY: 'typed-repo', KIND_LABELS: OTHER_CONFIG.KIND_LABELS,
      KIND_TYPES: { epic: 'Epic', feature: 'Feature', task: 'Task', bug: 'Bug', docs: 'Documentation' }, ROUTING_FIELD: null, ROUTING_OPTIONS: [],
    },
  });
  w.claude('own/a.jsonl', [said(w.folder('own'), 'Tidy every project board this week')]);
  w.claude('mirror/a.jsonl', [said(w.folder('mirror'), 'MIRROR_TURN_584')]);
  const offers = [
    [slug('tracked'), card('Tidy the tracked board', { workstream: 'Alpha' })],
    [slug('unread'), card('Tidy the unread board', { workstream: 'Alpha' })],
    [OTHER, card('Tidy the other board badly', { workstream: 'Gamma' })],
    [OTHER, card('Tidy the other board by kind', { kind: 'epic', workstream: 'Alpha' })],
    [OTHER, card('Tidy the other board', { workstream: 'Alpha' })],
    [slug('typed'), card('Tidy the typed board', { workstream: undefined })],
    [slug('typed'), card('Tidy the typed board again', { workstream: 'Alpha' })],
    [OTHER, card('Tidy the other board unrouted', { workstream: undefined })],
  ];
  w.model = (input) => reply({
    proposals: offers.map(([repository, draft], index) => ({ repository, summary: `Idea ${index + 1}`, evidence: [quoted(input, 'Tidy every project board this week')], card: draft })),
  });

  assert.equal((await w.retro()).code, 0);

  assert.ok(!w.input().includes('MIRROR_TURN_584'), 'a project with no GitHub origin is not read');
  const body = w.body();
  const text = { problem: 'The weekly summary runs long.', build: 'Cut the summary to five lines.', criteria: ['The summary has five lines at most.'], kind: 'task' };
  assert.deepEqual(drafts(body).proposals, [
    { n: 5, repository: OTHER, title: 'Tidy the other board', ...text, label: 'chore', workstream: 'Alpha' },
    { n: 6, repository: slug('typed'), title: 'Tidy the typed board', ...text, type: 'Task' },
  ]);
  const proposals = entries(part(body, 'Proposals'));
  assert.deepEqual(proposals.map((entry) => entry.split('\n', 1)[0]), offers.map(([repository], index) => `Proposal ${index + 1} for ${repository}`));
  assert.deepEqual(proposals.map((entry) => entry.includes('\nNo card offered: ')), [true, true, true, true, false, false, true, true]);
  assert.equal(part(body, 'Left out').trim(), '- Project not read because its origin is not a GitHub address: mirror');
});

test('the weekly retro offers one card for each title in a project', async (t) => {
  const w = world(t);
  w.claude('own/a.jsonl', [said(w.folder('own'), 'Keep the weekly summary short and plain')]);
  w.model = (input) => reply({
    proposals: [
      [OWN, card('Shorten the weekly summary')],
      [OWN, card('shorten the weekly summary')],
      [OTHER, card('Shorten the weekly summary', { workstream: 'Beta' })],
    ].map(([repository, draft], index) => ({ repository, summary: `Idea ${index + 1}`, evidence: [quoted(input, 'Keep the weekly summary short and plain')], card: draft })),
  });

  assert.equal((await w.retro()).code, 0);

  assert.deepEqual(drafts(w.body()).proposals.map((draft) => [draft.n, draft.repository]), [[1, OWN], [3, OTHER]]);
  assert.deepEqual(entries(part(w.body(), 'Proposals')).map((entry) => entry.includes('\nNo card offered: ')), [false, true, false]);
});

test('the weekly retro runs on a board with no routing field', async (t) => {
  const refused = world(t, { kit: unrouted });
  assert.deepEqual(await refused.retro(['--home', refused.home, '--workstream', 'Product']), { code: 2, out: [], err: [USAGE] });
  assert.deepEqual([refused.calls, refused.reads], [[], []]);

  const filed = world(t, { kit: unrouted });
  filed.claude('own/a.jsonl', [said(filed.folder('own'), 'Keep the weekly summary short and plain')]);
  filed.model = (input) => reply({
    proposals: [card('Shorten the weekly summary', { workstream: undefined }), card('Shorten the weekly summary again')]
      .map((draft, index) => ({ repository: OWN, summary: `Idea ${index + 1}`, evidence: [quoted(input, 'Keep the weekly summary short and plain')], card: draft })),
  });
  assert.deepEqual(await filed.retro(['--home', filed.home]), { code: 0, out: [`https://github.com/${OWN}/issues/50`], err: [] });
  assert.deepEqual(filed.writes, ['add 50', 'Status=Backlog 50']);
  assert.deepEqual(drafts(filed.body()).proposals, [{
    n: 1, repository: OWN, title: 'Shorten the weekly summary', problem: 'The weekly summary runs long.', build: 'Cut the summary to five lines.',
    criteria: ['The summary has five lines at most.'], kind: 'task', label: 'task',
  }]);

  const unnamed = world(t);
  assert.deepEqual(await unnamed.retro(['--home', unnamed.home]), { code: 2, out: [], err: [USAGE] });
  assert.deepEqual([unnamed.calls, unnamed.reads], [[], []]);
});

// A fake `gh` for the command spawned whole: the login, the listing of the own repository's issues, which holds issue 41
// titled for the week the listing's own `since` ends, and that issue's board item, in Done with a routing value. It
// records every call and refuses any other.
const WIRE_GH = String.raw`
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const call = args.join(' ');
appendFileSync(process.env.WIRE_CALLS, call + '\n');
const query = args.find((arg) => arg.startsWith('query=')) || '';
const since = /[?&]since=([^&]+)/.exec(args[1] || '');
let reply;
if (call === 'api user --jq .login') reply = 'example-owner\n';
else if (since && args[1].startsWith('repos/example-owner/example-repo/issues?')) {
  const week = new Date(Date.parse(since[1]) - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  reply = JSON.stringify([[{ number: 41, title: 'Proposed: Weekly retro for the week of ' + week, state: 'closed', html_url: 'https://github.com/example-owner/example-repo/issues/41' }]]);
} else if (query.includes('issue(number:41)')) {
  const name = query.includes('fieldValueByName(name: "Status")') ? 'Done' : 'Product';
  reply = JSON.stringify({ data: { repository: { issue: { id: 'I_41', projectItems: { totalCount: 1, nodes: [{ id: 'PVTI_41', isArchived: false, project: { number: 2, owner: { login: 'example-owner' } }, value: { name } }] } } } } });
}
if (reply === undefined) {
  process.stderr.write('fake gh: unexpected call ' + call);
  process.exitCode = 1;
} else process.stdout.write(reply);
`;

// The command spawned from the routed toolkit copy with the fake `gh`, a Herdr home registering one real git repository
// whose origin is the own repository, and an empty home folder, so no run of it can read a real chat history.
function wire(t) {
  const fake = installFakeGh('local-retro-wire-', WIRE_GH);
  t.after(() => fake.cleanup());
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'local-retro-wire-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const project = join(scratch, 'project');
  const user = join(scratch, 'user');
  const home = join(scratch, 'herdr');
  for (const made of [project, user, join(home, 'fabraik-queue')]) mkdirSync(made, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', `https://github.com/${OWN}.git`]]) {
    const done = spawnSync('git', args, { cwd: project, encoding: 'utf8', env: gitEnvironment() });
    assert.equal(done.status, 0, done.stderr);
  }
  writeFileSync(join(home, 'fabraik-queue', 'machine.json'), JSON.stringify({ format: 1, release: null, files: {}, repositories: [project] }));
  const calls = join(scratch, 'calls');
  const env = fake.env({ WIRE_CALLS: calls, HOME: user, USERPROFILE: user }, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
  return {
    home,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []),
    command: (...args) => spawnSync(process.execPath, [routed.command, ...args], { cwd: routed.root, encoding: 'utf8', timeout: 30_000, env }),
  };
}

test('the weekly retro command reports an already filed week through the real gh wire', (t) => {
  const { home, calls, command } = wire(t);
  const done = command('--home', home, '--workstream', 'Product');
  assert.deepEqual([done.status, done.stdout, done.stderr], [0, `already filed: https://github.com/${OWN}/issues/41\n`, '']);
  assert.equal(calls()[0], 'api user --jq .login');
  assert.ok(calls().some((call) => call.startsWith(`api repos/${OWN}/issues?creator=example-owner&state=all&since=`)), 'the week\'s issue is looked for');
  assert.ok(!calls().some((call) => call.startsWith('issue ') || call.startsWith('project ')), 'nothing is created, closed or moved');
});

test('the weekly retro command exits 2 on an unknown argument', (t) => {
  const { home, calls, command } = wire(t);
  const done = command('--home', home, '--workstream', 'Product', '--bogus');
  assert.deepEqual([done.status, done.stdout, done.stderr], [2, '', `${USAGE}\n`]);
  assert.deepEqual(calls(), []);
});
