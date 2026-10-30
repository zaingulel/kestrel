// Jira card operations return rows only after all required reads and writes have completed.
import { readFileSync } from 'node:fs';
import { KIND_LABELS, PICKABLE_STATUSES } from './board-config.mjs';
import { adfText, moveJiraCards, readJiraBlockers, readJiraComments, readJiraIssue, readJiraIssues, readJiraProject } from './board-jira.mjs';
import { jiraExec } from './jira-api.mjs';
import { JIRA_IDENTIFIER, compareCardIds } from './tracker.mjs';

const ID = /^[1-9]\d*$/;
const NO_OP = [['no-op']];
const LEADING_SPACE = /^[ \t\n\v\f\r\p{Z}\uFEFF]+/u;
const FLAGS = {
  view: ['--board'], text: [], comment: ['--body', '--body-file'], 'edit-comment': ['--body', '--body-file'],
  assign: [], unassign: [], create: ['--title', '--body-file', '--status', '--kind', '--parent', '--blocked-by'],
  edit: ['--title', '--body-file'], parent: ['--to'], block: ['--by'],
};
export const USAGE = [
  'usage: node scripts/jira-card.mjs view <KEY> [--board]',
  '       node scripts/jira-card.mjs text <KEY>',
  '       node scripts/jira-card.mjs comment <KEY> (--body <text> | --body-file <file>)',
  '       node scripts/jira-card.mjs edit-comment <KEY> <comment ID> (--body <text> | --body-file <file>)',
  '       node scripts/jira-card.mjs assign|unassign <KEY>',
  `       node scripts/jira-card.mjs create --title <text> --body-file <file> --status ${PICKABLE_STATUSES.join('|')} --kind <kind> [--parent <KEY>] [--blocked-by <KEY>,...]`,
  '       node scripts/jira-card.mjs edit <KEY> [--title <text>] [--body-file <file>]',
  '       node scripts/jira-card.mjs parent <KEY> --to <epic KEY>',
  '       node scripts/jira-card.mjs block <KEY> --by <blocker KEY>',
].join('\n');

function issueKey(value, label) {
  if (typeof value !== 'string' || !JIRA_IDENTIFIER.test(value)) throw new Error(`${label} must be a Jira issue key such as ENG-2`);
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

export function parseCardArgs(args) {
  const [name, ...rest] = args;
  if (!Object.hasOwn(FLAGS, name ?? '')) throw new Error('unknown card subcommand');
  const flags = {};
  const positions = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg.startsWith('--')) { positions.push(arg); continue; }
    if (!FLAGS[name].includes(arg) || Object.hasOwn(flags, arg)) throw new Error(`${name} has an unknown or repeated flag ${arg}`);
    if (arg === '--board') { flags[arg] = true; continue; }
    if (index + 1 === rest.length) throw new Error(`${arg} needs a value`);
    flags[arg] = rest[++index];
  }
  const count = name === 'create' ? 0 : name === 'edit-comment' ? 2 : 1;
  if (positions.length !== count) throw new Error(`${name} needs ${count} positional argument(s)`);
  if (name === 'create') {
    for (const flag of ['--title', '--body-file', '--status', '--kind']) if (!(flag in flags)) throw new Error(`create needs ${flag}`);
    if (!PICKABLE_STATUSES.includes(flags['--status'])) throw new Error(`--status must be ${PICKABLE_STATUSES.join(' or ')}`);
    if (!Object.hasOwn(KIND_LABELS, flags['--kind'])) throw new Error('--kind is not a configured issue kind');
    const blockedBy = '--blocked-by' in flags ? flags['--blocked-by'].split(',').map((key) => issueKey(key, '--blocked-by')) : [];
    if (new Set(blockedBy).size !== blockedBy.length) throw new Error('--blocked-by repeats an issue');
    return { name, title: title(flags['--title']), bodyFile: flags['--body-file'], status: flags['--status'], kind: flags['--kind'], parent: '--parent' in flags ? issueKey(flags['--parent'], '--parent') : null, blockedBy };
  }
  const id = issueKey(positions[0], name);
  if (name === 'edit-comment') {
    if (!ID.test(positions[1])) throw new Error('edit-comment needs a positive decimal comment ID');
    return { name, id, commentId: positions[1], body: bodySource(flags) };
  }
  if (name === 'comment') return { name, id, body: bodySource(flags) };
  if (name === 'view') return { name, id, board: flags['--board'] === true };
  if (name === 'edit') {
    if (!('--title' in flags) && !('--body-file' in flags)) throw new Error('edit needs --title or --body-file');
    return { name, id, ...('--title' in flags ? { title: title(flags['--title']) } : {}), ...('--body-file' in flags ? { bodyFile: flags['--body-file'] } : {}) };
  }
  if (name === 'parent') return { name, id, to: issueKey(flags['--to'], '--to') };
  if (name === 'block') return { name, id, by: issueKey(flags['--by'], '--by') };
  return { name, id };
}

function fileBody(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { throw new Error(`body file ${path} could not be read: ${error.code}`); }
}
const bodyText = (body) => body.file === undefined ? body.text : fileBody(body.file);
const literalText = (value) => value.replace(/\r\n?/g, '\n');
function literalAdf(value) {
  const content = [];
  for (const [index, line] of literalText(value).split('\n').entries()) {
    if (index) content.push({ type: 'hardBreak' });
    if (line) content.push({ type: 'text', text: line });
  }
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', ...(content.length ? { content } : {}) }] };
}
function viewer(exec) {
  const actor = exec({ method: 'GET', path: '/rest/api/3/myself' });
  if (typeof actor?.accountId !== 'string' || !actor.accountId.trim()) throw new Error('Jira viewer has no accountId');
  return actor.accountId;
}
function assignees(issue) {
  const actor = issue.fields.assignee;
  if (actor !== null && (typeof actor?.accountId !== 'string' || !actor.accountId.trim())) throw new Error('Jira assignee identity is unavailable');
  return actor === null ? [] : [actor.accountId];
}
const commentUrl = (site, key, id) => `${site}/browse/${key}?focusedCommentId=${id}`;

function view(command, exec) {
  const project = readJiraProject(exec);
  const issue = readJiraIssue(command.id, exec);
  if (command.board) return [['board', 'jira', project.key, project.columnOf(issue.fields.status)], ['boards', 1]];
  const actor = viewer(exec);
  const comments = readJiraComments(command.id, exec);
  return [['state', issue.fields.status.statusCategory.key === 'done' ? 'CLOSED' : 'OPEN'], ['assignees', assignees(issue)], ['viewer', actor],
    ...comments.flatMap((comment) => {
      const text = comment.body.replace(LEADING_SPACE, '');
      return text.startsWith('Claim:') ? [['claim', comment.position, comment.accountId, comment.createdAt, comment.url, text.split(/\r?\n/)[0], comment.id]] : [];
    }), ['comments', comments.length]];
}
function text(command, exec) {
  const project = readJiraProject(exec);
  const issue = readJiraIssue(command.id, exec);
  const parent = issue.fields.parent == null ? null : readJiraIssue(issue.fields.parent.key, exec);
  if (parent && parent.id !== issue.fields.parent.id) throw new Error('Jira parent identity changed');
  const blockers = readJiraBlockers(issue, project, exec).map(({ number }) => number).sort(compareCardIds);
  const comments = readJiraComments(command.id, exec);
  return [['title', issue.fields.summary], ['body', adfText(issue.fields.description)], ['parent', parent?.key ?? null], ['blockedBy', blockers],
    ...comments.map((comment) => ['comment', comment.position, comment.accountId, comment.createdAt, comment.url, comment.body])];
}

function comment(command, exec) {
  const source = bodyText(command.body);
  const project = readJiraProject(exec);
  readJiraIssue(command.id, exec);
  const actor = viewer(exec);
  if (command.name === 'edit-comment') {
    const existing = readJiraComments(command.id, exec).find(({ id }) => id === command.commentId);
    if (!existing || existing.accountId !== actor) throw new Error('only the comment author can edit this Jira comment; nothing was written');
  }
  const response = exec({ method: command.name === 'comment' ? 'POST' : 'PUT', path: `/rest/api/3/issue/${command.id}/comment${command.name === 'edit-comment' ? `/${command.commentId}` : ''}`, body: { body: literalAdf(source) } });
  const id = response?.id;
  if (typeof id !== 'string' || !ID.test(id) || (command.name === 'edit-comment' && id !== command.commentId)) throw new Error('Jira comment write returned no confirmed comment identity; inspect before retrying');
  const confirmed = readJiraComments(command.id, exec).find((entry) => entry.id === id);
  if (!confirmed || confirmed.accountId !== actor || confirmed.body !== literalText(source)) throw new Error(`Jira comment ${id} read-back did not confirm the intended author/body`);
  return [['comment', id, commentUrl(project.config.site, command.id, id)]];
}
function assignment(command, exec) {
  const issue = readJiraIssue(command.id, exec);
  const actor = viewer(exec);
  const held = assignees(issue)[0] ?? null;
  if (held !== null && held !== actor) throw new Error(`Jira card is held by another account (${held}); nothing was written`);
  const target = command.name === 'assign' ? actor : null;
  if (held === target) return NO_OP;
  exec({ method: 'PUT', path: `/rest/api/3/issue/${command.id}/assignee`, body: { accountId: target } });
  const confirmed = assignees(readJiraIssue(command.id, exec));
  if ((confirmed[0] ?? null) !== target) throw new Error('Jira assignee read-back did not confirm the intended account');
  return [['assignees', confirmed]];
}
function editable(exec, key, fields) {
  const metadata = exec({ method: 'GET', path: `/rest/api/3/issue/${key}/editmeta` });
  for (const field of Object.keys(fields)) if (!Array.isArray(metadata?.fields?.[field]?.operations) || !metadata.fields[field].operations.includes('set')) throw new Error(`Jira edit metadata does not allow setting ${field}; check project field setup`);
}
function edit(command, exec) {
  const source = command.bodyFile === undefined ? undefined : fileBody(command.bodyFile);
  const fields = { ...(command.title === undefined ? {} : { summary: command.title }), ...(source === undefined ? {} : { description: literalAdf(source) }) };
  readJiraIssue(command.id, exec);
  editable(exec, command.id, fields);
  exec({ method: 'PUT', path: `/rest/api/3/issue/${command.id}`, body: { fields } });
  const confirmed = readJiraIssue(command.id, exec);
  if ((command.title !== undefined && confirmed.fields.summary !== command.title) || (source !== undefined && adfText(confirmed.fields.description) !== literalText(source))) throw new Error('Jira edit read-back did not confirm intended summary/body');
  return [['edited', command.id]];
}
function parentType(project, childType, parent) {
  if (project.types.get(childType)?.hierarchyLevel !== 0 || project.types.get(parent.fields.issuetype.id)?.hierarchyLevel !== 1) throw new Error('Jira parent requires an epic hierarchy level 1 and a child at level 0');
}
function setParent(command, exec) {
  if (command.id === command.to) throw new Error('a Jira card cannot parent itself');
  const project = readJiraProject(exec);
  const issue = readJiraIssue(command.id, exec);
  const parent = readJiraIssue(command.to, exec);
  parentType(project, issue.fields.issuetype.id, parent);
  if (issue.fields.parent?.id === parent.id && issue.fields.parent.key === parent.key) return NO_OP;
  const fields = { parent: { id: parent.id } };
  editable(exec, command.id, fields);
  exec({ method: 'PUT', path: `/rest/api/3/issue/${command.id}`, body: { fields } });
  const confirmed = readJiraIssue(command.id, exec);
  if (confirmed.fields.parent?.id !== parent.id || confirmed.fields.parent.key !== parent.key) throw new Error('Jira parent read-back did not confirm the requested epic');
  return [['parent', command.id, parent.key]];
}
function block(command, exec) {
  if (command.id === command.by) throw new Error('a Jira card cannot block itself');
  const project = readJiraProject(exec);
  const issue = readJiraIssue(command.id, exec);
  const blocker = readJiraIssue(command.by, exec);
  if (readJiraBlockers(issue, project, exec).some(({ number }) => number === blocker.key)) return NO_OP;
  exec({ method: 'POST', path: '/rest/api/3/issueLink', body: { type: { id: project.config.blockLinkType }, inwardIssue: { key: blocker.key }, outwardIssue: { key: issue.key } } });
  const confirmed = readJiraIssue(command.id, exec);
  if (!readJiraBlockers(confirmed, project, exec).some(({ number }) => number === blocker.key)) throw new Error('Jira block read-back did not confirm the requested inward blocker');
  return [['block', command.id, command.by]];
}

function createFields(exec, project, type) {
  const fields = [];
  const seen = new Set();
  let startAt = 0;
  let total;
  for (;;) {
    const page = exec({ method: 'GET', path: `/rest/api/3/issue/createmeta/${project.key}/issuetypes/${type}`, query: { startAt, maxResults: 100 } });
    if (!Array.isArray(page?.fields) || page.startAt !== startAt || !Number.isSafeInteger(page.total) || page.total < 0 || !Number.isSafeInteger(page.maxResults) || page.maxResults < 1 || page.fields.length > page.maxResults || (total !== undefined && total !== page.total)) throw new Error('Jira create field metadata is incomplete or malformed');
    total = page.total;
    for (const field of page.fields) {
      if (typeof field?.fieldId !== 'string' || !field.fieldId || seen.has(field.fieldId) || typeof field.required !== 'boolean') throw new Error('Jira create field metadata contains malformed or duplicate fields');
      seen.add(field.fieldId);
      fields.push(field);
    }
    startAt += page.fields.length;
    if (startAt > total) throw new Error('Jira create field metadata exceeds its total');
    if (startAt === total) return fields;
    if (page.fields.length === 0) throw new Error('Jira create field metadata cannot progress');
  }
}
function create(command, exec) {
  const source = fileBody(command.bodyFile);
  const { project, issues } = readJiraIssues(exec);
  const duplicates = issues.filter((issue) => issue.fields.summary === command.title);
  if (duplicates.length) throw new Error(`Jira title preflight already shows ${duplicates.map(({ key }) => key).join(', ')}; nothing filed. This advisory uses eventually consistent search, not an idempotency guarantee`);
  const type = project.config.issueTypes[command.kind];
  const parent = command.parent === null ? null : readJiraIssue(command.parent, exec);
  if (parent) parentType(project, type, parent);
  for (const key of command.blockedBy) readJiraIssue(key, exec);
  const fields = { project: { id: project.id }, issuetype: { id: type }, summary: command.title, description: literalAdf(source), labels: [KIND_LABELS[command.kind]], ...(parent ? { parent: { id: parent.id } } : {}) };
  const metadata = createFields(exec, project, type);
  for (const name of Object.keys(fields)) if (!metadata.some(({ fieldId }) => fieldId === name)) throw new Error(`Jira create metadata does not expose ${name}; check project field setup`);
  for (const field of metadata) if (field.required && field.hasDefaultValue !== true && !Object.hasOwn(fields, field.fieldId)) throw new Error(`Jira required field ${field.fieldId} has no supplied value or default; configure project field setup before creating`);
  let created;
  try { created = exec({ method: 'POST', path: '/rest/api/3/issue', body: { fields } }); }
  catch (error) { throw new Error(`Jira create outcome is unknown: ${error.message}; inspect project ${project.key} for the requested title before any retry. Search is eventually consistent; no automatic retry was sent`); }
  if (typeof created?.id !== 'string' || !ID.test(created.id) || typeof created.key !== 'string' || !JIRA_IDENTIFIER.test(created.key)) throw new Error(`Jira create outcome has no usable issue identity; inspect project ${project.key} before retrying`);
  try {
    const issue = readJiraIssue(created.key, exec);
    if (issue.id !== created.id || issue.fields.summary !== command.title || adfText(issue.fields.description) !== literalText(source) || issue.fields.issuetype.id !== type || JSON.stringify(issue.fields.labels) !== JSON.stringify(fields.labels) || (parent && (issue.fields.parent?.id !== parent.id || issue.fields.parent.key !== parent.key))) throw new Error('created issue read-back does not confirm intended fields');
    moveJiraCards([{ issueNumber: created.key, statusName: command.status }], exec);
    const rows = [['created', created.key]];
    for (const by of command.blockedBy) rows.push(...block({ name: 'block', id: created.key, by }, exec));
    return rows;
  } catch (error) {
    throw new Error(`created ${created.key} (id ${created.id}), then remaining work failed: ${error.message}; inspect its status and remaining blockers ${command.blockedBy.join(', ') || 'none'}; do not rerun create`);
  }
}

const OPERATIONS = { view, text, comment, 'edit-comment': comment, assign: assignment, unassign: assignment, create, edit, parent: setParent, block };
export function runCardCommand(command, exec = jiraExec) {
  return OPERATIONS[command.name](command, exec);
}
