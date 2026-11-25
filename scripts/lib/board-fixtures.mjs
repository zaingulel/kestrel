// Canonical test fixture for the raw boardQuery response shape.
// GitHub's ProjectV2Item.content field is nullable. parseBoardPage then
// normalizes that raw null to content: {}, which downstream tests should reach
// through the real parser rather than spelling a second response shape.
//
// Issue content defaults to the WHOLE shape boardQuery asks for — an OPEN issue in
// the configured repository, an empty sub-issue summary and four empty connections —
// so a test spells out only the field it is about. An explicit `null` is preserved,
// because the malformed shapes the parser's guards exist for are exactly those.

import {
  BOARD_OWNER,
  BOARD_OWNER_TYPE,
  BOARD_PROJECT_NUMBER,
  BOARD_REPOSITORY,
  PARKED_LANE,
  ROUTING_FIELD,
  ROUTING_OPTIONS,
  STATUS_OPTIONS,
} from './board-config.mjs';

function connection(nodes) {
  return { totalCount: nodes.length, nodes };
}

const withDefault = (value, fallback) => (value === undefined ? fallback : value);

// A friendly array → the connection the query returns. Only an array is converted:
// anything else (a hand-built truncated connection, an explicit null) rides through
// untouched so a guard test can spell the malformed shape it needs.
function issueConnection(value, toNode) {
  if (value === undefined) return connection([]);
  if (!Array.isArray(value)) return value;
  return connection(value.map(toNode));
}

const asNode = (node) => node;

// A blocker node names the board's own repository unless the test passes its own key, null included.
const asBlocker = (node) => ({ repository: { nameWithOwner: `${BOARD_OWNER}/${BOARD_REPOSITORY}` }, ...node });

/** @type {(options?: { id?: string, content?: Record<string, unknown> | null, fieldValues?: unknown, title?: string | null, status?: string | null, routing?: string | null, lane?: string | null }) => { id: string, content: Record<string, unknown> | null, fieldValues: ReturnType<typeof connection> }} */
export function leanNode({
  id = 'PVTI_fixture',
  content = null,
  fieldValues,
  title,
  status,
  routing,
  lane,
} = {}) {
  if (lane !== undefined && !PARKED_LANE) {
    throw new Error('leanNode: lane was passed but board-config.mjs configures no PARKED_LANE');
  }
  let normalizedContent = content;
  if (content != null && content.__typename === 'Issue') {
    const { labels, assignees, blockers, closingPullRequests, ...rest } = content;
    normalizedContent = {
      ...rest,
      state: withDefault(rest.state, 'OPEN'),
      repository: withDefault(rest.repository, { nameWithOwner: `${BOARD_OWNER}/${BOARD_REPOSITORY}` }),
      subIssuesSummary: withDefault(rest.subIssuesSummary, { total: 0, completed: 0 }),
      labels: issueConnection(labels, (name) => ({ name })),
      assignees: issueConnection(assignees, (login) => ({ login })),
      blockedBy: issueConnection(blockers, asBlocker),
      closedByPullRequestsReferences: issueConnection(closingPullRequests, asNode),
    };
  }

  const generatedFieldValues = [
    title != null ? { text: title, field: { name: 'Title' } } : null,
    status != null ? { name: status, field: { name: 'Status' } } : null,
    ROUTING_FIELD && routing != null ? { name: routing, field: { name: ROUTING_FIELD } } : null,
    lane != null ? { name: lane, field: { name: /** @type {{ field: string }} */ (/** @type {{ field: string } | null} */ (PARKED_LANE)).field } } : null,
  ].filter(Boolean);
  if (fieldValues !== undefined && generatedFieldValues.length > 0) {
    throw new Error('leanNode: pass either fieldValues or named field shorthands, not both');
  }

  return {
    id,
    content: normalizedContent,
    fieldValues: connection(fieldValues ?? generatedFieldValues),
  };
}

// Fresh objects per page: a guard test mutates the schema it was handed, and a shared
// literal would leak that mutation into every later fixture in the file.
function fieldSchema() {
  return [
    { name: 'Title', dataType: 'TITLE' },
    { name: 'Status', dataType: 'SINGLE_SELECT', options: STATUS_OPTIONS.map((name) => ({ name })) },
    ...(ROUTING_FIELD
      ? [{ name: ROUTING_FIELD, dataType: 'SINGLE_SELECT', options: ROUTING_OPTIONS.map((name) => ({ name })) }]
      : []),
    ...(PARKED_LANE
      ? [{ name: /** @type {{ field: string, option: string }} */ (/** @type {{ field: string, option: string } | null} */ (PARKED_LANE)).field, dataType: 'SINGLE_SELECT', options: [{ name: /** @type {{ field: string, option: string }} */ (/** @type {{ field: string, option: string } | null} */ (PARKED_LANE)).option }] }]
      : []),
  ];
}

/** @type {(nodes: unknown[], options?: { totalCount?: number, pageInfo?: { hasNextPage: boolean, endCursor: string | null } }) => { data: Record<string, { login: string, projectV2: { id: string, number: number, closed: boolean, fields: ReturnType<typeof connection>, items: { totalCount: number, pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: unknown[] } } }> }} */
export function leanBoardPage(
  nodes,
  {
    totalCount = nodes.length,
    pageInfo = { hasNextPage: false, endCursor: null },
  } = {},
) {
  return {
    data: {
      [BOARD_OWNER_TYPE]: {
        login: BOARD_OWNER,
        projectV2: {
          id: 'PVT_fixture',
          number: BOARD_PROJECT_NUMBER,
          closed: false,
          fields: connection(fieldSchema()),
          items: { totalCount, pageInfo, nodes },
        },
      },
    },
  };
}

// Fresh counted issue-side replies preserve malformed values for guard tests.
export function issueItemReply(nodes = [], { issueId = 'I_fixture', totalCount = nodes.length } = {}) {
  return { data: { repository: { issue: { id: issueId, projectItems: { totalCount, nodes: structuredClone(nodes) } } } } };
}

const LAST_PAGE = { hasNextPage: false, endCursor: null };

// The part of the omission advisory every test holds it to: it tells the reader not to add the
// recovered cards to the board again, however the sentence around it is worded.
export const READD_WARNING = /\b(not|never|don't)\b[^.\n]*\b(re-?add|add)\b/i;

// One project membership as the issue side reports it: an unarchived item on the configured
// board unless `project`, `owner` or `isArchived` says otherwise.
export function membership(id, { isArchived = false, project = BOARD_PROJECT_NUMBER, owner = BOARD_OWNER } = {}) {
  return { id, isArchived, project: { number: project, owner: { login: owner } } };
}

// One issue of the repository issue walk with its first page of memberships, counted whole
// unless `totalCount` says GitHub holds more.
export function walkedIssue(number, memberships, { totalCount = memberships.length } = {}) {
  return { number, projectItems: { totalCount, nodes: memberships } };
}

// One page of the repository issue walk; `--slurp` hands the reader a list of these.
export function issuesPage(issues, { totalCount = issues.length, pageInfo = LAST_PAGE } = {}) {
  return { data: { repository: { issues: { totalCount, pageInfo, nodes: issues } } } };
}

// One page of an overflowing issue's own membership walk; `--slurp` hands a list of these too.
export function membershipsPage(number, memberships, { totalCount = memberships.length, pageInfo = LAST_PAGE } = {}) {
  return { data: { repository: { issue: { number, projectItems: { totalCount, pageInfo, nodes: memberships } } } } };
}

// A board item as the hydration by id answers it: leanNode's card fields plus the item's own
// project identity and archive flag.
export function hydratedItem(card, { isArchived = false, project = BOARD_PROJECT_NUMBER, owner = BOARD_OWNER } = {}) {
  return { ...leanNode(card), isArchived, project: { number: project, owner: { login: owner } } };
}

// Which board-read request an argv is, by the connection its query asks for: the project walk
// (`board`), the repository issue walk (`issues`), its second, recently updated walk (`closedIssues`, the one carrying a `filterBy`), an overflowing issue's membership walk
// (`memberships`, an `issue(number:` query that includes archived items) and the hydration of
// item ids (`items`). Every other request, the card-detail and issue-side probe reads among
// them, is `other`.
export function boardRequestKind(args) {
  const query = args.find((arg) => arg.startsWith('query=')) ?? '';
  if (/\bnodes\(ids:/.test(query)) return 'items';
  if (/\bissues\(/.test(query) && /filterBy:/.test(query)) return 'closedIssues';
  if (/\bissues\(/.test(query)) return 'issues';
  if (/\bissue\(number:/.test(query) && /includeArchived:\s*true/.test(query)) return 'memberships';
  if (/\bprojectV2\(number:/.test(query) && /\bitems\(first:/.test(query)) return 'board';
  return 'other';
}

// A reply value as the executor prints it: a function is called with the argv first, so it can
// throw as a failing `gh` does, and a string rides through untouched so a guard test can hand
// over bytes that are not JSON.
function replyText(value, args) {
  if (typeof value === 'function') return replyText(value(args), args);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// The hydration reply: each `PVTI_` id the request names, in the order it names them, answered
// from `items` by id, and null for an id the fixture does not hold, as GitHub answers one.
function hydrationReply(items, args) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const asked = args.join(' ').match(/PVTI_[A-Za-z0-9_-]+/g) ?? [];
  return { data: { nodes: asked.map((id) => structuredClone(byId.get(id) ?? null)) } };
}

// An executor for the GitHub board read that answers each request kind from its own reply and
// records every argv. `board` is the slurped project walk; `issues` the slurped repository issue
// walk, by default one empty page; `closedIssues` the slurped recently updated issue walk, open and closed, likewise; `items` the hydratable board items, or a reply; `memberships`
// each overflowing issue's slurped walk by number; `other` answers every other request. A request
// with no reply throws, so an unanticipated read fails loud instead of being guessed at.
/** @type {(options?: { board?: unknown, issues?: unknown, closedIssues?: unknown, items?: unknown, memberships?: Record<string, unknown>, other?: unknown }) => { exec: (args: string[]) => string, calls: string[][] }} */
export function boardReadExec({ board, issues = [issuesPage([])], closedIssues = [issuesPage([])], items = [], memberships = {}, other } = {}) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    const kind = boardRequestKind(args);
    if (kind === 'board' && board !== undefined) return replyText(board, args);
    if (kind === 'issues') return replyText(issues, args);
    if (kind === 'closedIssues') return replyText(closedIssues, args);
    if (kind === 'items') return replyText(Array.isArray(items) ? hydrationReply(items, args) : items, args);
    if (kind === 'memberships') {
      const number = args.join(' ').match(/issue\(number:(\d+)\)|\bnumber=(\d+)/);
      const reply = memberships[number?.[1] ?? number?.[2]];
      if (reply !== undefined) return replyText(reply, args);
    }
    if (kind === 'other' && other !== undefined) return replyText(other, args);
    throw new Error(`unexpected gh invocation (${kind}): ${args.join(' ')}`);
  };
  return { exec, calls };
}

// The first object holding a `pageInfo` in a reply page: the connection the page walks.
function pageInfoOf(node) {
  if (node === null || typeof node !== 'object') return undefined;
  if (node.pageInfo !== undefined) return node.pageInfo;
  for (const child of Object.values(node)) {
    const found = pageInfoOf(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

// An executor that serves a marked one-page-per-request reader from `exec`, which answers the slurped walk as today:
// a graphql call without a cursor is sent to `exec` as its `--paginate --slurp` form and answered with the first page,
// and one carrying `-f endCursor=C` with the page after the one whose `pageInfo.endCursor` is C. Any other call passes
// through unchanged: the walks are the four kinds `boardRequestKind` names `board`, `issues`, `closedIssues` and `memberships`.
export function onePageAtATime(exec) {
  const paged = (args) => {
    if (args[0] !== 'api' || args[1] !== 'graphql' || !['board', 'issues', 'closedIssues', 'memberships'].includes(boardRequestKind(args))) return exec(args);
    const cursorAt = args.findIndex((arg) => arg.startsWith('endCursor='));
    const cursor = cursorAt < 0 ? undefined : args[cursorAt].slice('endCursor='.length);
    const rest = cursorAt < 0 ? args.slice(2) : args.filter((_, i) => i !== cursorAt && i !== cursorAt - 1).slice(2);
    const pages = JSON.parse(exec(['api', 'graphql', '--paginate', '--slurp', ...rest]));
    const after = cursor === undefined ? -1 : pages.findIndex((page) => pageInfoOf(page)?.endCursor === cursor);
    if (cursor !== undefined && after < 0) throw new Error(`onePageAtATime: no page ends at cursor ${cursor}`);
    const index = after + 1;
    return JSON.stringify(pages[index]);
  };
  return Object.assign(paged, { onePagePerRequest: true });
}
