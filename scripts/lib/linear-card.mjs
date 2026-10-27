// linear-card.mjs — the card operations of a Linear board: the card and board reads resume judges a claim by,
// the card text to-issues reads back, filing, and the claim's assignee and comment writes.
//
// Each operation returns its output as rows, and the command prints each row as one JSON.stringify line, so no
// card text can break a line or pass as another row. An operation returns only once every page it reads is in,
// so a failed page leaves nothing printed. Linear is reached through the injected executor
// `exec(query, variables) -> data` that board-linear.mjs uses, which throws an Error carrying the cause, so the
// whole file is unit-testable. Identifiers travel as GraphQL variables, never inside a query.
//
// Every issue a command names is first read in the configured team under its own identifier (readTeamIssue), and
// a write goes to the id that read returned, so no command writes outside the team or to a card moved away and
// answering under another identifier. A comment is edited only by its author, a card another account holds is
// never taken or released, and `create` looks for its exact title in the team before it files anything.
// docs/LINEAR-CARDS.md owns what each card step becomes.

import { readFileSync } from 'node:fs';
import { KIND_LABELS, PICKABLE_STATUSES } from './board-config.mjs';
import { CLOSED_TYPES, allNodes, byCreation, linearTeamKey, pages, readLinearTeam, readTeamIssue } from './board-linear.mjs';
import { linearExec } from './linear-api.mjs';
import { LINEAR_IDENTIFIER, compareCardIds } from './tracker.mjs';

export const isClosedState = (state) => CLOSED_TYPES.has(state.type);

const CARD_QUERY = `query($id: String!, $after: String) { issue(id: $id) { state { type } assignee { displayName }
  comments(first: 50, after: $after) { nodes { id body createdAt url user { displayName } } pageInfo { hasNextPage endCursor } } } }`;

const RELATIONS_QUERY = `query($id: String!, $after: String) { issue(id: $id) { title description parent { identifier }
  inverseRelations(first: 50, after: $after) { nodes { type issue { identifier } } pageInfo { hasNextPage endCursor } } } }`;

const ASSIGNEE_QUERY = 'query($id: String!) { viewer { id displayName } issue(id: $id) { assignee { id displayName } } }';

const PARENT_QUERY = 'query($id: String!) { issue(id: $id) { parent { identifier } } }';

const COMMENT_QUERY = 'query($id: String!) { viewer { id } comment(id: $id) { user { id } issue { identifier team { key } } } }';

const SAME_TITLE_QUERY =
  'query($key: String!, $title: String!, $after: String) { issues(first: 50, after: $after, filter: { team: { key: { eq: $key } }, title: { eq: $title } }) { nodes { identifier } pageInfo { hasNextPage endCursor } } }';

const LABELS_QUERY =
  'query($name: String!, $after: String) { issueLabels(first: 50, after: $after, filter: { name: { eq: $name } }) { nodes { id team { key } } pageInfo { hasNextPage endCursor } } }';

const ISSUE_CREATE = 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }';

const ISSUE_UPDATE =
  'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { assignee { displayName } parent { identifier } } } }';

const RELATION_CREATE =
  'mutation($issueId: String!, $relatedIssueId: String!) { issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: blocks }) { issueRelation { id } } }';

const COMMENT_CREATE = 'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { comment { id url } } }';

const COMMENT_UPDATE = 'mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { comment { id url } } }';

const NO_OP = [['no-op']];

export const USAGE = [
  'usage: node scripts/linear-card.mjs view <ID> [--board]',
  '       node scripts/linear-card.mjs text <ID>',
  '       node scripts/linear-card.mjs comment <ID> (--body <text> | --body-file <file>)',
  '       node scripts/linear-card.mjs edit-comment <comment id> (--body <text> | --body-file <file>)',
  '       node scripts/linear-card.mjs assign <ID>',
  '       node scripts/linear-card.mjs unassign <ID>',
  `       node scripts/linear-card.mjs create --title <title> --body-file <file> --status ${PICKABLE_STATUSES.join('|')} --kind <kind> [--parent <ID>] [--blocked-by <ID>,...]`,
  '       node scripts/linear-card.mjs edit <ID> [--title <title>] [--body-file <file>]',
  '       node scripts/linear-card.mjs parent <ID> --to <epic ID>',
  '       node scripts/linear-card.mjs block <ID> --by <blocker ID>',
  '       an ID is a Linear issue ID such as ENG-123',
].join('\n');

// A comment is named by its Linear id, a UUID.
const COMMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The flags each subcommand takes; `--board` alone takes no value.
const FLAGS = {
  'view': ['--board'],
  'text': [],
  'comment': ['--body', '--body-file'],
  'edit-comment': ['--body', '--body-file'],
  'assign': [],
  'unassign': [],
  'create': ['--title', '--body-file', '--status', '--kind', '--parent', '--blocked-by'],
  'edit': ['--title', '--body-file'],
  'parent': ['--to'],
  'block': ['--by'],
};

function issueId(value, what) {
  if (!LINEAR_IDENTIFIER.test(value ?? '')) throw new Error(`${what} must be a Linear issue ID such as ENG-123, received ${JSON.stringify(value ?? null)}`);
  return value;
}

function bodySource(flags) {
  if (('--body' in flags) === ('--body-file' in flags)) throw new Error('give exactly one of --body and --body-file');
  return '--body' in flags ? { text: flags['--body'] } : { file: flags['--body-file'] };
}

function title(value) {
  if (value.trim() === '') throw new Error('--title must not be blank');
  return value;
}

// The subcommand and its validated arguments, or an Error naming the first problem. Pure: nothing is read or sent.
export function parseCardArgs(args) {
  const [name, ...rest] = args;
  if (!Object.hasOwn(FLAGS, name ?? '')) throw new Error(`unknown subcommand ${JSON.stringify(name ?? null)}`);
  const flags = {};
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (!FLAGS[name].includes(arg)) throw new Error(`${name} takes no ${arg}`);
    if (arg in flags) throw new Error(`${arg} is given twice`);
    if (arg === '--board') {
      flags[arg] = true;
      continue;
    }
    if (index + 1 === rest.length) throw new Error(`${arg} needs a value`);
    index += 1;
    flags[arg] = rest[index];
  }
  const expected = name === 'create' ? 0 : 1;
  if (positionals.length !== expected) throw new Error(`${name} takes ${expected === 0 ? 'no' : 'one'} ID, received ${positionals.length}`);
  const [target] = positionals;

  switch (name) {
    case 'edit-comment':
      if (!COMMENT_ID.test(target)) throw new Error(`edit-comment needs a comment id such as the last value of a view claim line, received ${JSON.stringify(target)}`);
      return { name, commentId: target, body: bodySource(flags) };
    case 'create': {
      for (const flag of ['--title', '--body-file', '--status', '--kind']) {
        if (!(flag in flags)) throw new Error(`create needs ${flag}`);
      }
      if (!PICKABLE_STATUSES.includes(flags['--status'])) throw new Error(`--status must be one of ${PICKABLE_STATUSES.join(', ')}`);
      if (!Object.hasOwn(KIND_LABELS, flags['--kind'])) throw new Error(`--kind must be one of ${Object.keys(KIND_LABELS).join(', ')}`);
      const blockedBy = '--blocked-by' in flags ? flags['--blocked-by'].split(',').map((id) => issueId(id, '--blocked-by')) : [];
      if (new Set(blockedBy).size !== blockedBy.length) throw new Error('--blocked-by names an issue twice');
      return {
        name,
        title: title(flags['--title']),
        bodyFile: flags['--body-file'],
        status: flags['--status'],
        kind: flags['--kind'],
        parent: '--parent' in flags ? issueId(flags['--parent'], '--parent') : null,
        blockedBy,
      };
    }
    default:
      break;
  }
  const id = issueId(target, name);
  switch (name) {
    case 'view':
      return { name, id, board: flags['--board'] === true };
    case 'comment':
      return { name, id, body: bodySource(flags) };
    case 'edit':
      if (!('--title' in flags) && !('--body-file' in flags)) throw new Error('edit needs --title, --body-file or both');
      return { name, id, ...('--title' in flags ? { title: title(flags['--title']) } : {}), ...('--body-file' in flags ? { bodyFile: flags['--body-file'] } : {}) };
    case 'parent':
      return { name, id, to: issueId(flags['--to'], '--to') };
    case 'block':
      return { name, id, by: issueId(flags['--by'], '--by') };
    default:
      return { name, id };
  }
}

function readBodyFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`the body file ${path} could not be read: ${error.code ?? error.message}`);
  }
}

const bodyText = (body) => (body.file === undefined ? body.text : readBodyFile(body.file));

// Every comment of the card, oldest first, numbered by its position among them, and the card read from the first page.
function readComments(exec, id) {
  const responses = [...pages(exec, CARD_QUERY, { id }, (data) => data.issue.comments)];
  const comments = responses
    .flatMap((data) => data.issue.comments.nodes)
    .sort(byCreation)
    .map((comment, index) => ({ ...comment, position: index + 1, author: comment.user === null ? '(integration)' : comment.user.displayName }));
  return { issue: responses[0].issue, comments };
}

// The whitespace resume's card read strips before it looks for "Claim:".
const LEADING_SPACE = /^[ \t\n\v\f\r\p{Z}\uFEFF]+/u;

function claimRow(comment) {
  const text = comment.body.replace(LEADING_SPACE, '');
  if (!text.startsWith('Claim:')) return [];
  return [['claim', comment.position, comment.author, comment.createdAt, comment.url, text.split('\r')[0].split('\n')[0], comment.id]];
}

function view({ id }, exec) {
  readTeamIssue(id, exec);
  const { issue, comments } = readComments(exec, id);
  return [
    ['state', isClosedState(issue.state) ? 'CLOSED' : 'OPEN'],
    ['assignees', issue.assignee === null ? [] : [issue.assignee.displayName]],
    ...comments.flatMap(claimRow),
    ['comments', comments.length],
  ];
}

// A Linear issue is in exactly one team, and readTeamIssue has required it to be the configured one.
function viewBoard({ id }, exec) {
  const team = readLinearTeam(exec);
  const { state } = readTeamIssue(id, exec);
  return [['board', 'linear', team.key, team.columnOf(state)], ['boards', 1]];
}

// The card and every blocker it names, open or closed, over every page of its relations.
function readRelations(exec, id) {
  const responses = [...pages(exec, RELATIONS_QUERY, { id }, (data) => data.issue.inverseRelations)];
  const blockers = responses
    .flatMap((data) => data.issue.inverseRelations.nodes)
    .filter((relation) => relation.type === 'blocks')
    .map((relation) => relation.issue.identifier)
    .sort(compareCardIds);
  return { issue: responses[0].issue, blockers };
}

function text({ id }, exec) {
  readTeamIssue(id, exec);
  const { issue, blockers } = readRelations(exec, id);
  const { comments } = readComments(exec, id);
  return [
    ['title', issue.title],
    ['body', issue.description ?? ''],
    ['parent', issue.parent === null ? null : issue.parent.identifier],
    ['blockedBy', blockers],
    ...comments.map((comment) => ['comment', comment.position, comment.author, comment.createdAt, comment.url, comment.body]),
  ];
}

function comment({ id, body }, exec) {
  const newBody = bodyText(body);
  const issue = readTeamIssue(id, exec);
  const created = exec(COMMENT_CREATE, { issueId: issue.id, body: newBody }).commentCreate.comment;
  return [['comment', created.id, created.url]];
}

// Only the viewer's own comment on an issue of the configured team is edited; an integration's has no author.
function editComment({ commentId, body }, exec) {
  const newBody = bodyText(body);
  const { viewer, comment: target } = exec(COMMENT_QUERY, { id: commentId });
  const { identifier, team } = target.issue;
  if (team.key !== linearTeamKey()) throw new Error(`comment ${commentId} is on ${identifier} in team ${team.key}, not the configured team ${linearTeamKey()}; nothing was written`);
  if (target.user?.id !== viewer.id) {
    throw new Error(`comment ${commentId} on ${identifier} was written by ${target.user === null ? 'an integration' : 'another account'}, and only its author edits it; nothing was written`);
  }
  const updated = exec(COMMENT_UPDATE, { id: commentId, body: newBody }).commentUpdate.comment;
  return [['comment', updated.id, updated.url]];
}

// The issue as Linear answers the update; its schema lets that answer hold no issue.
function update(exec, issue, input) {
  const updated = exec(ISSUE_UPDATE, { id: issue.id, input }).issueUpdate.issue;
  if (updated === null) throw new Error(`Linear answered the update of ${issue.identifier} with no issue`);
  return updated;
}

const assigneesRow = (issue) => ['assignees', issue.assignee === null ? [] : [issue.assignee.displayName]];

// The card, the viewer and the card's assignee; a card another account holds is refused, naming that account.
function heldCard(exec, id) {
  const issue = readTeamIssue(id, exec);
  const { viewer, issue: { assignee } } = exec(ASSIGNEE_QUERY, { id });
  if (assignee !== null && assignee.id !== viewer.id) throw new Error(`${id} is held by ${assignee.displayName}, not by this account (${viewer.displayName}); nothing was written`);
  return { issue, viewer, assignee };
}

function assign({ id }, exec) {
  const { issue, viewer, assignee } = heldCard(exec, id);
  if (assignee !== null) return NO_OP;
  return [assigneesRow(update(exec, issue, { assigneeId: viewer.id }))];
}

function unassign({ id }, exec) {
  const { issue, assignee } = heldCard(exec, id);
  if (assignee === null) return NO_OP;
  return [assigneesRow(update(exec, issue, { assigneeId: null }))];
}

function edit({ id, title: newTitle, bodyFile }, exec) {
  const input = {
    ...(newTitle === undefined ? {} : { title: newTitle }),
    ...(bodyFile === undefined ? {} : { description: readBodyFile(bodyFile) }),
  };
  update(exec, readTeamIssue(id, exec), input);
  return [['edited', id]];
}

function setParent({ id, to }, exec) {
  const issue = readTeamIssue(id, exec);
  const epic = readTeamIssue(to, exec);
  if (exec(PARENT_QUERY, { id }).issue.parent?.identifier === to) return NO_OP;
  const { parent } = update(exec, issue, { parentId: epic.id });
  return [['parent', id, parent === null ? null : parent.identifier]];
}

function block({ id, by }, exec) {
  const issue = readTeamIssue(id, exec);
  const blocker = readTeamIssue(by, exec);
  if (readRelations(exec, id).blockers.includes(by)) return NO_OP;
  exec(RELATION_CREATE, { issueId: blocker.id, relatedIssueId: issue.id });
  return [['block', id, by]];
}

// The one label of the kind's name that belongs to the team or to the whole workspace.
function kindLabelId(exec, team, kind) {
  const name = KIND_LABELS[kind];
  const labels = allNodes(exec, LABELS_QUERY, { name }, (data) => data.issueLabels)
    .filter((label) => label.team === null || label.team.key === team.key);
  if (labels.length !== 1) {
    throw new Error(`team ${team.key} and its workspace hold ${labels.length} labels named "${name}", not one; see "Team setup" in docs/LINEAR-CARDS.md`);
  }
  return labels[0].id;
}

// One issueCreate carries the state, the kind label and the parent; the blockers follow as relations. Nothing is
// written while the team holds the title already, so a create that failed or went unconfirmed is safe to re-run.
// Once the issue exists, the first failing relation stops the command, naming the issue and the blocks that remain.
function create({ title: newTitle, bodyFile, status, kind, parent, blockedBy }, exec) {
  const description = readBodyFile(bodyFile);
  const team = readLinearTeam(exec);
  const existing = allNodes(exec, SAME_TITLE_QUERY, { key: team.key, title: newTitle }, (data) => data.issues);
  if (existing.length > 0) {
    throw new Error(`team ${team.key} already holds ${existing.map((issue) => issue.identifier).join(', ')} titled ${JSON.stringify(newTitle)}; nothing was filed`);
  }
  const parentIssue = parent === null ? null : readTeamIssue(parent, exec);
  const blockers = blockedBy.map((blocker) => readTeamIssue(blocker, exec));
  const input = {
    teamId: team.id,
    title: newTitle,
    description,
    stateId: team.stateIdOf(status),
    labelIds: [kindLabelId(exec, team, kind)],
    ...(parentIssue === null ? {} : { parentId: parentIssue.id }),
  };
  let issue;
  try {
    ({ issue } = exec(ISSUE_CREATE, { input }).issueCreate);
    if (issue === null) throw new Error('Linear answered issueCreate with no issue');
  } catch (error) {
    throw new Error(`${error.message}; re-running create is safe, because it first looks for an issue with this exact title in team ${team.key}`, { cause: error });
  }
  const rows = [['created', issue.identifier]];
  for (const [index, blocker] of blockers.entries()) {
    try {
      exec(RELATION_CREATE, { issueId: blocker.id, relatedIssueId: issue.id });
    } catch (error) {
      const remaining = blockers.slice(index).map((rest) => `node scripts/linear-card.mjs block ${issue.identifier} --by ${rest.identifier}`);
      throw new Error(`created ${issue.identifier}, then the relation making ${blocker.identifier} block it failed: ${error.message}\nnothing further was sent; run the blocks that remain:\n${remaining.join('\n')}`, { cause: error });
    }
    rows.push(['block', issue.identifier, blocker.identifier]);
  }
  return rows;
}

const OPERATIONS = {
  'view': (command, exec) => (command.board ? viewBoard(command, exec) : view(command, exec)),
  text,
  comment,
  'edit-comment': editComment,
  assign,
  unassign,
  create,
  edit,
  'parent': setParent,
  block,
};

// Runs a command parseCardArgs returned and gives back its output rows, or throws an Error naming the cause.
export function runCardCommand(command, exec = linearExec) {
  return OPERATIONS[command.name](command, exec);
}
