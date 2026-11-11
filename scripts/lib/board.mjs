// board.mjs — the board read, selection and formatting for the GitHub Projects board.
//
// The session rituals call this layer instead of improvising a `gh` one-liner. Every
// GitHub call goes through the executor a caller hands in (fetchBoard, fetchCardDetails),
// so the whole file is unit-testable without touching `gh`.
//
// boardQuery fetches only the fields the scripts consume, about 2 GraphQL points per
// 100-item page, and fetchBoard walks every page inside one
// `gh api graphql --paginate --slurp` process, then walks the repository's issues the same
// way to recover the cards that listing omits.
//
// Do not migrate this read to the REST Projects API: at parity on these
// fields it sends 24.1x the payload, and the quota a migration would save is
// not scarce. Server-side filtering is not a reason either: ProjectV2.items
// takes the same `query` argument REST exposes as `q`.

import { join } from 'node:path';
import {
  BOARD_OWNER,
  BOARD_OWNER_TYPE,
  BOARD_PROJECT_NUMBER,
  BOARD_REPOSITORY,
  PARKED_LANE,
  PICKABLE_STATUSES,
  ROUTING_FIELD,
  ROUTING_OPTIONS,
  STATUS_OPTIONS,
} from './board-config.mjs';
import { rejectUnknownArgs } from './cli-flags.mjs';
import { GhOutputTooLargeError } from './gh-exec.mjs';
import { LINEAR_IDENTIFIER, cardRef, compareCardIds, kindTypesOf } from './tracker.mjs';
// A namespace import, because board-config.mjs is the adopter's file and an update never touches
// it: a named import of KIND_TYPES would stop every board tool at link time where it is absent.
import * as boardConfig from './board-config.mjs';

// The map from each kind to its native issue type where the configuration chooses types, else null.
export const KIND_TYPES = kindTypesOf(boardConfig);

// The one command's arguments, parsed before any gh call. A typo'd flag would otherwise
// be discarded into the DEFAULT read — a metered board read answering a question the
// operator never asked — and --closeout's exit code is a proof contract, so an
// unrecognised argument stops the command here rather than certifying a board nobody
// asked about (the #598 silent-substitution defect class).
const BOARD_USAGE = 'usage: node scripts/board.mjs [--all | --status=<Column>] [--json] | --closeout | --intake <folder> | --approval check <card>... | --help';

// Every flag the parser accepts, `--status=` as the prefix of its value form. The parser builds its
// accepted-flag map from this list and BOARD_HELP must mention each one, which a test pins.
export const BOARD_FLAGS = ['--all', '--json', '--closeout', '--intake', '--status=', '--approval', '--help'];

// What `--help` prints: the usage line, then each mode or option. The exit codes stay in the head of
// scripts/board.mjs.
export const BOARD_HELP = [
  BOARD_USAGE,
  '',
  '  (no argument)               pickable cards, then the drift scan',
  '  --all                       every column, then the drift scan',
  `  --status=<Column>           one column, exactly one of ${STATUS_OPTIONS.join(', ')}`,
  '  --json                      the normalized selection on stdout, the scan on stderr',
  '  --closeout                  the strict proof gate: the scan alone',
  '  --intake <folder>           the pick summary on stdout, each card\'s full text in <folder>, the outcome on stderr',
  "  --approval check <card>...  each card's advance approval line, with no board read",
  '  --help                      this text, with no board read',
].join('\n');

export function parseBoardArgs(argv) {
  // --help reads no board and prints a fixed text, so any companion argument would promise more.
  if (argv.includes('--help')) {
    if (argv.length > 1) throw new Error(`--help takes no other argument — ${BOARD_USAGE}`);
    return { help: true };
  }
  // --approval reads no board, so it stands first and alone: any other shape would promise a
  // listing it never prints, and a card that is not a positive integer names no card.
  if (argv.includes('--approval')) {
    const cards = argv.slice(2);
    if (argv[0] !== '--approval' || argv[1] !== 'check' || cards.length === 0 || !cards.every((card) => /^[1-9]\d*$/.test(card))) {
      throw new Error(`--approval takes only check and one or more card numbers — ${BOARD_USAGE}`);
    }
    return { approval: cards.map(Number) };
  }
  // --intake writes into one folder and prints one fixed summary, so it stands first with
  // exactly that value: a selection or format flag beside it would promise a listing it never
  // prints, --closeout a gate it never is, a value that looks like a flag is a typo for one, and a
  // line break in the folder would forge a line of the summary that names it.
  if (argv.includes('--intake')) {
    if (argv.length !== 2 || argv[0] !== '--intake' || argv[1] === '' || argv[1].startsWith('-') || /[\r\n]/.test(argv[1])) {
      throw new Error(`--intake takes one folder and no other argument — ${BOARD_USAGE}`);
    }
    return { all: false, status: null, json: false, closeout: false, intake: argv[1] };
  }
  // Checked before rejectUnknownArgs, which knows `--status=` as ONE positional and would
  // report a second as merely unrecognised: a repeat silently keeping the first is the same
  // wrong-question defect and earns its own sentence.
  const statusFlags = argv.filter((arg) => arg.startsWith('--status='));
  if (statusFlags.length > 1) {
    throw new Error(`only one --status= filter is allowed, got ${statusFlags.join(' ')} — ${BOARD_USAGE}`);
  }
  rejectUnknownArgs(argv, {
    // --status= is the positional below, and --approval, --intake and --help were handled above.
    flags: new Map(BOARD_FLAGS.filter((flag) => !['--status=', '--approval', '--intake', '--help'].includes(flag)).map((flag) => [flag, 0])),
    // An empty `--status=` names no column, so it is rejected here rather than degrading
    // into the default selection.
    positionals: [(arg) => /^--status=.+$/.test(arg)],
    expectation: BOARD_USAGE,
  });
  // --all with --status= selects by --all but would label the header with the status.
  if (argv.includes('--all') && statusFlags.length > 0) {
    throw new Error(`--all and ${statusFlags[0]} are exclusive — ${BOARD_USAGE}`);
  }
  // --closeout is the strict proof gate and prints the scan alone, so any companion flag
  // would promise a listing or a JSON document the gate never emits.
  if (argv.includes('--closeout') && argv.length > 1) {
    throw new Error(`--closeout takes no other argument — ${BOARD_USAGE}`);
  }
  // STATUS_OPTIONS is the board's whole column vocabulary, so a value outside it selects
  // nothing: the same wrong-question defect, one step further in. Checked HERE because
  // the read below is metered — `--status=Rady` must never cost a board read to answer
  // `Rady: 0 of 171 item(s)`. Exact, including case: a near-miss this "corrected" would
  // answer a different question just as silently.
  const status = statusFlags[0]?.slice('--status='.length) ?? null;
  if (status !== null && !STATUS_OPTIONS.includes(status)) {
    throw new Error(
      `--status=${status} is not a board column, expected one of ${STATUS_OPTIONS.join(', ')} — ${BOARD_USAGE}`,
    );
  }
  return {
    all: argv.includes('--all'),
    status,
    json: argv.includes('--json'),
    closeout: argv.includes('--closeout'),
    intake: null,
  };
}

// The board's own Status column field. Its option list lives in board-config.mjs;
// only the field's name is needed here, to read one card's value off fieldValues.
const STATUS_FIELD = 'Status';

// One board item's card fields: the board read asks for them on every listed item and on each
// item it recovers by id, and the issue-side probe on an archived item the read cannot list, so
// all parse through parseNode.
// The issue type is asked for only where the configuration chooses native types, so a labels
// repository's requests are the same bytes as before.
export const BOARD_CARD_FIELDS = `content { __typename ... on Issue { number title state repository { nameWithOwner } subIssuesSummary { total completed } ${KIND_TYPES ? 'issueType { name } ' : ''}labels(first:20) { totalCount nodes { name } } assignees(first:20) { totalCount nodes { login } } blockedBy(first:20) { totalCount nodes { number state } } closedByPullRequestsReferences(first:20) { totalCount nodes { number } } } } fieldValues(first:20) { totalCount nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } } }`;

// The one fused board query: the project's identity and field schema, then its items
// 100 per page, each carrying every fact the board rules judge a card on — Status and
// the routing field off fieldValues, and state, labels, the issue type where chosen, assignees,
// native blockers, closing pull requests and the sub-issue summary off the Issue content.
//
// It declares the `$endCursor` variable and one `pageInfo { hasNextPage endCursor }`
// because that pair is what lets `gh api graphql --paginate` walk every page inside ONE
// gh process (#1155): gh re-sends the query with the last page's endCursor until
// hasNextPage is false. Only the items connection may carry a pageInfo; gh takes the
// first one it finds in a response, so a pageInfo on labels or fieldValues would page
// the wrong list.
//
// `state` and `subIssuesSummary { total completed }` ride on the Issue content so the
// drift check's epic and pickable-closed passes read them off this page (#1154, #1155):
// before, they cost two sequential gh calls per non-terminal epic and one closed-issue
// list of every closed issue in the repository, for fields GitHub attaches to the issue
// node for free.
//
// `__typename` is a free meta field and the ONLY thing that separates a card that is
// legitimately numberless (a draft, a pull request) from one whose content did not
// resolve on this read. Without it both arrive as `number: null` and a just-added card
// reads as never added (#572).
export function boardQuery() {
  return `query($endCursor: String) { ${BOARD_OWNER_TYPE}(login:"${BOARD_OWNER}") { login projectV2(number:${BOARD_PROJECT_NUMBER}) { id number closed fields(first:50) { totalCount nodes { ... on ProjectV2FieldCommon { name dataType } ... on ProjectV2SingleSelectField { options { name } } } } items(first:100, after:$endCursor) { totalCount pageInfo { hasNextPage endCursor } nodes { id ${BOARD_CARD_FIELDS} } } } } }`;
}

const RERUN = 'rerun the board read, and if it repeats inspect the GitHub Projects API response';

// The one repository this board's cards may belong to, spelled the way GitHub does.
const BOARD_NAME_WITH_OWNER = `${BOARD_OWNER}/${BOARD_REPOSITORY}`;

// Every connection in the response either came back whole or the read stops here:
// `totalCount` is the ONLY evidence of that, so a missing or non-integer one is a
// broken read rather than a quiet pass, and a card narrowed to its `first:` cap
// (#464 review) would be the exact silent truncation this file's fail-loud
// philosophy forbids — a dropped closing reference would make an in-flight claim read
// as stalled.
function assertConnectionShape(connection, what, where) {
  if (!Number.isInteger(connection?.totalCount) || connection.totalCount < 0 || !Array.isArray(connection.nodes)) {
    throw new Error(
      `${where} returned a malformed ${what} connection — expected a non-negative integer totalCount and a nodes[] array; ${RERUN}`,
    );
  }
}

// The capped sub-lists are fetched WHOLE, so the count and the nodes must agree in both
// directions. Fewer nodes than the count is the truncation above; a count SMALLER than
// the nodes is an under-reporting response, and it is not harmless either — a closing
// reference arriving under `totalCount: 0` comes from a response that contradicts
// itself, and closing references are what decide whether an in-flight claim reads as
// stalled.
function assertWholeConnection(connection, what, where) {
  assertConnectionShape(connection, what, where);
  if (connection.totalCount > connection.nodes.length) {
    throw new Error(
      `${where} has ${connection.totalCount} ${what} but only ${connection.nodes.length} fetched — raise the ${what} first: cap in boardQuery`,
    );
  }
  if (connection.totalCount < connection.nodes.length) {
    throw new Error(
      `${where} returned ${connection.nodes.length} ${what} but reports totalCount ${connection.totalCount} — the count contradicts the nodes; ${RERUN}`,
    );
  }
}

// A fieldValues.nodes[] entry names its field via a fragment (single-select or
// text) — an unmatched fragment type parses as `{}`, which this skips naturally
// (no `field.name` to match). A single-select field holds ONE value per card, so
// two is a malformed read: which one the reader picked would be an accident of
// node order.
function fieldValue(fieldValues, name, cardId) {
  const matches = fieldValues.filter((fv) => fv?.field?.name === name);
  if (matches.length > 1) {
    throw new Error(
      `board item ${cardId} carried ${matches.length} "${name}" values — the board holds one value per card; ${RERUN}`,
    );
  }
  if (matches.length === 0) return null;
  return matches[0].name ?? matches[0].text ?? null;
}

// One board item carrying BOARD_CARD_FIELDS (a boardQuery `nodes[]` entry or a probed archived
// item) → the flat raw item: Status, title and the routing value off fieldValues, the issue's
// own facts off content. A draft card keeps its `DraftIssue` typename with no number, and a
// content that did not resolve arrives as `{}` — that is the distinction normalizeItem and
// isContentUnresolved read.
export function parseNode(node) {
  assertWholeConnection(node.fieldValues, 'fieldValues', `board item ${node.id}`);
  const fieldValues = node.fieldValues.nodes;
  const content = node.content ?? {};
  const issue = content.__typename === 'Issue' ? content : null;
  if (issue) assertIssueContent(issue, node.id);
  const connectionNodes = (connection) => connection?.nodes ?? [];
  return {
    id: node.id ?? null,
    status: fieldValue(fieldValues, STATUS_FIELD, node.id),
    title: content.title ?? fieldValue(fieldValues, 'Title', node.id) ?? '',
    routing: ROUTING_FIELD ? fieldValue(fieldValues, ROUTING_FIELD, node.id) : null,
    ...(PARKED_LANE ? { lane: fieldValue(fieldValues, PARKED_LANE.field, node.id) } : {}),
    labels: connectionNodes(issue?.labels).map((l) => l.name),
    ...(KIND_TYPES ? { issueType: issue?.issueType?.name ?? null } : {}),
    assignees: connectionNodes(issue?.assignees).map((a) => a.login),
    blockers: connectionNodes(issue?.blockedBy).map((b) => ({ number: b.number, state: b.state })),
    closingPullRequests: connectionNodes(issue?.closedByPullRequestsReferences)
      .map((pr) => ({ number: pr.number })),
    content: {
      ...(content.__typename != null ? { __typename: content.__typename } : {}),
      ...(content.number != null ? { number: content.number } : {}),
      ...(content.state != null ? { state: content.state } : {}),
      ...(content.subIssuesSummary != null ? { subIssuesSummary: content.subIssuesSummary } : {}),
    },
  };
}

// A numbered Issue card is the shape every board rule judges, so a field that came
// back malformed stops the read rather than being defaulted: a missing state would
// silence the epic passes, an unusable summary would forge an undecomposed-epic row,
// a closing reference without a number would make an in-flight claim read as stalled,
// and an assignee without a usable login would print as an account on the intake
// document.
function assertIssueContent(issue, cardId) {
  const where = `board item ${cardId}`;
  assertWholeConnection(issue.labels, 'labels', where);
  assertWholeConnection(issue.assignees, 'assignees', where);
  assertWholeConnection(issue.blockedBy, 'blockedBy', where);
  assertWholeConnection(issue.closedByPullRequestsReferences, 'closedByPullRequestsReferences', where);

  const card = `board card #${issue.number}`;
  if (issue.state !== 'OPEN' && issue.state !== 'CLOSED') {
    throw new Error(`${card} came back with state "${issue.state}" — expected OPEN or CLOSED; ${RERUN}`);
  }
  const { total, completed } = issue.subIssuesSummary ?? {};
  if (!Number.isInteger(total) || !Number.isInteger(completed) || total < 0 || completed < 0 || completed > total) {
    throw new Error(`${card} carried no usable sub-issue summary — expected whole total and completed counts; ${RERUN}`);
  }
  // A card with no type is legitimate (null) and is reported downstream; a type that is not a
  // named one is a malformed read, and a missing key is too, since null is what GitHub sends.
  if (KIND_TYPES && issue.issueType !== null && (typeof issue.issueType?.name !== 'string' || issue.issueType.name.trim() === '')) {
    throw new Error(`${card} carried no usable issue type — expected null or a named type; ${RERUN}`);
  }
  const repository = issue.repository?.nameWithOwner ?? 'no repository';
  if (repository !== BOARD_NAME_WITH_OWNER) {
    throw new Error(
      `${card} belongs to ${repository}, not ${BOARD_NAME_WITH_OWNER} — this reader judges only ${BOARD_NAME_WITH_OWNER} cards; check BOARD_REPOSITORY in scripts/lib/board-config.mjs`,
    );
  }
  const numbered = (node) => Number.isInteger(node?.number) && node.number > 0;
  for (const reference of issue.closedByPullRequestsReferences.nodes) {
    if (!numbered(reference)) {
      throw new Error(`${card} carried a closing pull-request reference without a number; ${RERUN}`);
    }
  }
  for (const blocker of issue.blockedBy.nodes) {
    if (!numbered(blocker) || (blocker.state !== 'OPEN' && blocker.state !== 'CLOSED')) {
      throw new Error(`${card} carried a blocker without a number and an OPEN or CLOSED state; ${RERUN}`);
    }
  }
  for (const assignee of issue.assignees.nodes) {
    if (typeof assignee?.login !== 'string' || assignee.login.trim() === '') {
      throw new Error(`${card} carried an assignee without a usable login; ${RERUN}`);
    }
  }
}

// Every page must be the SAME configured, open project (#572: an absence probe once
// asked a different project than the board read it was confirming). Returns the
// project node plus the identity string fetchBoard compares the next page against.
export function assertProject(data, boardOwner = BOARD_OWNER, projectNumber = BOARD_PROJECT_NUMBER, ownerType = BOARD_OWNER_TYPE) {
  const owner = data?.data?.[ownerType];
  const project = owner?.projectV2;
  if (!project) {
    throw new Error(`board page carried no ${ownerType} data; ${RERUN}`);
  }
  if (owner.login !== boardOwner) {
    throw new Error(
      `board page answered for ${ownerType} "${owner.login}" but BOARD_OWNER is "${boardOwner}" — point the read at the configured owner in scripts/lib/board-config.mjs`,
    );
  }
  if (project.number !== projectNumber) {
    throw new Error(
      `board page answered for project ${project.number} but BOARD_PROJECT_NUMBER is ${projectNumber} — point the read at the configured project in scripts/lib/board-config.mjs`,
    );
  }
  if (typeof project.id !== 'string' || project.id.trim() === '') {
    throw new Error(`board page carried no project id; ${RERUN}`);
  }
  if (typeof project.closed !== 'boolean') {
    throw new Error(`board page carried no boolean closed flag; ${RERUN}`);
  }
  if (project.closed) {
    throw new Error(
      `board project ${projectNumber} is closed — reopen it, or point BOARD_PROJECT_NUMBER at the live board in scripts/lib/board-config.mjs`,
    );
  }
  return { project, identity: `${owner.login} project ${project.number} (${project.id})` };
}

// The live Status and routing fields must be single-selects offering exactly the
// options board-config.mjs configures. Compared as sets: ROUTING_OPTIONS is a display
// order, not the board's own. A configured parked lane's field must be a single-select
// offering its option, among any others. Returns the schema signature fetchBoard
// compares the next page against.
export function assertFieldSchema(fields, { routingField = ROUTING_FIELD, routingOptions = ROUTING_OPTIONS, parkedLane = PARKED_LANE } = {}) {
  assertWholeConnection(fields, 'project fields', 'board page');
  const configuredOptions = [[STATUS_FIELD, STATUS_OPTIONS], ...(routingField ? [[routingField, routingOptions]] : [])];
  for (const [name, configured] of configuredOptions) {
    const field = fields.nodes.find((f) => f?.name === name);
    if (!field) {
      throw new Error(`the board has no "${name}" field — add it to the project, or correct the name in scripts/lib/board-config.mjs`);
    }
    if (field.dataType !== 'SINGLE_SELECT') {
      throw new Error(
        `the board's "${name}" is a ${field.dataType} field, not SINGLE_SELECT — restore the single-select field, or correct scripts/lib/board-config.mjs`,
      );
    }
    const live = (field.options ?? []).map((o) => o?.name);
    const wanted = [...configured].sort();
    const seen = [...live].sort();
    if (seen.length !== wanted.length || seen.some((option, i) => option !== wanted[i])) {
      throw new Error(
        `the board's "${name}" field offers ${live.join(', ')} but scripts/lib/board-config.mjs configures ${configured.join(', ')} — reconcile the board field with board-config.mjs`,
      );
    }
  }
  if (parkedLane) {
    const { field: name, option } = parkedLane;
    const field = fields.nodes.find((f) => f?.name === name);
    if (!field) {
      throw new Error(`the board has no "${name}" field for PARKED_LANE — add it to the project, or correct PARKED_LANE in scripts/lib/board-config.mjs`);
    }
    if (field.dataType !== 'SINGLE_SELECT') {
      throw new Error(
        `the board's "${name}" is a ${field.dataType} field, not SINGLE_SELECT — restore the single-select field, or correct PARKED_LANE in scripts/lib/board-config.mjs`,
      );
    }
    const live = (field.options ?? []).map((o) => o?.name);
    if (!live.includes(option)) {
      throw new Error(
        `the board's "${name}" field offers ${live.join(', ')} but PARKED_LANE in scripts/lib/board-config.mjs parks "${option}" — add the option to the board field, or correct board-config.mjs`,
      );
    }
  }
  return fields.nodes
    .map((f) => `${f?.name}:${f?.dataType}:${(f?.options ?? []).map((o) => o?.name).join('|')}`)
    .join(';');
}

const countBy = (items, key) => {
  const counts = new Map();
  for (const item of items) {
    const value = key(item);
    if (value == null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
};

// One issue, one card, one id. Two cards for the same number make every count and every
// per-card verdict ambiguous, and one of the two is stale by definition. The id is the
// card's own identity, so the same id twice is not two cards at all but one card the
// response repeated — a doubled row out of a read that never saw two, which no board
// edit can repair.
function assertNoDuplicateCards(items) {
  for (const [number, count] of countBy(items, (i) => i.content?.number)) {
    if (count > 1) {
      throw new Error(
        `issue #${number} appears on ${count} board cards — remove the duplicate card from the board, then rerun the read`,
      );
    }
  }
  for (const [id, count] of countBy(items, (i) => i.id)) {
    if (count > 1) {
      throw new Error(`board item ${id} was returned on ${count} cards in one read; ${RERUN}`);
    }
  }
}

// Parse one boardQuery response page (one element of the --slurp array) into
// `{ items, totalCount, hasNextPage, endCursor, identity, fieldSignature }`. Throws
// (fail-loud) rather than returning [] on a malformed shape, so a broken read never
// masquerades as an empty board; the identity and signature are what fetchBoard holds
// the rest of the walk to.
//
// A draft card, a pull-request card, a card with no Status and a card with no routing
// value are NOT malformed: this board legitimately holds all four, and they are
// reported as drift rows downstream. A parser that threw on them would strand every
// session instead.
export function parseBoardPage(json) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (err) {
    throw new Error(`board page JSON could not be parsed: ${err.message}; ${RERUN}`);
  }
  if (data === null || typeof data !== 'object') {
    throw new Error(`board page is not a GraphQL data object; ${RERUN}`);
  }
  if (data.errors != null) {
    const messages = (Array.isArray(data.errors) ? data.errors : [data.errors])
      .map((e) => e?.message ?? JSON.stringify(e))
      .join('; ');
    throw new Error(
      `the board read returned GraphQL errors: ${messages} — fix the query or the token's project scope, then rerun the board read`,
    );
  }

  const { project, identity } = assertProject(data);
  const fieldSignature = assertFieldSchema(project.fields);
  const itemsNode = project.items;
  assertConnectionShape(itemsNode, 'items', 'board page');
  const items = itemsNode.nodes.map(parseNode);
  assertNoDuplicateCards(items);
  const { hasNextPage, endCursor } = assertPageInfo(itemsNode.pageInfo);
  return {
    items,
    totalCount: itemsNode.totalCount,
    hasNextPage,
    endCursor,
    identity,
    fieldSignature,
  };
}

// gh --paginate decides whether to ask for another page from this pair alone, so a
// coerced value is a page decision made on a malformed one: `Boolean("false")` is true
// and a missing hasNextPage is false, silently looping or truncating the walk. A next
// page also has to say WHERE, so hasNextPage without a usable cursor is a broken read.
function assertPageInfo(pageInfo) {
  const hasNextPage = pageInfo?.hasNextPage;
  if (typeof hasNextPage !== 'boolean') {
    throw new Error(`board page pagination carried no boolean hasNextPage; ${RERUN}`);
  }
  const endCursor = pageInfo.endCursor ?? null;
  if (hasNextPage && (typeof endCursor !== 'string' || endCursor.trim() === '')) {
    throw new Error(`board page pagination reports hasNextPage without a non-empty endCursor; ${RERUN}`);
  }
  return { hasNextPage, endCursor };
}

const boardItemsReadError = (detail) =>
  `incomplete board items read: ${detail}; rerun the board read, and if it repeats inspect the GitHub Projects API response`;

// Raw `gh api graphql --paginate --slurp` output → the page objects in walk order.
// Slurp wraps the pages in one array; without it gh concatenates one JSON object per
// page, which JSON.parse rejects on page 2+ but accepts as a bare object on a
// one-page board — passing that through would silently drop every later page. An
// empty array is a walk that fetched nothing, which is never a board.
function parseSlurpedBoardPages(out) {
  const pages = JSON.parse(out);
  const isPageObject = (p) => p !== null && typeof p === 'object' && !Array.isArray(p);
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every(isPageObject)) {
    throw new Error('expected --slurp page objects ([{…},{…}]) — is --slurp missing from the gh call?');
  }
  return pages;
}

// Read the project's item listing in one `gh` process: `--paginate` walks the pages on the
// query's `$endCursor`, `--slurp` returns them as one array, and this checks the
// walk it was handed the way the page-by-page loop it replaced did (#1155): a
// constant totalCount, a fresh cursor behind every hasNextPage (parseBoardPage has
// already required a usable one), no hasNextPage left on the final page, and an exact
// item count at the end. The
// injected executor keeps the board transport at the CLI edge while making the
// walk checks testable without `gh`.
function fetchListedBoard(exec) {
  const out = exec(['api', 'graphql', '--paginate', '--slurp', '-f', `query=${boardQuery()}`]);
  const pages = parseSlurpedBoardPages(out).map(parseBoardPage);
  const items = [];
  let expected;
  const usedCursors = new Set();
  pages.forEach((page, index) => {
    // One walk is one project read against one field schema. Two half-boards spliced
    // together would have every rule judge cards against a schema the read never saw
    // whole, and a totalCount that moved mid-walk is a board that changed under it.
    if (expected === undefined) {
      expected = page;
    } else if (page.identity !== expected.identity) {
      throw new Error(
        boardItemsReadError(`project identity changed across pages from ${expected.identity} to ${page.identity}`),
      );
    } else if (page.fieldSignature !== expected.fieldSignature) {
      throw new Error(boardItemsReadError('the project field schema changed across pages'));
    } else if (page.totalCount !== expected.totalCount) {
      throw new Error(
        boardItemsReadError(`item totalCount changed across pages from ${expected.totalCount} to ${page.totalCount}`),
      );
    }
    items.push(...page.items);
    // gh stops on hasNextPage:false and continues on true, so a final page still
    // pointing onward is a walk cut short, and a page that follows a hasNextPage:false
    // page is one the walk should never have been handed.
    const isLast = index === pages.length - 1;
    if (page.hasNextPage === isLast) {
      throw new Error(boardItemsReadError(
        isLast ? 'the last page still reports hasNextPage' : `page ${index + 1} of ${pages.length} reports no next page`,
      ));
    }
    if (page.hasNextPage) {
      if (usedCursors.has(page.endCursor)) {
        throw new Error(`board pagination received repeated endCursor: ${page.endCursor}`);
      }
      usedCursors.add(page.endCursor);
    }
  });
  // This catches a pagination or short-read mismatch against GitHub's totalCount,
  // but not a server omission already excluded from GitHub's own totalCount, which
  // fetchBoard's issue walk recovers.
  if (items.length !== expected.totalCount) {
    throw new Error(
      boardItemsReadError(`GitHub reported ${expected.totalCount} board items but ${items.length} were fetched`),
    );
  }
  // Each page is duplicate-free on its own; the same issue or the same id on two PAGES
  // is only visible here, once the whole walk is in hand.
  assertNoDuplicateCards(items);
  return items;
}

const recoveryError = (detail) =>
  `incomplete board recovery: ${detail}; rerun the board read, and if it repeats inspect the GitHub issue and project item responses`;

// The same membership fields board-move.mjs's issue-side probe asks for; an item's project
// owner is a user or an organisation, so its login is read through both.
const MEMBERSHIP_FIELDS = 'id isArchived project { number owner { ... on User { login } ... on Organization { login } } }';

// The issue walk reads one issue's memberships up to this cap; an issue past it has its
// memberships walked on their own.
const MEMBERSHIP_PAGE_SIZE = 100;

// How many omitted items one read by id asks for.
const OMITTED_ITEM_BATCH_SIZE = 20;

// Every issue of the repository, open and closed, with its project memberships, archived ones
// included so an archived card is told apart from an absent one. Only the issues connection
// carries a pageInfo: gh pages on the first one it finds.
function issueWalkQuery() {
  return `query($endCursor: String) { repository(owner:"${BOARD_OWNER}", name:"${BOARD_REPOSITORY}") { issues(first:100, after:$endCursor, states:[OPEN,CLOSED]) { totalCount pageInfo { hasNextPage endCursor } nodes { number projectItems(first:${MEMBERSHIP_PAGE_SIZE}, includeArchived:true) { totalCount nodes { ${MEMBERSHIP_FIELDS} } } } } } }`;
}

function membershipWalkQuery(number) {
  return `query($endCursor: String) { repository(owner:"${BOARD_OWNER}", name:"${BOARD_REPOSITORY}") { issue(number:${number}) { number projectItems(first:${MEMBERSHIP_PAGE_SIZE}, after:$endCursor, includeArchived:true) { totalCount pageInfo { hasNextPage endCursor } nodes { ${MEMBERSHIP_FIELDS} } } } } }`;
}

// Item ids are GitHub's own opaque strings; JSON quoting is valid GraphQL string syntax.
function omittedItemsQuery(ids) {
  return `query { nodes(ids:[${ids.map((id) => JSON.stringify(id)).join(',')}]) { ... on ProjectV2Item { ${MEMBERSHIP_FIELDS} ${BOARD_CARD_FIELDS} } } }`;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseRecoveryReply(out, what) {
  let reply;
  try {
    reply = JSON.parse(out);
  } catch (err) {
    throw new Error(recoveryError(`the ${what} is not JSON (${err.message})`));
  }
  return reply;
}

// One slurped walk → its nodes, held to the checks the project walk applies to its own pages
// (fetchListedBoard keeps its copy, whose messages and per-page identity checks are the
// board's): a constant totalCount, a fresh cursor behind every hasNextPage, none on the last
// page, and exactly totalCount nodes at the end. A page carrying GraphQL errors is refused
// whatever data rides beside it.
function walkConnection(out, what, connectionOf) {
  const pages = parseRecoveryReply(out, what);
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(recoveryError(`the ${what} is not a list of --slurp pages`));
  }
  const nodes = [];
  const usedCursors = new Set();
  let totalCount;
  pages.forEach((page, index) => {
    if (!isPlainObject(page) || page.errors != null) {
      throw new Error(recoveryError(`page ${index + 1} of the ${what} is not a GraphQL data object or carries errors`));
    }
    const connection = connectionOf(page);
    assertConnectionShape(connection, what, `page ${index + 1}`);
    if (totalCount === undefined) {
      totalCount = connection.totalCount;
    } else if (connection.totalCount !== totalCount) {
      throw new Error(recoveryError(`the ${what} count changed across pages from ${totalCount} to ${connection.totalCount}`));
    }
    const { hasNextPage, endCursor } = connection.pageInfo ?? {};
    if (hasNextPage !== (index < pages.length - 1)) {
      throw new Error(recoveryError(`page ${index + 1} of ${pages.length} of the ${what} reports hasNextPage ${hasNextPage}`));
    }
    if (hasNextPage) {
      if (typeof endCursor !== 'string' || endCursor.trim() === '' || usedCursors.has(endCursor)) {
        throw new Error(recoveryError(`the ${what} reports a next page without a fresh endCursor`));
      }
      usedCursors.add(endCursor);
    }
    nodes.push(...connection.nodes);
  });
  if (nodes.length !== totalCount) {
    throw new Error(recoveryError(`GitHub reported ${totalCount} in the ${what} but ${nodes.length} were fetched`));
  }
  return nodes;
}

function assertMembership(membership, where) {
  if (
    !isPlainObject(membership)
    || typeof membership.id !== 'string' || membership.id.trim() === ''
    || typeof membership.isArchived !== 'boolean'
    || !Number.isInteger(membership.project?.number) || membership.project.number < 1
    || typeof membership.project.owner?.login !== 'string' || membership.project.owner.login.trim() === ''
  ) {
    throw new Error(recoveryError(`${where} carried a project item without an id, a boolean archive flag and a project number and owner`));
  }
}

const isOnBoard = (membership) =>
  membership.project.number === BOARD_PROJECT_NUMBER && membership.project.owner.login === BOARD_OWNER;

const membershipKey = (m) => JSON.stringify([m.id, m.isArchived, m.project.number, m.project.owner.login]);

// One walked issue's memberships, whole. Past the first page they are walked on their own, and
// that walk must still hold every membership the first page showed, unchanged.
function issueMemberships(exec, issue) {
  const where = `issue #${issue.number}`;
  const firstPage = issue.projectItems;
  assertConnectionShape(firstPage, 'projectItems', where);
  firstPage.nodes.forEach((membership) => assertMembership(membership, where));
  // The overflow walk is compared with the first page as a set, so a repeat here would pass it.
  const firstIds = new Set();
  for (const { id } of firstPage.nodes) {
    if (firstIds.has(id)) {
      throw new Error(recoveryError(`${where} returned project item ${id} twice on its first page`));
    }
    firstIds.add(id);
  }
  if (firstPage.nodes.length > firstPage.totalCount) {
    throw new Error(recoveryError(`${where} returned ${firstPage.nodes.length} project items but reports totalCount ${firstPage.totalCount}`));
  }
  if (firstPage.nodes.length === firstPage.totalCount) return firstPage.nodes;
  if (firstPage.nodes.length !== MEMBERSHIP_PAGE_SIZE) {
    throw new Error(recoveryError(`${where} has ${firstPage.totalCount} project items but only ${firstPage.nodes.length} fetched`));
  }
  const out = exec(['api', 'graphql', '--paginate', '--slurp', '-f', `query=${membershipWalkQuery(issue.number)}`]);
  const memberships = walkConnection(out, `project item walk of ${where}`, (page) => {
    const walked = page.data?.repository?.issue;
    if (!isPlainObject(walked) || walked.number !== issue.number) {
      throw new Error(recoveryError(`the project item walk of ${where} answered for another issue or none`));
    }
    return walked.projectItems;
  });
  memberships.forEach((membership) => assertMembership(membership, where));
  const walkedKeys = new Set(memberships.map(membershipKey));
  if (memberships.length !== firstPage.totalCount || firstPage.nodes.some((m) => !walkedKeys.has(membershipKey(m)))) {
    throw new Error(recoveryError(`the project item walk of ${where} disagrees with the issue walk's first observation`));
  }
  return memberships;
}

// Every unarchived item on this board the listing lacked, as `{ id, number }`. A listed item
// seen on another board, archived or under another issue is evidence that disagrees with the
// listing, and so is one item id or one issue seen twice; an unresolved listed card has no
// number to disagree with.
function omittedMemberships(exec, listed) {
  const listedNumbers = new Map(listed.map((item) => [item.id, item.content?.number ?? null]));
  const issues = walkConnection(
    exec(['api', 'graphql', '--paginate', '--slurp', '-f', `query=${issueWalkQuery()}`]),
    'repository issue walk',
    (page) => page.data?.repository?.issues,
  );
  const seenNumbers = new Set();
  const seenIds = new Set();
  const omitted = [];
  for (const issue of issues) {
    if (!isPlainObject(issue) || !Number.isInteger(issue.number) || issue.number < 1 || seenNumbers.has(issue.number)) {
      throw new Error(recoveryError('the repository issue walk returned an issue without a number, or one issue twice'));
    }
    seenNumbers.add(issue.number);
    for (const membership of issueMemberships(exec, issue)) {
      if (seenIds.has(membership.id)) {
        throw new Error(recoveryError(`project item ${membership.id} was walked twice`));
      }
      seenIds.add(membership.id);
      if (listedNumbers.has(membership.id)) {
        if (!isOnBoard(membership)) {
          throw new Error(recoveryError(`listed board item ${membership.id} is walked on project ${membership.project.number} of ${membership.project.owner.login} on issue #${issue.number}`));
        }
        const number = listedNumbers.get(membership.id);
        if (membership.isArchived || (number !== null && number !== issue.number)) {
          throw new Error(recoveryError(`listed board item ${membership.id} is ${membership.isArchived ? 'archived' : `#${number}`} on issue #${issue.number}`));
        }
      } else if (isOnBoard(membership) && !membership.isArchived) {
        omitted.push({ id: membership.id, number: issue.number });
      }
    }
  }
  return omitted;
}

// Each omitted item read by its own id, in batches, and parsed as a listed card is, once its
// id, archive flag, board and issue agree with what the walk saw.
function readOmittedItems(exec, omitted) {
  const items = [];
  for (let start = 0; start < omitted.length; start += OMITTED_ITEM_BATCH_SIZE) {
    const batch = omitted.slice(start, start + OMITTED_ITEM_BATCH_SIZE);
    const reply = parseRecoveryReply(exec(['api', 'graphql', '-f', `query=${omittedItemsQuery(batch.map((m) => m.id))}`]), 'omitted item read');
    const nodes = reply?.data?.nodes;
    if (!isPlainObject(reply) || reply.errors != null || !Array.isArray(nodes) || nodes.length !== batch.length) {
      throw new Error(recoveryError('the omitted item read carried errors or not one node per requested item'));
    }
    batch.forEach(({ id, number }, index) => {
      const node = nodes[index];
      assertMembership(node, `omitted item ${id}`);
      if (node.id !== id || node.isArchived || !isOnBoard(node) || node.content?.__typename !== 'Issue' || node.content.number !== number) {
        throw new Error(recoveryError(`omitted item ${id} did not read back as the unarchived board card of issue #${number}`));
      }
      items.push(parseNode(node));
    });
  }
  return items;
}

// GitHub's project item list can leave out a card that is on the board while its own
// totalCount agrees (#504), so the listing alone cannot show the gap. The issue side still
// holds each card's membership: this walks the repository's issues and reads by id every
// unarchived membership on this board the listing lacked, then returns listed and recovered
// cards as one list the board rules judge alike. A recovery calls `onOmission` once with an
// advisory naming each recovered card; any evidence that is incomplete or disagrees throws,
// so a reconciliation that could not finish never reads as a whole board.
export function fetchBoard(exec, { onOmission = () => {} } = {}) {
  const listed = fetchListedBoard(exec);
  const recovered = readOmittedItems(exec, omittedMemberships(exec, listed));
  if (recovered.length === 0) return listed;
  const items = [...listed, ...recovered];
  assertNoDuplicateCards(items);
  const named = recovered.map((item) => `${cardRef(item.content.number)} (${item.id})`).join(', ');
  onOmission(`GitHub's project listing left out ${recovered.length} card(s) that are on the board, read from their issues instead: ${named}. They are already on the board, so do not add them again.`);
  return items;
}

// How many cards one detail call asks for. A failed call costs every card it named, so
// the batch is the unit of loss, except that a batch too large to read is read again in halves.
export const DETAIL_BATCH_SIZE = 20;

// The newest 100 comments and the cursor to the ones before them. `totalCount` is the
// whole connection's count on every page, never the page's own.
const COMMENT_PAGE_FIELDS = 'totalCount pageInfo { hasPreviousPage startCursor } nodes { body }';

// One aliased issue per card, so one call reads a whole batch. It declares no
// `$endCursor`: comments page backward, which `gh --paginate` cannot follow.
export function cardDetailsQuery(numbers) {
  if (numbers.length === 0 || !numbers.every(Number.isInteger)) {
    throw new Error('cardDetailsQuery needs at least one card number, each an integer');
  }
  const aliases = numbers.map((n) => `i${n}: issue(number:${n}) { ...CardDetails }`).join(' ');
  return `query { repository(owner:"${BOARD_OWNER}" name:"${BOARD_REPOSITORY}") { ${aliases} } } fragment CardDetails on Issue { number body parent { number } comments(last:100) { ${COMMENT_PAGE_FIELDS} } }`;
}

function commentPageQuery() {
  return `query($number: Int!, $before: String!) { repository(owner:"${BOARD_OWNER}" name:"${BOARD_REPOSITORY}") { issue(number:$number) { number comments(last:100, before:$before) { ${COMMENT_PAGE_FIELDS} } } } }`;
}

const firstLine = (text) => (text.split(/\r\n|\n|\r/).find((line) => line.trim() !== '') ?? '').slice(0, 300);

const thrownReason = (err) =>
  firstLine(typeof err?.stderr === 'string' && err.stderr !== '' ? err.stderr : String(err?.message ?? err));

const isObject = (value) => value !== null && typeof value === 'object';

// One detail call → `{ repository }` or `{ reason, tooLarge }`, where `malformed` is the reason for
// a response that is not the shape asked for. gh prints partial data beside GraphQL
// errors, so no part of a response that carries errors is used. No value from the response
// is put into a reason before its type is checked: one that cannot be turned into text
// would throw out of the read and lose every card beside it.
function readDetailCall(exec, args, malformed) {
  let out;
  try {
    out = exec(args);
  } catch (err) {
    return { reason: thrownReason(err), tooLarge: err instanceof GhOutputTooLargeError };
  }
  let response;
  try {
    response = JSON.parse(out);
  } catch {
    return { reason: malformed };
  }
  const errors = response?.errors ?? [];
  if (!Array.isArray(errors)) return { reason: malformed };
  if (errors.length > 0) {
    const message = errors[0]?.message;
    return { reason: typeof message === 'string' ? `GraphQL errors: ${firstLine(message)}` : malformed };
  }
  const repository = response?.data?.repository;
  return isObject(repository) ? { repository } : { reason: malformed };
}

function isCommentPage(page) {
  return Number.isInteger(page?.totalCount)
    && Array.isArray(page.nodes)
    && page.nodes.every((node) => typeof node?.body === 'string')
    && page.nodes.length <= page.totalCount
    && typeof page.pageInfo?.hasPreviousPage === 'boolean'
    && (!page.pageInfo.hasPreviousPage
      || (typeof page.pageInfo.startCursor === 'string' && page.pageInfo.startCursor !== ''));
}

// Walks one issue's comments backward from its newest page. Completeness is judged
// against the FIRST page's totalCount, and only once no previous page remains: a short
// final page is valid, so no continuation is judged short on its own. A continuation
// reporting another totalCount is a list that changed between pages: it is not
// accumulated, and the comments already read are returned as an incomplete read.
function readOlderComments(exec, number, firstPage) {
  const commentCount = firstPage.totalCount;
  let comments = firstPage.nodes.map((node) => node.body);
  let { hasPreviousPage, startCursor } = firstPage.pageInfo;
  const usedCursors = new Set();
  while (hasPreviousPage) {
    usedCursors.add(startCursor);
    // The cursor travels as -f, a raw string: -F would read one starting `@` as a file name.
    const { repository, reason } = readDetailCall(
      exec,
      ['api', 'graphql', '-F', `number=${number}`, '-f', `before=${startCursor}`, '-f', `query=${commentPageQuery()}`],
      'malformed comment page',
    );
    if (!repository) return { comments, commentCount, commentsUnavailable: reason };
    const page = repository.issue?.comments;
    if (
      repository.issue?.number !== number
      || !isCommentPage(page)
      || page.nodes.length === 0
      || page.nodes.length > commentCount - comments.length
      || (page.pageInfo.hasPreviousPage && usedCursors.has(page.pageInfo.startCursor))
    ) {
      return { comments, commentCount, commentsUnavailable: 'malformed comment page' };
    }
    if (page.totalCount !== commentCount) {
      return { comments, commentCount, commentsUnavailable: 'comment count changed while reading' };
    }
    comments = [...page.nodes.map((node) => node.body), ...comments];
    ({ hasPreviousPage, startCursor } = page.pageInfo);
  }
  const commentsUnavailable = comments.length < commentCount
    ? `GitHub reported ${commentCount} comment(s) but ${comments.length} were read`
    : null;
  return { comments, commentCount, commentsUnavailable };
}

function cardDetail(exec, number, issue) {
  const unavailable = (reason) => ({ number, unavailable: reason });
  if (!isObject(issue)) return unavailable('GitHub returned no issue for this card');
  if (issue.number !== number) {
    return unavailable(Number.isInteger(issue.number)
      ? `GitHub returned issue #${issue.number} for this card`
      : 'GitHub returned a different issue for this card');
  }
  if (typeof issue.body !== 'string') return unavailable('malformed detail: body');
  const { parent, comments: firstPage } = issue;
  if (parent !== null && !(Number.isInteger(parent?.number) && parent.number > 0)) return unavailable('malformed detail: parent');
  if (
    !isCommentPage(firstPage)
    || (!firstPage.pageInfo.hasPreviousPage && firstPage.nodes.length < firstPage.totalCount)
  ) {
    return unavailable('malformed detail: comments');
  }
  return { number, body: issue.body, parent: parent?.number ?? null, ...readOlderComments(exec, number, firstPage) };
}

// Writes one entry per card of the batch, in card order. A batch whose reply was too large
// to read is read again as two halves.
function readDetailBatch(exec, batch, details) {
  const { repository, reason, tooLarge } = readDetailCall(
    exec,
    ['api', 'graphql', '-f', `query=${cardDetailsQuery(batch)}`],
    'malformed detail response',
  );
  if (tooLarge && batch.length > 1) {
    const half = Math.ceil(batch.length / 2);
    readDetailBatch(exec, batch.slice(0, half), details);
    readDetailBatch(exec, batch.slice(half), details);
    return;
  }
  for (const number of batch) {
    details.set(number, repository
      ? cardDetail(exec, number, repository[`i${number}`])
      : { number, unavailable: reason });
  }
}

// Every requested card gets exactly one entry: its details, or the reason they are
// unavailable. A detail that was not read is never an empty body or zero comments, and
// nothing is retried, except that a batch too large to read is read again in halves, down
// to one card, so only a card whose own reply is too large is lost. Each call goes through
// the injected executor, so the transport stays at the CLI edge.
export function fetchCardDetails(exec, numbers) {
  const details = new Map();
  for (let start = 0; start < numbers.length; start += DETAIL_BATCH_SIZE) {
    readDetailBatch(exec, numbers.slice(start, start + DETAIL_BATCH_SIZE), details);
  }
  return details;
}

// The exit status of `--intake` alone; other board-scan modes keep scanOutcome's.
// Approval checks have their own outcomes. 1 stays the rejected argument, so no outcome of a read reuses it.
export const INTAKE_EXIT = Object.freeze({ complete: 0, readFailed: 2, drift: 3, incomplete: 4, driftAndIncomplete: 5 });

const LINE_BREAK = /\r\n|\n|\r/;

// Board metadata is printed on the command's own lines, so each run of line breaks in it
// becomes one space: a title or an option name can never start a line of its own.
const LINE_BREAK_RUNS = new RegExp(`(?:${LINE_BREAK.source})+`, 'g');
const oneLine = (text) => text.replace(LINE_BREAK_RUNS, ' ');

// The longest run of a card-text line one printed line carries, in code points, so that
// no printed card-text line exceeds 1,003 characters with its `|+ ` prefix.
const CARD_TEXT_PIECE = 1000;

// One card-text line → the lines printed for it. Card text always starts `| ` (`|` for
// an empty line), so it can never begin a line the command prints itself, and a line
// longer than one piece continues on `|+ ` lines: dropping the prefixes and joining the
// pieces gives the line back exactly. A cut falls after the last space of its piece when
// the piece has one.
export function foldCardTextLine(line) {
  if (line === '') return ['|'];
  const pieces = [];
  let rest = [...line];
  while (rest.length > CARD_TEXT_PIECE) {
    const cut = rest.slice(0, CARD_TEXT_PIECE).lastIndexOf(' ') + 1 || CARD_TEXT_PIECE;
    pieces.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
  }
  pieces.push(rest.join(''));
  return pieces.map((piece, index) => `${index === 0 ? '|' : '|+'} ${piece}`);
}

const cardText = (text) => text.split(LINE_BREAK).flatMap(foldCardTextLine);

export const isClaim = (comment) => comment.trimStart().startsWith('Claim:');

// The newest Claim comment among those read, which is the latest claim even when older
// pages failed. With none found, only a complete read may say there is none.
export function claimLines({ comments, commentCount, commentsUnavailable }) {
  const index = comments.findLastIndex(isClaim);
  if (index >= 0) {
    const position = commentCount - comments.length + index + 1;
    return [`claim: comment ${position} of ${commentCount}`, ...foldCardTextLine(comments[index].trimStart().split(LINE_BREAK)[0])];
  }
  if (commentsUnavailable !== null) {
    return [`claim: UNAVAILABLE — no Claim in the newest ${comments.length} of ${commentCount} comment(s) and the older ones were not read`];
  }
  return [`claim: none in ${commentCount} comment(s)`];
}

function commentLines({ comments, commentCount, commentsUnavailable }) {
  const heading = commentsUnavailable === null
    ? `comments: ${commentCount}`
    : `comments: ${commentCount}, UNAVAILABLE before the newest ${comments.length} — ${commentsUnavailable}`;
  return [
    heading,
    ...comments.flatMap((comment, index) => [
      `--- comment ${commentCount - comments.length + index + 1} of ${commentCount} ---`,
      ...cardText(comment),
    ]),
  ];
}

function bodyLines(body) {
  if (body.trim() === '') return ['body: empty'];
  return [`body: ${body.split(LINE_BREAK).length} line(s)`, ...cardText(body)];
}

// One card's board lines: its heading and routing, then its open blockers and assignees.
function cardFacts(card) {
  return {
    heading: [
      oneLine(`=== ${cardRef(card.number)} [${card.status}] ${card.title} ===`),
      ...(ROUTING_FIELD ? [oneLine(`${ROUTING_FIELD}: ${card.routing || 'none'}`)] : []),
    ],
    blockers: `open blockers: ${card.openBlockers.length > 0 ? card.openBlockers.map(cardRef).join(', ') : 'none'}`,
    assignees: oneLine(`assignees: ${card.assignees.length > 0 ? card.assignees.map((login) => `@${login}`).join(', ') : 'none'}`),
  };
}

const parentLine = (detail) => `parent: ${detail.parent === null ? 'none' : cardRef(detail.parent)}`;

const claimSection = (detail) => (detail.claim === undefined ? claimLines(detail) : [`claim: ${detail.claim}`]);

// One card's section. A card whose details were not read prints its board lines and the
// reason and nothing else, so a missing detail never reads as present or empty.
function cardSection(card, detail) {
  const { heading, blockers, assignees } = cardFacts(card);
  if (detail.unavailable !== undefined) return [...heading, blockers, assignees, `details: UNAVAILABLE — ${detail.unavailable}`];
  return [
    ...heading,
    parentLine(detail),
    blockers,
    assignees,
    ...claimSection(detail),
    ...bodyLines(detail.body),
    ...commentLines(detail),
  ];
}

const CARD_TEXT_LEGEND = 'Lines starting "| " are card text, and "|+ " continues the line above it.';

// The file name of a card's text, or null for an id that is not a safe file name: a positive
// safe integer or an identifier such as ENG-12, never a path.
export function intakeCardFileName(id) {
  const safe = typeof id === 'number' ? Number.isSafeInteger(id) && id > 0 : typeof id === 'string' && LINEAR_IDENTIFIER.test(id);
  return safe ? `${id}.txt` : null;
}

// The file of every card whose details were read: its name (null when the id is not a safe file
// name) and its lines, the legend then the card's whole section.
export function intakeCardFiles({ candidates, claims, details }) {
  return [...candidates, ...claims].flatMap((card) => {
    const detail = details.get(card.number);
    if (detail.unavailable !== undefined) return [];
    return [{ number: card.number, name: intakeCardFileName(card.number), lines: [CARD_TEXT_LEGEND, ...cardSection(card, detail)] }];
  });
}

// The newest comments read that open with `Needs owner:`, each whole, under a heading that
// says whether every comment was read. A tracker whose comments carry a metadata line before
// the text sets `ownerQuestions` to the advisory it prints instead of a count it cannot make.
function ownerQuestionLines({ comments, commentCount, commentsUnavailable, ownerQuestions }) {
  if (ownerQuestions !== undefined) return [`owner questions: ${ownerQuestions}`];
  const found = comments.flatMap((comment, index) => (comment.trimStart().startsWith('Needs owner:') ? [{ comment, index }] : []));
  const heading = commentsUnavailable === null
    ? `owner questions: ${found.length}`
    : `owner questions: ${found.length} in the newest ${comments.length} of ${commentCount} comment(s), UNAVAILABLE before them — ${commentsUnavailable}`;
  return [
    heading,
    ...found.flatMap(({ comment, index }) => [
      `--- comment ${commentCount - comments.length + index + 1} of ${commentCount} ---`,
      ...cardText(comment),
    ]),
  ];
}

// CommonMark: an ATX heading has 0 to 3 leading spaces, and a line inside a fenced code block (opened
// by 3+ backticks or tildes with 0 to 3 leading spaces, closed by a line of the same character at least
// as long) is never a heading.
const WHAT_TO_BUILD_HEADING = /^ {0,3}(#{1,6})\s+What to build\s*#*\s*$/i;
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

// Whether each line is part of a fenced code block, its fences included, and whether a fence is still open at
// the end (CommonMark closes it with its container, which a line scan cannot see). A closer holds only spaces
// or tabs after its run.
function fencedLines(lines) {
  let open = null;
  const fenced = lines.map((line) => {
    const run = FENCE.exec(line)?.[1];
    if (open === null) {
      open = run ?? null;
      return open !== null;
    }
    if (run !== undefined && run[0] === open[0] && run.length >= open.length && new RegExp(`^ {0,3}${run}[ \\t]*$`).test(line)) open = null;
    return true;
  });
  return { fenced, left: open !== null };
}

const NO_WHAT_TO_BUILD = ['what to build: none in the card text'];
const FENCE_LEFT_OPEN = ['what to build: a code fence is left open, read the card text'];

// A section's lines without the blank lines around them.
function sectionLines(section) {
  const first = section.findIndex((line) => line.trim() !== '');
  if (first < 0) return NO_WHAT_TO_BUILD;
  const trimmed = section.slice(first, section.findLastIndex((line) => line.trim() !== '') + 1);
  return [`what to build: ${trimmed.length} line(s)`, ...trimmed.flatMap(foldCardTextLine)];
}

// The What to build section: the detail's own `whatToBuild` when its tracker extracts it (a native
// document has no Markdown headings to find), the advisory in its `whatToBuildUnread` when it cannot, else
// the body's lines after its heading up to the next heading of the same or a higher level, or the advisory
// that a fence is left open in the body.
function whatToBuildLines(detail) {
  if (Object.hasOwn(detail, 'whatToBuildUnread')) return [`what to build: ${detail.whatToBuildUnread}, read the card text`];
  if (Object.hasOwn(detail, 'whatToBuild')) return detail.whatToBuild === null ? NO_WHAT_TO_BUILD : sectionLines(detail.whatToBuild.split(LINE_BREAK));
  if (detail.bodyFormat === 'html') return ['what to build: not extracted from an HTML body, read the card text'];
  const bodyText = detail.body.split(LINE_BREAK);
  const { fenced, left } = fencedLines(bodyText);
  if (left) return FENCE_LEFT_OPEN;
  const start = bodyText.findIndex((line, index) => !fenced[index] && WHAT_TO_BUILD_HEADING.test(line));
  if (start < 0) return NO_WHAT_TO_BUILD;
  const level = WHAT_TO_BUILD_HEADING.exec(bodyText[start])[1].length;
  const nextHeading = new RegExp(`^ {0,3}#{1,${level}}\\s`);
  const after = bodyText.slice(start + 1);
  const end = after.findIndex((line, index) => !fenced[start + 1 + index] && nextHeading.test(line));
  return sectionLines(end < 0 ? after : after.slice(0, end));
}

// One card's summary: its facts, claim, owner questions and What to build section, and the file
// holding the rest. A card whose details were not read keeps the lines its section prints.
function summarySection(card, detail, file, directory) {
  if (detail.unavailable !== undefined) return cardSection(card, detail);
  const { heading, blockers, assignees } = cardFacts(card);
  return [
    ...heading,
    parentLine(detail),
    blockers,
    assignees,
    `proposal: ${typeof card.title === 'string' && card.title.trimStart().startsWith('Proposed: ') ? 'yes' : 'no'}`,
    ...claimSection(detail),
    ...ownerQuestionLines(detail),
    ...whatToBuildLines(detail),
    `card text: ${join(directory, file.name)}, ${file.lines.length} line(s)`,
  ];
}

// Every line of the `--intake` stdout: the pick listing, then one summary per card, then the
// end line that counts every line including itself. `files` maps each card number to the
// `{ name, lines }` of its written text file.
export function intakeSummary({ listing, candidates, claims, numberless, details, directory, files }) {
  const noNumber = numberless > 0 ? ` ${numberless} card(s) with no issue number have no details.` : '';
  const lines = [
    ...listing.split('\n'),
    '',
    `Card summaries: ${candidates.length} pickable card(s), then ${claims.length} claimed card(s) with no closing pull request.${noNumber}`,
    `${CARD_TEXT_LEGEND} Each card's full body and comments are in the file its "card text:" line names.`,
    ...[...candidates, ...claims].flatMap((card) => ['', ...summarySection(card, details.get(card.number), files.get(card.number), directory)]),
    '',
  ];
  return [...lines, `board intake: end of document, ${lines.length + 1} line(s).`];
}

const isParked = (i) => PARKED_LANE != null && i.lane === PARKED_LANE.option;

// The PICKABLE_STATUSES columns only — never an in-flight or terminal one, and never a
// card parked in the configured PARKED_LANE.
export function pickable(items) {
  return items.filter((i) => PICKABLE_STATUSES.includes(i.status) && !isParked(i));
}

// The pickable-column cards the parked lane holds back, so the pick view can name them
// rather than let them vanish. Empty when no parked lane is configured.
export function parked(items) {
  return items.filter((i) => PICKABLE_STATUSES.includes(i.status) && isParked(i));
}

// The line naming the parked cards, or null. Only the pick view hides parked cards, so
// only it names them; a column or --all listing still shows them where they sit.
export function parkedLine(items, args) {
  const held = args.all || args.status ? [] : parked(items);
  if (held.length === 0) return null;
  const numbers = held.map((i) => i.content?.number ?? null)
    .sort(compareCardIds)
    .map((n) => (n == null ? '#?' : cardRef(n)));
  return `Parked (${PARKED_LANE.field}: ${PARKED_LANE.option}), not pickable: ${numbers.join(', ')}`;
}

// `ProjectV2ItemContent` is a closed union of DraftIssue | Issue | PullRequest, and
// boardQuery asks for `number` only `... on Issue`: a draft or a pull-request card
// is numberless by design. Any other numberless card is a content that did not resolve
// on this read, which a caller must never read as "no such card" (#572).
const NUMBERLESS_CONTENT_TYPES = new Set(['DraftIssue', 'PullRequest']);

// A predicate, not a normalizeItem field: `board --json` prints normalizeItem's output
// verbatim, so this internal read-quality signal stays out of that published shape.
export function isContentUnresolved(i) {
  return (i.content?.number ?? null) == null && !NUMBERLESS_CONTENT_TYPES.has(i.content?.__typename);
}

// Flatten a raw board item to the fields the board rules judge a card on. Only the
// OPEN blockers survive: a closed blocker blocks nothing, and every caller asks the
// same question of the list.
export function normalizeItem(i) {
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    number: i.content?.number ?? null,
    status: i.status ?? null,
    title: i.title ?? '',
    routing: i.routing ?? null,
    parked: isParked(i),
    labels: list(i.labels),
    ...(KIND_TYPES ? { issueType: i.issueType ?? null } : {}),
    state: i.content?.state ?? null,
    assignees: list(i.assignees),
    openBlockers: list(i.blockers).filter((b) => b.state === 'OPEN').map((b) => b.number),
    closingPullRequests: list(i.closingPullRequests),
    subIssues: i.content?.subIssuesSummary ?? null,
    // A markdown card's claim is a job branch, not an assignee; only that tracker's items carry it.
    ...(i.jobBranch ? { jobBranch: i.jobBranch } : {}),
  };
}

// The last pickable column first — PICKABLE_STATUSES is in board order, so that is the
// one nearest being worked — then ascending issue number (nulls last). Every other
// column keeps the rank it had: this orders a pick view, it does not rank the board.
const NEXT_UP_STATUS = PICKABLE_STATUSES[PICKABLE_STATUSES.length - 1];

export function sortForDisplay(items) {
  const rank = (s) => (s === NEXT_UP_STATUS ? 0 : 1);
  const num = (i) => (i.content?.number ?? null);
  return [...items].sort((a, b) => rank(a.status) - rank(b.status) || compareCardIds(num(a), num(b)));
}

// One item → the two-line routing view (`#N [Status] Title` + its labels, led by its issue type
// where the configuration chooses native types).
export function formatRow(i) {
  const n = normalizeItem(i);
  const num = n.number == null ? '#?' : cardRef(n.number);
  const shown = KIND_TYPES ? [n.issueType ?? 'no issue type', ...n.labels] : n.labels;
  const labels = shown.length ? shown.join(', ') : '—';
  return `${oneLine(`${num} [${n.status}] ${n.title}`)}\n    ${oneLine(labels)}`;
}

// A pre-selected list → the sorted, formatted block. Selection (pickable/status)
// is the caller's job; this only orders + renders what it is given.
export function formatList(items) {
  return sortForDisplay(items).map(formatRow).join('\n');
}

// The FIRST routing option leads, deliberately: /resume Step 1 ranks candidates by
// code-parallelization, which is blind to work with no src/ file — that option's items
// never win a candidate slot even when top priority. Grouping surfaces every front each
// session instead of letting the code-less one disappear behind the code-heavy ones.
// That priority is why ROUTING_OPTIONS is a display order, not the board's own.

// Item list → ordered `{ routing, items }` groups: known ROUTING_OPTIONS
// values first (in that order), then unrecognised values (alphabetical, so a
// new board field value still surfaces rather than vanishing), then a
// trailing `Unfielded` group for items with no routing value. Empty groups are
// omitted; no item is ever dropped.
export function groupByRouting(items) {
  const known = new Map(ROUTING_OPTIONS.map((w) => [w, []]));
  const unknown = new Map();
  const unfielded = [];

  for (const i of items) {
    // Through normalizeItem, never `i.routing` directly — that flatten is the
    // ONE place the raw gh payload shape is decoded (formatRow goes through it
    // too). A second decoder here would silently group everything as Unfielded
    // if the field ever moves. `|| null` not `??`: an empty-string field is
    // unfielded, not an unnamed group.
    const w = normalizeItem(i).routing || null;
    if (w == null) {
      unfielded.push(i);
    } else if (known.has(w)) {
      known.get(w).push(i);
    } else {
      if (!unknown.has(w)) unknown.set(w, []);
      unknown.get(w).push(i);
    }
  }

  const groups = [];
  for (const w of ROUTING_OPTIONS) {
    const its = known.get(w);
    if (its.length > 0) groups.push({ routing: w, items: its });
  }
  for (const w of [...unknown.keys()].sort()) {
    groups.push({ routing: w, items: unknown.get(w) });
  }
  if (unfielded.length > 0) groups.push({ routing: 'Unfielded', items: unfielded });

  return groups;
}

// Grouped pretty block: a labelled heading per routing value, then that group's
// rows via the EXISTING formatList (keeps per-group sorting + render logic
// single-sourced — no duplicated row rendering). A board with no routing field has
// nothing to group by, so it gets the plain formatList block.
export function formatGrouped(items) {
  if (!ROUTING_FIELD) return formatList(items);
  const groups = groupByRouting(items);
  const body = groups
    .map((g) => `${oneLine(`── ${g.routing} (${g.items.length}) ──`)}\n${formatList(g.items)}`)
    .join('\n\n');
  const unknown = [...new Set(
    items.map(normalizeItem)
      .map((i) => i.routing)
      .filter((w) => w && !ROUTING_OPTIONS.includes(w)),
  )].sort();
  if (unknown.length === 0) return body;

  // Keep the repository-owned priority and low-cost read; newly seen values must fail loud.
  const values = unknown.join(', ');
  const label = unknown.length === 1 ? 'value' : 'values';
  return `${body}\n\n${oneLine(`WARNING: unrecognised ${ROUTING_FIELD} ${label}: ${values}; add ${values} to ROUTING_OPTIONS in scripts/lib/board-config.mjs.`)}`;
}
