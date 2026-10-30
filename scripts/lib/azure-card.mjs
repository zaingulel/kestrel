// Native card commands preserve complete text and return receipts only after direct confirmation.
import { readFileSync } from 'node:fs';
import { KIND_LABELS, PICKABLE_STATUSES } from './board-config.mjs';
import { azureExec } from './azure-api.mjs';
import { AZURE_CLAIM_ADVISORY, mutateAzureIssue, readAzureBlockers, readAzureChildren, readAzureComments, readAzureIssue, readAzureParent, readAzureProject } from './board-azure.mjs';
import { isAzureIdentifier } from './tracker.mjs';

const FLAGS = {
  view: ['--board'], text: [], children: [], assign: [], unassign: [], comment: ['--body-file'], 'edit-comment': ['--body-file'],
  create: ['--title', '--body-file', '--status', '--kind', '--parent', '--blocked-by'], edit: ['--title', '--body-file'], parent: ['--to'], block: ['--by'],
};
export const USAGE = [
  'usage: node scripts/azure-card.mjs view <AB-ID> [--board]',
  '       node scripts/azure-card.mjs text|children|assign|unassign <AB-ID>',
  '       node scripts/azure-card.mjs comment <AB-ID> --body-file <file>',
  '       node scripts/azure-card.mjs edit-comment <AB-ID> <comment ID> --body-file <file>',
  `       node scripts/azure-card.mjs create --title <text> --body-file <file> --status ${PICKABLE_STATUSES.join('|')} --kind <kind> [--parent <AB-ID>] [--blocked-by <AB-ID>,...]`,
  '       node scripts/azure-card.mjs edit <AB-ID> [--title <text>] [--body-file <file>]',
  '       node scripts/azure-card.mjs parent <AB-ID> --to <AB-ID>',
  '       node scripts/azure-card.mjs block <AB-ID> --by <AB-ID>',
].join('\n');
const idOf = (id) => {
  if (!isAzureIdentifier(id)) throw new Error('Azure card identifier must be AB-<positive int32>');
  return id;
};

export function parseCardArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Azure card arguments must be strings');
  const [name, ...rest] = args;
  if (!Object.hasOwn(FLAGS, name ?? '')) throw new Error('unknown Azure card subcommand');
  const flags = {};
  const positions = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg.startsWith('--')) { positions.push(arg); continue; }
    if (!FLAGS[name].includes(arg) || Object.hasOwn(flags, arg)) throw new Error(`${name} has an unknown or repeated flag ${arg}`);
    if (arg === '--board') { flags[arg] = true; continue; }
    if (index + 1 === rest.length || rest[index + 1].startsWith('--') || !rest[index + 1].trim()) throw new Error(`${arg} needs a nonblank value`);
    flags[arg] = rest[++index];
  }
  const count = name === 'create' ? 0 : name === 'edit-comment' ? 2 : 1;
  if (positions.length !== count) throw new Error(`${name} needs ${count} positional argument(s)`);
  if (name === 'create') {
    for (const flag of ['--title', '--body-file', '--status', '--kind']) if (!Object.hasOwn(flags, flag)) throw new Error(`create needs ${flag}`);
    if (!PICKABLE_STATUSES.includes(flags['--status'])) throw new Error('--status must be ' + PICKABLE_STATUSES.join(' or '));
    if (!Object.hasOwn(KIND_LABELS, flags['--kind'])) throw new Error('--kind is not a configured kind');
    const blockedBy = flags['--blocked-by'] === undefined ? [] : flags['--blocked-by'].split(',').map(idOf);
    if (new Set(blockedBy).size !== blockedBy.length) throw new Error('--blocked-by repeats a card');
    return { name, title: flags['--title'], bodyFile: flags['--body-file'], status: flags['--status'], kind: flags['--kind'], parent: flags['--parent'] === undefined ? null : idOf(flags['--parent']), blockedBy };
  }
  const id = idOf(positions[0]);
  if (name === 'comment' || name === 'edit-comment') {
    if (flags['--body-file'] === undefined) throw new Error(name + ' needs --body-file');
    if (name === 'edit-comment' && !isAzureIdentifier('AB-' + positions[1])) throw new Error('edit-comment needs a positive int32 comment ID');
    return { name, id, bodyFile: flags['--body-file'], ...(name === 'edit-comment' ? { commentId: positions[1] } : {}) };
  }
  if (name === 'view') return { name, id, board: flags['--board'] === true };
  if (name === 'edit') {
    if (flags['--title'] === undefined && flags['--body-file'] === undefined) throw new Error('edit needs --title or --body-file');
    return { name, id, ...(flags['--title'] === undefined ? {} : { title: flags['--title'] }), ...(flags['--body-file'] === undefined ? {} : { bodyFile: flags['--body-file'] }) };
  }
  if (name === 'parent') return { name, id, to: idOf(flags['--to']) };
  if (name === 'block') return { name, id, by: idOf(flags['--by']) };
  return { name, id };
}

function fileBody(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { throw new Error(`Azure body file ${path} could not be read: ${error.code}`); }
}
const literalHtml = (source) => '<pre>' + source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre>';

function comments(command, source, exec) {
  const project = readAzureProject(exec);
  const issue = readAzureIssue(command.id, exec, project);
  let before;
  if (command.name === 'edit-comment') {
    before = readAzureComments(command.id, exec, project, issue).find((comment) => String(comment.id) === command.commentId);
    if (!before || before.isDeleted) throw new Error('Azure comment is missing or deleted');
    if (before.accountId !== project.viewer.id) throw new Error('Azure comment ownership belongs to another native identity');
  }
  const path = `/${project.id}/_apis/wit/workitems/${command.id.slice(3)}/comments` + (before ? '/' + before.id : '');
  let returned;
  try { returned = exec({ method: before ? 'PATCH' : 'POST', path, query: { 'api-version': '7.1-preview.4', format: 'markdown' }, body: { text: source } }); }
  catch (error) {
    const failure = new Error(`Azure ${command.id} comment outcome unknown; inspect native discussion before retrying; no retry sent: ${error.message}`);
    if (error.rateLimited === true) failure.rateLimited = true;
    throw failure;
  }
  const id = returned?.id ?? returned?.commentId;
  try {
    if (!isAzureIdentifier('AB-' + id) || (returned.id !== undefined && returned.commentId !== undefined && returned.id !== returned.commentId) ||
        (before && id !== before.id) || returned.workItemId !== Number(command.id.slice(3)) || returned.createdBy?.id !== project.viewer.id ||
        returned.text !== source || returned.format !== 'markdown' || returned.isDeleted === true ||
        !Number.isSafeInteger(returned.version) || returned.version < 1 || (before && returned.version <= before.version)) throw new Error('returned native ID/author/text/version does not confirm comment');
    const confirmed = readAzureComments(command.id, exec, project, issue).find((comment) => comment.id === id);
    if (!confirmed || confirmed.isDeleted || confirmed.accountId !== project.viewer.id || confirmed.body !== source || confirmed.format !== 'markdown' || confirmed.version !== returned.version) throw new Error('native comment readback does not confirm ID/author/text/version');
    return [[before ? 'edited-comment' : 'comment', command.id, id, confirmed.url], ...(before ? [['advisory', 'no atomic comment-edit guarantee; native comments have no documented compare-and-swap']] : [])];
  } catch (error) {
    const failure = new Error(`Azure ${command.id} comment ${isAzureIdentifier('AB-' + id) ? id : 'identity unknown'} outcome unconfirmed: ${error.message}; inspect native discussion; do not repeat blindly`);
    if (error.rateLimited === true) failure.rateLimited = true;
    throw failure;
  }
}

export function runCardCommand(command, exec = azureExec) {
  // Read the complete body before any provider request, including metadata or identity requests.
  const source = command.bodyFile === undefined ? undefined : fileBody(command.bodyFile);
  if (command.name === 'comment' || command.name === 'edit-comment') return comments(command, source, exec);
  if (command.name === 'children') {
    const children = readAzureChildren(command.id, exec);
    return [['children', children.issues.map(({ id }) => 'AB-' + id)], ['total', children.total], ['completed', children.completed]];
  }
  if (command.name === 'view' || command.name === 'text') {
    const project = readAzureProject(exec);
    const issue = readAzureIssue(command.id, exec, project);
    if (command.board) return [['board', 'azure', project.id, project.columnOf(issue.fields['System.WorkItemType'], issue.fields['System.State'])], ['boards', 1]];
    const nativeComments = readAzureComments(command.id, exec, project, issue);
    const commentRows = nativeComments.map((comment) => ['comment', comment.id, comment.format, comment.nativeFormat, comment.accountId, comment.createdAt, comment.url, comment.body, comment.isDeleted]);
    if (command.name === 'text') return [['title', issue.fields['System.Title']], ['body', 'html', issue.fields['System.Description'] ?? ''], ['parent', readAzureParent(issue, project, exec)],
      ['blockedBy', readAzureBlockers(issue, project, exec).map(({ number }) => number)], ...commentRows, ['comments', nativeComments.length]];
    return [['state', project.columnOf(issue.fields['System.WorkItemType'], issue.fields['System.State']) === 'Done' ? 'CLOSED' : 'OPEN'],
      ['assignees', issue.fields['System.AssignedTo'] === undefined ? [] : [issue.fields['System.AssignedTo'].id]], ['viewer', project.viewer.id],
      ['claim', AZURE_CLAIM_ADVISORY], ...commentRows, ['comments', nativeComments.length]];
  }
  const result = mutateAzureIssue({ ...command, ...(source === undefined ? {} : { description: literalHtml(source) }) }, exec);
  if (result.skipped) return [['no-op']];
  const id = 'AB-' + result.issue.id;
  if (command.name === 'assign') return [['assigned', id, result.viewer.id]];
  if (command.name === 'unassign') return [['unassigned', id]];
  if (command.name === 'parent') return [['parent', id, command.to]];
  if (command.name === 'block') return [['block', id, command.by]];
  return [[command.name === 'create' ? 'created' : 'edited', id]];
}
