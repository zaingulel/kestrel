// board-config.mjs — the ONE home for every Kestrel-specific board string the
// reader (board.mjs) and the writers (board-move/board-add/issue-publish) use.
//
// These values are facts about one live GitHub Projects board, not logic: an owner
// rename, a project move, a Status rename or a routing-option change is a single
// edit here rather than a hunt through five modules that each re-declared them.
// A second, differently-valued copy elsewhere is the bug this file exists to make
// impossible.

// Which project the board IS.
export const BOARD_OWNER = 'zaingulel';
// The GraphQL root field GitHub serves the owner's Projects under: 'user' for a personal
// account, 'organization' for an organisation. A wrong value fails loudly as a GitHub
// GraphQL error, never as a silently empty board.
export const BOARD_OWNER_TYPE = 'user';
export const BOARD_PROJECT_NUMBER = 7;
export const BOARD_REPOSITORY = 'kestrel';

// The Status column names, in board order. The three lists below are subsets of it.
export const STATUS_OPTIONS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];

// The pickable backlog per /resume Step 1: the two columns you draw candidates from.
export const PICKABLE_STATUSES = ['Backlog', 'Ready'];

// Waiting on the owner, not on a session: no stalled-claim clock runs here.
export const WAIT_STATUSES = ['Awaiting push'];

// The end of the line — a card here makes no claim on anything.
export const TERMINAL_STATUSES = ['Done'];

// The single-select field that routes a card to a front of work, and its options in
// display order (the order the pick view groups them in). Adding or renaming an option
// reaches well past this list: the literal pin in board.test.mjs fails first, then every
// board read throws until the board's own field offers the same set, and the routing rule
// wherever this repository's issue-filing guidance maps a kind of work to an option still
// names the old set.
//
// A board without a routing field sets `ROUTING_FIELD = null` and `ROUTING_OPTIONS = []`.
// Then only Status is required: the board read and scan check Status alone, board-add
// takes `<issue#> <Status>` with no routing argument, and the publish verifier checks
// Status only.
export const ROUTING_FIELD = 'Workstream';
export const ROUTING_OPTIONS = ['Go-to-market', 'Product', 'Platform'];

// A single-select field whose one option parks a card: the card keeps its Status column
// but is never pickable, and the pick view names it on a "Parked" line instead. A board
// with a parked lane sets `{ field: '<single-select field name>', option: '<option name>' }`;
// the board read then requires that field to exist and offer that option. Kestrel has
// no parked lane.
export const PARKED_LANE = null;

// The label that records each kind of issue: GitHub's default label names, plus `task` and
// `epic`, which the defaults lack.
export const KIND_LABELS = { epic: 'epic', feature: 'enhancement', task: 'task', bug: 'bug', docs: 'documentation' };
