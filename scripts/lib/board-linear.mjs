// board-linear.mjs — the Linear tracker's board reader: a Linear team read as the same raw board items
// the GitHub tracker feeds the board rules, and the card details the intake document prints.
//
// A card is identified by its Linear identifier (ENG-123), so every field the other trackers call a
// number carries that string. The team's states map onto the board's columns through
// LINEAR_STATES in board-config.mjs; a completed, canceled or duplicate state reads as the Done column
// with state CLOSED, and any state outside the mapping reads as no column. Linear is reached through an
// injected executor `exec(query, variables) -> data`, which throws an Error carrying the cause, so the
// whole file is unit-testable. A misconfigured team or a list Linear cut short fails the read; nothing
// reads as a partial board. docs/LINEAR-CARDS.md owns the setup and what each card step becomes.

import * as boardConfig from './board-config.mjs';
import { linearExec } from './linear-api.mjs';
import { LINEAR_IDENTIFIER } from './tracker.mjs';

export const CLOSED_TYPES = new Set(['completed', 'canceled', 'duplicate']);
const [DONE] = boardConfig.TERMINAL_STATUSES;
const REVIEW = 'In review';
// The state type Linear gives each board column's state.
const COLUMN_STATE_TYPES = { 'Backlog': 'backlog', 'Ready': 'unstarted', 'In progress': 'started', 'Awaiting push': 'started', [REVIEW]: 'started', [DONE]: 'completed' };

const itemState = (state) => (CLOSED_TYPES.has(state.type) ? 'CLOSED' : 'OPEN');

export const linearTeamKey = () => boardConfig.LINEAR_TEAM;

// Linear refused the unbounded read as too complex (its default page of 50 teams multiplies the states and rules);
// two teams are enough to see a second one for the not-one refusal.
const TEAM_QUERY =
  'query($key: String!) { teams(first: 2, filter: { key: { eq: $key } }) { nodes { id key states(first: 100) { nodes { id name type } pageInfo { hasNextPage } } gitAutomationStates(first: 50) { nodes { event state { id } targetBranch { branchPattern isRegex } } pageInfo { hasNextPage } } } } }';

// Linear's complexity estimate is about 120 points an issue, so this 50-issue page costs about 6,000 of the 10,000 a query may cost.
// An attachment's metadata.linkKind is `closes` for a closing link and `contributes` for a mentioning one (`Refs`).
const ISSUES_QUERY = `query($key: String!, $after: String) { issues(first: 50, after: $after, filter: { team: { key: { eq: $key } } }) {
  nodes { id identifier title state { id name type } assignee { displayName }
    labels(first: 20) { nodes { name } pageInfo { hasNextPage } }
    inverseRelations(first: 20) { nodes { type issue { identifier state { type } } } pageInfo { hasNextPage } }
    attachments(first: 20) { nodes { url metadata } pageInfo { hasNextPage } } }
  pageInfo { hasNextPage endCursor } } }`;

// Archived children count, as GitHub's sub-issue summary counts them.
const CHILDREN_QUERY =
  'query($key: String!, $after: String) { issues(first: 50, after: $after, filter: { parent: { team: { key: { eq: $key } } } }, includeArchived: true) { nodes { identifier parent { identifier } state { type } } pageInfo { hasNextPage endCursor } } }';

const ISSUE_QUERY = 'query($id: String!) { issue(id: $id) { id identifier team { key } state { id name type } } }';

const MOVE_MUTATION =
  'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { issue { id identifier state { id name type } } } }';

const CARD_QUERY =
  'query($id: String!, $after: String) { issue(id: $id) { identifier description parent { identifier } comments(first: 50, after: $after) { nodes { id body createdAt } pageInfo { hasNextPage endCursor } } } }';

// Yields the data of each page of one connection, following its cursor until no page remains.
export function* pages(exec, query, variables, connectionOf) {
  let after = null;
  const given = new Set();
  do {
    const data = exec(query, { ...variables, after });
    yield data;
    const { pageInfo } = connectionOf(data);
    if (pageInfo.hasNextPage && (typeof pageInfo.endCursor !== 'string' || pageInfo.endCursor === '')) {
      throw new Error('Linear reported another page without a cursor, so the read is incomplete');
    }
    if (pageInfo.hasNextPage && given.has(pageInfo.endCursor)) {
      throw new Error(`Linear gave back the cursor ${pageInfo.endCursor} a second time, so the read cannot advance`);
    }
    given.add(pageInfo.endCursor);
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after !== null);
}

export const allNodes = (exec, query, variables, connectionOf) =>
  [...pages(exec, query, variables, connectionOf)].flatMap((data) => connectionOf(data).nodes);

const refuse = (subject, problems) => new Error(`${subject}: ${problems.join('; ')}. See "Team setup" in docs/LINEAR-CARDS.md.`);

function configProblems() {
  const { LINEAR_TEAM, LINEAR_STATES, ROUTING_FIELD, PARKED_LANE, STATUS_OPTIONS } = boardConfig;
  const problems = [];
  if (!(typeof LINEAR_TEAM === 'string' && /^[A-Z][A-Z0-9]*$/.test(LINEAR_TEAM))) problems.push('LINEAR_TEAM must be the team key in capitals, such as ENG');
  const names = LINEAR_STATES && typeof LINEAR_STATES === 'object' ? Object.entries(LINEAR_STATES) : null;
  if (names === null) problems.push('LINEAR_STATES must map each board column to a Linear state name');
  else {
    const columns = names.map(([column]) => column);
    if (columns.length !== STATUS_OPTIONS.length || !STATUS_OPTIONS.every((column) => columns.includes(column))) problems.push(`LINEAR_STATES must name exactly the columns ${STATUS_OPTIONS.join(', ')}`);
    const values = names.map(([, name]) => name);
    if (!values.every((name) => typeof name === 'string' && name !== '') || new Set(values).size !== values.length) problems.push('LINEAR_STATES must name a distinct, non-empty state for each column');
  }
  if (ROUTING_FIELD !== null) problems.push('ROUTING_FIELD must be null on Linear');
  if (PARKED_LANE !== null) problems.push('PARKED_LANE must be null on Linear');
  return problems;
}

function stateProblems(team) {
  const problems = [];
  for (const column of boardConfig.STATUS_OPTIONS) {
    const name = boardConfig.LINEAR_STATES[column];
    const matches = team.states.nodes.filter((state) => state.name === name);
    if (matches.length === 0) problems.push(`team ${team.key} has no state named "${name}" for ${column}`);
    else if (matches.length > 1) problems.push(`team ${team.key} has ${matches.length} states named "${name}" for ${column}`);
    else if (matches[0].type !== COLUMN_STATE_TYPES[column]) problems.push(`the state "${name}" for ${column} is of type ${matches[0].type}, not ${COLUMN_STATE_TYPES[column]}`);
  }
  if (team.states.pageInfo.hasNextPage) problems.push(`team ${team.key} has more states than one page holds`);
  if (team.gitAutomationStates.pageInfo.hasNextPage) problems.push(`team ${team.key} has more automation rules than one page holds`);
  return problems;
}

// The rules for pull requests into main: a literal main rule wins over the default rule (no target branch),
// and a regex rule cannot be checked, so it is a mismatch itself. Linear stores no default rule for "No action" and
// refuses a default rule with no state, so an absent rule reads as no action.
function automationProblems(team, stateIdOf) {
  const rules = team.gitAutomationStates.nodes;
  const problems = rules
    .filter((rule) => rule.targetBranch?.isRegex)
    .map((rule) => `the ${rule.event} rule for target branch "${rule.targetBranch.branchPattern}" is a regex (regular expression), which cannot be checked`);
  const effective = (event) => {
    const forEvent = rules.filter((rule) => rule.event === event);
    return forEvent.find((rule) => rule.targetBranch?.isRegex === false && rule.targetBranch.branchPattern === 'main') ?? forEvent.find((rule) => rule.targetBranch === null);
  };
  const review = stateIdOf(REVIEW);
  for (const [event, wanted, wantedName] of [['draft', null, 'take no action'], ['start', review, `move cards to ${REVIEW}`], ['merge', stateIdOf(DONE), `move cards to ${DONE}`]]) {
    const rule = effective(event);
    if (rule === undefined && wanted !== null) problems.push(`there is no ${event} rule, which must ${wantedName}`);
    else if ((rule?.state?.id ?? null) !== wanted) problems.push(`the ${event} rule must ${wantedName}`);
  }
  for (const event of ['review', 'mergeable']) {
    const state = effective(event)?.state;
    if (state && state.id !== review) problems.push(`the ${event} rule must take no action or move cards to ${REVIEW}`);
  }
  return problems;
}

// The configured team: its id, its key, the id of the state each board column maps to, and the column
// an issue's state reads as. A configuration, state or automation rule that does not match refuses.
export function readLinearTeam(exec = linearExec) {
  const configured = configProblems();
  if (configured.length > 0) throw refuse('Linear configuration in board-config.mjs', configured);
  const { teams } = exec(TEAM_QUERY, { key: boardConfig.LINEAR_TEAM });
  if (teams.nodes.length !== 1) throw new Error(`Linear returned ${teams.nodes.length} teams for the key ${boardConfig.LINEAR_TEAM}, not one; set LINEAR_TEAM in board-config.mjs to a team key the access reaches.`);
  const [team] = teams.nodes;
  const stateIdOf = (column) => team.states.nodes.find((state) => state.name === boardConfig.LINEAR_STATES[column]).id;
  const problems = stateProblems(team);
  // The rules name states by id, so they are checked only against a state mapping that resolved.
  if (problems.length === 0) problems.push(...automationProblems(team, stateIdOf));
  if (problems.length > 0) throw refuse(`Linear team ${team.key}`, problems);
  const columnById = new Map(boardConfig.STATUS_OPTIONS.map((column) => [stateIdOf(column), column]));
  return {
    id: team.id,
    key: team.key,
    stateIdOf,
    columnOf: (state) => (CLOSED_TYPES.has(state.type) ? DONE : (columnById.get(state.id) ?? null)),
  };
}

// Child counts by parent identifier.
function subIssueCounts(exec, key) {
  const counts = new Map();
  for (const child of allNodes(exec, CHILDREN_QUERY, { key }, (data) => data.issues)) {
    const count = counts.get(child.parent.identifier) ?? { total: 0, completed: 0 };
    count.total += 1;
    if (CLOSED_TYPES.has(child.state.type)) count.completed += 1;
    counts.set(child.parent.identifier, count);
  }
  return counts;
}

// An issue of the team whose nested lists came whole, or an Error naming the card and the connection that did not.
function checkedIssue(node, key) {
  if (!LINEAR_IDENTIFIER.test(node.identifier) || !node.identifier.startsWith(`${key}-`)) throw new Error(`Linear returned the identifier ${node.identifier} for team ${key}`);
  for (const connection of ['labels', 'inverseRelations', 'attachments']) {
    if (node[connection].pageInfo.hasNextPage) throw new Error(`${node.identifier} has more ${connection} than one page holds, so the board cannot be read whole`);
  }
  return node;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The team as the raw items the board rules judge.
export function readLinearBoard(exec = linearExec) {
  const team = readLinearTeam(exec);
  const counts = subIssueCounts(exec, team.key);
  const pullRequest = new RegExp(`^https://github\\.com/${escapeRegExp(boardConfig.BOARD_OWNER)}/${escapeRegExp(boardConfig.BOARD_REPOSITORY)}/pull/([1-9]\\d*)$`);
  const items = allNodes(exec, ISSUES_QUERY, { key: team.key }, (data) => data.issues).map((issue) => checkedIssue(issue, team.key)).map((node) => ({
    id: node.id,
    status: team.columnOf(node.state),
    title: node.title,
    routing: null,
    labels: node.labels.nodes.map((label) => label.name),
    assignees: node.assignee ? [node.assignee.displayName] : [],
    blockers: node.inverseRelations.nodes
      .filter((relation) => relation.type === 'blocks')
      .map((relation) => ({ number: relation.issue.identifier, state: itemState(relation.issue.state) })),
    closingPullRequests: node.attachments.nodes
      .filter((attachment) => attachment.metadata?.linkKind === 'closes')
      .map((attachment) => pullRequest.exec(attachment.url))
      .filter(Boolean)
      .map((match) => ({ number: Number(match[1]) })),
    content: {
      __typename: 'Issue',
      number: node.identifier,
      state: itemState(node.state),
      subIssuesSummary: counts.get(node.identifier) ?? { total: 0, completed: 0 },
    },
  }));
  return { items };
}

export const byCreation = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// One card: its comments are every page, oldest first, and every page answers for the identifier asked.
function readCard(exec, id) {
  const commentsOf = (data) => {
    if (data.issue?.identifier !== id) throw new Error(`Linear returned ${data.issue?.identifier ?? 'no issue'} for ${id}`);
    return data.issue.comments;
  };
  const responses = [...pages(exec, CARD_QUERY, { id }, commentsOf)];
  const { issue } = responses[0];
  const comments = responses.flatMap((data) => commentsOf(data).nodes).sort(byCreation).map((comment) => comment.body);
  return {
    number: id,
    body: issue.description ?? '',
    parent: issue.parent?.identifier ?? null,
    comments,
    commentCount: comments.length,
    commentsUnavailable: null,
  };
}

// One entry per identifier, shaped like fetchCardDetails'. A card that cannot be read is marked unavailable
// and the others go on, except at a rate limit, which is terminal: the cards already read keep their details,
// the current and every later card carry the rate-limit message, and nothing further is sent.
export function linearCardDetails(exec, ids) {
  let rateLimit = null;
  const read = (id) => {
    try {
      return readCard(exec, id);
    } catch (error) {
      if (error.rateLimited) rateLimit = error;
      return { number: id, unavailable: error.message };
    }
  };
  return new Map(ids.map((id) => [id, rateLimit === null ? read(id) : { number: id, unavailable: rateLimit.message }]));
}

// The card asked for, read under its own identifier in the configured team, as `{ id, identifier, state }`.
// A card moved to another team answers under its new identifier, so either mismatch refuses.
export function readTeamIssue(id, exec = linearExec) {
  const { issue } = exec(ISSUE_QUERY, { id });
  if (issue.team.key !== boardConfig.LINEAR_TEAM) throw new Error(`${id} belongs to team ${issue.team.key}, not the configured team ${boardConfig.LINEAR_TEAM}`);
  if (issue.identifier !== id) throw new Error(`Linear answered the identifier ${issue.identifier} for ${id}`);
  return { id: issue.id, identifier: issue.identifier, state: issue.state };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// In review and Done are set by Linear's own pull request rules, so they are only checked, never written.
const AUTOMATION_RULES = { [REVIEW]: 'start (the pull request is marked ready)', [DONE]: 'merge' };
const CHECK_READS = 6;
const CHECK_PAUSE_MS = 5000;

// A check Linear has not satisfied after the reads fails, naming the state, the column, the rule and that nothing was written.
function checkedMove(id, column, team, exec, pause) {
  for (let read = 1; ; read += 1) {
    const { state } = readTeamIssue(id, exec);
    if (team.columnOf(state) === column) return { checked: true, movedBy: 'Linear' };
    if (read === CHECK_READS) throw new Error(`${id} is in "${state.name}", not ${column}; Linear's ${AUTOMATION_RULES[column]} rule moves it there, and nothing was written`);
    pause(CHECK_PAUSE_MS);
  }
}

// Moves each `{ issueNumber, statusName }` pair's card to the state its board column maps to, in order, and
// stops at the first failure, naming the moves already completed. A card already in the target state is
// not written, and In review and Done are only checked. Returns the completed pairs, `skipped` set for a card
// already there.
export function moveLinearCards(pairs, exec = linearExec, pause = sleepSync) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('moveLinearCards requires at least one pair');
  const team = readLinearTeam(exec);
  const completed = [];
  for (const { issueNumber, statusName } of pairs) {
    try {
      if (!LINEAR_IDENTIFIER.test(issueNumber)) throw new Error(`invalid issue ID: ${issueNumber}`);
      const column = boardConfig.STATUS_OPTIONS.find((option) => option.toLowerCase() === String(statusName).trim().toLowerCase());
      if (column === undefined) throw new Error(`unknown Status "${statusName}" — valid options: ${boardConfig.STATUS_OPTIONS.join(', ')}`);
      if (column in AUTOMATION_RULES) {
        completed.push({ issueNumber, statusName: column, ...checkedMove(issueNumber, column, team, exec, pause) });
        continue;
      }
      const target = team.stateIdOf(column);
      const issue = readTeamIssue(issueNumber, exec);
      const skipped = issue.state.id === target;
      if (!skipped) {
        const confirmed = exec(MOVE_MUTATION, { id: issue.id, stateId: target }).issueUpdate.issue?.state;
        if (confirmed?.id !== target) throw new Error(`Linear answered the update with ${confirmed ? `the state "${confirmed.name}"` : 'no state'}, not "${boardConfig.LINEAR_STATES[column]}"`);
      }
      completed.push({ issueNumber, statusName: column, skipped });
    } catch (error) {
      const done = completed.map((pair) => `${pair.issueNumber} → ${pair.statusName}`).join(', ') || 'none';
      throw new Error(`failed to move ${issueNumber} → "${statusName}" (already completed: ${done}) — ${error.message}`, { cause: error });
    }
  }
  return completed;
}
