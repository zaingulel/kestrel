// Shared test support: a temporary copy of the board toolkit wired to a literal configuration.
//
// Another repository adopts the toolkit by copying exactly TOOLKIT_LIB and CLI_ENTRY_POINTS
// unchanged and editing only board-config.mjs. `copyToolkit` does exactly that into a temp
// directory, alongside the one fixture helper the tests need but no adopter ships, so a test
// loads fresh module instances wired to the configuration it names, never to this install's own
// board-config.mjs. An incomplete TOOLKIT_LIB fails a test at import, the same way it would fail
// a real adopter.
//
// Recurring cost: a temporary toolkit copy and fresh module load per importing test file;
// the portability test copies once per test.
// Removal condition: retire it when the board toolkit is no longer copied into another
// repository and no shipped test needs a configuration of its own.

import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = fileURLToPath(new URL('.', import.meta.url));
const SCRIPTS = fileURLToPath(new URL('..', import.meta.url));
export const CLI_ENTRY_POINTS = ['board.mjs', 'board-add.mjs', 'board-move.mjs', 'verify-issue-publish.mjs', 'linear-card.mjs', 'jira-card.mjs', 'azure-card.mjs'];

// The transitive closure of relative imports from the CLI entry points above. Copying
// exactly this set, no more, is the adoption contract itself: a file the toolkit no longer
// imports must fall out of here or an adopter carries dead weight neither test nor doc admits to.
export const TOOLKIT_LIB = [
  'board.mjs',
  'board-rules.mjs',
  'board-markdown.mjs',
  'board-config.mjs',
  'board-add.mjs',
  'board-move.mjs',
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
