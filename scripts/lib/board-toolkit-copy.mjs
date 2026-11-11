// Shared test support: a temporary copy of the board toolkit wired to a literal configuration.
//
// Another repository adopts the toolkit by copying exactly TOOLKIT_LIB and CLI_ENTRY_POINTS
// unchanged and editing only board-config.mjs. `copyToolkit` does exactly that into a temp
// directory, alongside the one fixture helper the tests need but no adopter ships, so a test
// loads fresh module instances wired to the configuration it names, never to this install's own
// board-config.mjs. An incomplete TOOLKIT_LIB fails a test at import, the same way it would fail
// a real adopter.
//
// `flagLiterals` reads a command's real source under scripts/, never a copy. It loads `eslint`
// only when it runs, from this install's own scripts/lib and not from a temp toolkit, so this
// module imports in a repository with no npm packages installed; a test that calls it carries
// NEEDS_PARSER and skips there. The source is read through a parser, as a rule about source must
// be (docs/TESTING-STRATEGY.md, section 2), so a flag spelt in a comment or a longer string is not
// mistaken for one the command accepts, while a flag spelt inside a regular expression counts.
//
// Recurring cost: a temporary toolkit copy and fresh module load per importing test file;
// the portability test copies once per test; one ESLint parse per `flagLiterals` call.
// Removal condition: retire it when the board toolkit is no longer copied into another
// repository and no shipped test needs a configuration of its own.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = fileURLToPath(new URL('.', import.meta.url));
const SCRIPTS = fileURLToPath(new URL('..', import.meta.url));
export const CLI_ENTRY_POINTS = ['board.mjs', 'board-add.mjs', 'board-move.mjs', 'board-claim.mjs', 'verify-issue-publish.mjs', 'linear-card.mjs', 'jira-card.mjs', 'azure-card.mjs'];

// The transitive closure of relative imports from the CLI entry points above. Copying
// exactly this set, no more, is the adoption contract itself: a file the toolkit no longer
// imports must fall out of here or an adopter carries dead weight neither test nor doc admits to.
export const TOOLKIT_LIB = [
  'board.mjs',
  'board-read.mjs',
  'board-rules.mjs',
  'board-markdown.mjs',
  'board-config.mjs',
  'board-add.mjs',
  'board-move.mjs',
  'board-claim.mjs',
  'issue-publish.mjs',
  'gh-exec.mjs',
  'cli-flags.mjs',
  'tracker.mjs',
  'board-linear.mjs',
  'linear-api.mjs',
  'linear-card.mjs',
  'azure-config.mjs',
  'azure-api.mjs',
  'board-azure.mjs',
  'azure-card.mjs',
  'jira-config.mjs',
  'jira-api.mjs',
  'board-jira.mjs',
  'jira-card.mjs',
  // The markdown reader's route to the repository and the cards folder.
  'posix-shell.mjs',
  'advance-approval.mjs',
  'factory-sync.mjs',
  'runtimes.mjs',
  'seat-settings.mjs',
  'check-agents.mjs',
];

// Not part of the toolkit an adopter ships: a test helper, copied only so it builds fixtures
// against the adopted board-config.mjs rather than this repository's own.
const TEST_SUPPORT_LIB = ['board-fixtures.mjs'];

// Written out literally, as an adopter would, so an export the real config gains that
// this copy lacks fails at import exactly as it would for them.
export const CONFIG_TAIL = `
export const STATUS_OPTIONS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
export const PICKABLE_STATUSES = ['Backlog', 'Ready'];
export const WAIT_STATUSES = ['Awaiting push'];
export const TERMINAL_STATUSES = ['Done'];
export const ROUTING_FIELD = 'Workstream';
export const ROUTING_OPTIONS = ['Go-to-market', 'Product', 'Platform'];
export const KIND_LABELS = { epic: 'epic', feature: 'enhancement', task: 'task', bug: 'bug', docs: 'documentation' };
export const PARKED_LANE = null;
`;

// The configuration every GitHub-backend test runs against: it has no TRACKER, so the GitHub
// path runs whatever the install's own tracker, project number or vocabulary.
export const GITHUB_TEST_CONFIG = `export const BOARD_OWNER = 'example-owner';
export const BOARD_OWNER_TYPE = 'user';
export const BOARD_PROJECT_NUMBER = 2;
export const BOARD_REPOSITORY = 'example-repo';
${CONFIG_TAIL}`;

// The configuration of an organisation-owned GitHub install that chooses native issue types: the
// same vocabulary, and the KIND_TYPES map that makes a card's kind its issue type.
export const GITHUB_KIND_TYPES_TEST_CONFIG = `export const BOARD_OWNER = 'acme-org';
export const BOARD_OWNER_TYPE = 'organization';
export const BOARD_PROJECT_NUMBER = 7;
export const BOARD_REPOSITORY = 'widgets';
${CONFIG_TAIL}export const KIND_TYPES = { epic: 'Epic', feature: 'Feature', task: 'Task', bug: 'Bug', docs: 'Documentation' };
`;

// The configuration of a markdown-tracked install: the same repository and vocabulary, no project
// (a markdown install has none) and the tracker switch the GitHub configurations leave out.
export const MARKDOWN_TEST_CONFIG = `export const BOARD_OWNER = 'example-owner';
export const BOARD_OWNER_TYPE = 'user';
export const BOARD_PROJECT_NUMBER = null;
export const BOARD_REPOSITORY = 'example-repo';
${CONFIG_TAIL}export const TRACKER = 'markdown';
`;

// The configuration of a Linear-tracked install: no project and no routing (a Linear install has
// neither), the tracker switch, the team and the starter state names. Its tail repeats CONFIG_TAIL
// with the routing lines a Linear install sets.
export const LINEAR_TEST_CONFIG = `export const BOARD_OWNER = 'example-owner';
export const BOARD_OWNER_TYPE = 'user';
export const BOARD_PROJECT_NUMBER = null;
export const BOARD_REPOSITORY = 'example-repo';
export const STATUS_OPTIONS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
export const PICKABLE_STATUSES = ['Backlog', 'Ready'];
export const WAIT_STATUSES = ['Awaiting push'];
export const TERMINAL_STATUSES = ['Done'];
export const ROUTING_FIELD = null;
export const ROUTING_OPTIONS = [];
export const KIND_LABELS = { epic: 'epic', feature: 'enhancement', task: 'task', bug: 'bug', docs: 'documentation' };
export const PARKED_LANE = null;
export const TRACKER = 'linear';
export const LINEAR_TEAM = 'ENG';
export const LINEAR_STATES = { 'Backlog': 'Backlog', 'Ready': 'Todo', 'In progress': 'In Progress', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', 'Done': 'Done' };
`;

// Jira configuration stays literal so tests do not derive their oracle from provider code.
export const JIRA_TEST_CONFIG = `export const BOARD_OWNER = 'example-owner';
export const BOARD_OWNER_TYPE = 'user';
export const BOARD_REPOSITORY = 'example-repo';
export const BOARD_PROJECT_NUMBER = null;
export const STATUS_OPTIONS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
export const PICKABLE_STATUSES = ['Backlog', 'Ready'];
export const WAIT_STATUSES = ['Awaiting push'];
export const TERMINAL_STATUSES = ['Done'];
export const ROUTING_FIELD = null;
export const ROUTING_OPTIONS = [];
export const KIND_LABELS = { epic: 'epic', feature: 'enhancement', task: 'task', bug: 'bug', docs: 'documentation' };
export const PARKED_LANE = null;
export const TRACKER = 'jira';
export const JIRA_CONFIG = { site: 'https://example.atlassian.net', project: 'ENG', states: { Backlog: '10', Ready: '11', 'In progress': '12', 'Awaiting push': '13', 'In review': '14', Done: '15' }, issueTypes: { epic: '10001', feature: '10002', task: '10002', bug: '10002', docs: '10002' }, blockLinkType: '10003' };
`;

// Azure mappings are literal so provider tests share customer configuration, not implementation-derived expectations.
export const AZURE_TEST_CONFIG = `export const BOARD_OWNER = 'example-owner';
export const BOARD_OWNER_TYPE = 'user';
export const BOARD_REPOSITORY = 'example-repo';
export const BOARD_PROJECT_NUMBER = null;
export const STATUS_OPTIONS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
export const PICKABLE_STATUSES = ['Backlog', 'Ready'];
export const WAIT_STATUSES = ['Awaiting push'];
export const TERMINAL_STATUSES = ['Done'];
export const ROUTING_FIELD = null;
export const ROUTING_OPTIONS = [];
export const KIND_LABELS = { epic: 'epic', feature: 'enhancement', task: 'task', bug: 'bug', docs: 'documentation' };
export const PARKED_LANE = null;
export const TRACKER = 'azure';
export const AZURE_CONFIG = {
  organization: 'example-org', project: '11111111-1111-4111-8111-111111111111',
  workItemTypes: { epic: 'Epic', feature: 'User Story', task: 'Task', bug: 'Bug', docs: 'Task' },
  states: {
    Epic: { Backlog: 'New', Ready: 'Ready', 'In progress': 'Active', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed' },
    'User Story': { Backlog: 'New', Ready: 'Ready', 'In progress': 'Active', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed' },
    Task: { Backlog: 'New', Ready: 'Ready', 'In progress': 'Active', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed' },
    Bug: { Backlog: 'New', Ready: 'Ready', 'In progress': 'Active', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed' },
  },
};
`;

// `root` is canonical: the CLI runs main() only when argv[1] resolves to its own module URL, and
// the temp directory can sit behind a symlink (macOS /var → /private/var).
export function copyToolkit(configSource) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-toolkit-')));
  const lib = join(root, 'scripts', 'lib');
  mkdirSync(lib, { recursive: true });
  for (const file of [...TOOLKIT_LIB, ...TEST_SUPPORT_LIB]) copyFileSync(join(LIB, file), join(lib, file));
  for (const file of CLI_ENTRY_POINTS) copyFileSync(join(SCRIPTS, file), join(root, 'scripts', file));
  writeFileSync(join(lib, 'board-config.mjs'), configSource);
  return {
    root,
    load: (path) => import(pathToFileURL(join(root, 'scripts', path)).href),
    script: (name) => join(root, 'scripts', name),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const FLAG = /^--[a-z][a-z-]*=?$/;
const REGEX_FLAG_TOKEN = /^--[a-z][a-z-]*=?/;

function eslintInstalled() {
  try {
    createRequire(import.meta.url).resolve('eslint');
    return true;
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return false;
  }
}
export const NEEDS_PARSER = { skip: !eslintInstalled() && 'the JavaScript parser eslint is not installed' };

// The declaration name a top-level statement binds: a function, or each variable declarator,
// exported or not.
function declaredNodes(statement) {
  const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
  if (declaration?.type === 'FunctionDeclaration') return [[declaration.id.name, declaration]];
  if (declaration?.type === 'VariableDeclaration') return declaration.declarations.map((d) => [d.id.name, d]);
  return [];
}

// The flags a regular-expression literal spells, each read from a `--name=` token, or a `--name`
// token followed directly by `$`. Anything else (the end of the pattern, `|`, `)`, a suffix) lets a
// longer argument match, so the flags cannot be read and it throws.
function regexFlags(path, pattern) {
  const flags = [];
  for (const { index } of pattern.matchAll(/--/g)) {
    const token = REGEX_FLAG_TOKEN.exec(pattern.slice(index))?.[0];
    const after = pattern[index + (token?.length ?? 0)];
    if (token === undefined || !(token.endsWith('=') || after === '$')) {
      throw new Error(`cannot read the flags ${path} accepts from the regular expression /${pattern}/: spell each flag as a string literal`);
    }
    flags.push(token);
  }
  return flags;
}

// The sorted, unique flags a source file spells: every string literal, and every template literal
// with no expression, whose whole value is a flag (`--name` or `--name=`), and every flag spelt
// inside a regular-expression literal; a regular expression whose flags cannot be read throws.
// `declarations` limits the scan to the top-level declarations of those names, for a file that also
// holds arguments that are not its own flags; a name the file does not declare throws.
export function flagLiterals(path, declarations) {
  const { Linter } = createRequire(import.meta.url)('eslint');
  const linter = new Linter();
  const messages = linter.verify(readFileSync(path, 'utf8'), { languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });
  const fatal = messages.find((message) => message.fatal);
  if (fatal) throw new Error(`cannot parse ${path}: ${fatal.message} (line ${fatal.line})`);
  const sourceCode = linter.getSourceCode();
  let roots = [sourceCode.ast];
  if (declarations) {
    const declared = new Map(sourceCode.ast.body.flatMap(declaredNodes));
    const missing = declarations.filter((name) => !declared.has(name));
    if (missing.length > 0) throw new Error(`${path} declares no ${missing.join(', ')}`);
    roots = declarations.map((name) => declared.get(name));
  }
  const flags = new Set();
  const visit = (node) => {
    const value = node.type === 'Literal' ? node.value
      : node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked
        : null;
    if (typeof value === 'string' && FLAG.test(value)) flags.add(value);
    if (node.type === 'Literal' && node.regex) for (const flag of regexFlags(path, node.regex.pattern)) flags.add(flag);
    for (const key of sourceCode.visitorKeys[node.type] ?? []) {
      for (const child of [node[key]].flat()) if (child) visit(child);
    }
  };
  roots.forEach(visit);
  return [...flags].sort();
}
