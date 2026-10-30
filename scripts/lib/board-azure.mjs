// Native Azure evidence is accepted only after exact mapping, identity and completeness checks.
import * as boardConfig from './board-config.mjs';
import { azureExec } from './azure-api.mjs';
import { validateAzureConfig } from './azure-config.mjs';
import { ghExec as defaultGhExec } from './gh-exec.mjs';
import { isAzureIdentifier } from './tracker.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed']);
export const AZURE_CLAIM_ADVISORY = 'review complete native comments and deleted tombstones for Claim/withdrawal evidence';
const OPPOSITES = {
  'System.LinkTypes.Hierarchy-Forward': 'System.LinkTypes.Hierarchy-Reverse',
  'System.LinkTypes.Hierarchy-Reverse': 'System.LinkTypes.Hierarchy-Forward',
  'System.LinkTypes.Dependency-Forward': 'System.LinkTypes.Dependency-Reverse',
  'System.LinkTypes.Dependency-Reverse': 'System.LinkTypes.Dependency-Forward',
};
const nonblank = (value) => typeof value === 'string' && value.trim() !== '';
const validId = (value) => Number.isInteger(value) && value > 0 && value <= 2147483647;
const validUuid = (value) => typeof value === 'string' && UUID.test(value);
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const problem = (message, cause) => {
  const error = new Error('Azure ' + message);
  if (cause?.rateLimited === true) error.rateLimited = true;
  return error;
};
const rootOf = (project) => `/${project.id}/_apis/wit`;
const publicId = (id) => 'AB-' + id;
const get = (exec, path, query = {}) => exec({ method: 'GET', path, query: { 'api-version': '7.1', ...query } });

function nativeId(id) {
  if (!isAzureIdentifier(id)) throw problem('card identifier must be AB-<positive int32>');
  return Number(id.slice(3));
}

function collection(response, label) {
  if (!Array.isArray(response?.value) || !Number.isSafeInteger(response.count) || response.count !== response.value.length) {
    throw problem(label + ' metadata/count is malformed or incomplete');
  }
  return response.value;
}

export function readAzureProject(exec = azureExec) {
  const config = validateAzureConfig(boardConfig.AZURE_CONFIG, 'Azure board-config.mjs AZURE_CONFIG');
  if (boardConfig.BOARD_PROJECT_NUMBER !== null || boardConfig.ROUTING_FIELD !== null ||
      !Array.isArray(boardConfig.ROUTING_OPTIONS) || boardConfig.ROUTING_OPTIONS.length !== 0 || boardConfig.PARKED_LANE !== null) {
    throw problem('board-config.mjs must have no GitHub project number, routing field/options or parked lane');
  }
  const project = get(exec, '/_apis/projects/' + config.project);
  if (project?.id !== config.project || !nonblank(project.name)) throw problem('project metadata does not identify the configured project');
  const root = `/${project.id}/_apis/wit`;
  const types = new Map();
  for (const type of collection(get(exec, root + '/workitemtypes'), 'work item types')) {
    if (!nonblank(type?.name) || types.has(type.name) || (type.isDisabled !== undefined && typeof type.isDisabled !== 'boolean')) throw problem('work item type metadata is malformed or duplicated');
    types.set(type.name, type);
  }
  const states = new Map();
  for (const type of new Set(Object.values(config.workItemTypes))) {
    if (!types.has(type) || types.get(type).isDisabled === true) throw problem('mapped work item type is missing or disabled');
    const native = new Map();
    for (const state of collection(get(exec, root + '/workitemtypes/' + encodeURIComponent(type) + '/states'), 'states')) {
      if (!nonblank(state?.name) || !CATEGORIES.has(state.category) || native.has(state.name)) throw problem('state metadata is malformed or duplicated');
      native.set(state.name, state);
    }
    for (const [column, name] of Object.entries(config.states[type])) {
      const state = native.get(name);
      if (!state) throw problem('mapped state is absent from native metadata');
      if (column === 'Done' ? state.category !== 'Completed' : ['Completed', 'Removed'].includes(state.category)) throw problem('state mapping has an incompatible completion category');
    }
    states.set(type, native);
  }
  const relations = new Map();
  for (const relation of collection(get(exec, '/_apis/wit/workitemrelationtypes'), 'relationship types')) {
    if (!nonblank(relation?.referenceName) || relations.has(relation.referenceName)) throw problem('relationship type metadata is malformed or duplicated');
    relations.set(relation.referenceName, relation);
  }
  for (const [name, opposite] of Object.entries(OPPOSITES)) {
    const attributes = relations.get(name)?.attributes;
    if (attributes?.enabled !== true || attributes.directional !== true || attributes.usage !== 'workItemLink' || attributes.oppositeEndReferenceName !== opposite) {
      throw problem('required native relationship metadata is disabled or has an incompatible opposite');
    }
  }
  const viewer = exec({ method: 'GET', path: '/_apis/profile/profiles/me', profile: true, query: { 'api-version': '7.1', details: true } });
  if (!validUuid(viewer?.id) || !nonblank(viewer.emailAddress)) throw problem('authenticated profile identity or emailAddress is unavailable');
  return {
    id: project.id, name: project.name, config, types, states, relations,
    viewer: { id: viewer.id, emailAddress: viewer.emailAddress },
    columnOf: (type, state) => Object.entries(config.states[type] ?? {}).find(([, name]) => name === state)?.[0] ?? null,
  };
}

function targetId(url, project) {
  const base = 'https://dev.azure.com/' + project.config.organization;
  // Native links can omit the project; the constructed direct GET must still prove its project.
  for (const prefix of [base + '/_apis/wit/', base + '/' + project.id + '/_apis/wit/']) {
    if (typeof url !== 'string' || !url.startsWith(prefix)) continue;
    const match = /^(?:workItems|workitems)\/([1-9][0-9]*)$/.exec(url.slice(prefix.length));
    if (match && validId(Number(match[1]))) return Number(match[1]);
  }
  throw problem('relationship target URL is malformed or outside the configured organization/project');
}

function relationships(issue, project) {
  const given = new Set();
  const result = [];
  if (issue.relations === undefined) return result;
  if (!Array.isArray(issue.relations)) throw problem('work item relationships are unavailable');
  for (const relation of issue.relations) {
    if (!nonblank(relation?.rel) || !nonblank(relation.url)) throw problem('work item relationship is malformed');
    if (!Object.hasOwn(OPPOSITES, relation.rel)) continue;
    const id = targetId(relation.url, project);
    const key = relation.rel + ':' + id;
    if (id === issue.id || given.has(key)) throw problem('work item relationship is self-referential or duplicated');
    given.add(key);
    result.push({ rel: relation.rel, id });
  }
  if (result.filter(({ rel }) => rel === 'System.LinkTypes.Hierarchy-Reverse').length > 1) throw problem('work item has multiple native parents');
  return result;
}

function tagsOf(issue) {
  const tags = issue.fields['System.Tags'];
  if (tags === undefined) return [];
  if (typeof tags !== 'string') throw problem('work item tags are malformed');
  return tags.split(';').map((tag) => tag.trim()).filter(Boolean);
}

function checkedIssue(issue, project, expected) {
  if (!validId(issue?.id) || (expected !== undefined && issue.id !== expected) || !Number.isSafeInteger(issue.rev) || issue.rev < 1) throw problem('work item identity or revision is malformed or mismatches the request');
  const fields = issue.fields;
  if (!fields || fields['System.TeamProject'] !== project.name) throw problem('work item belongs to a different project');
  if (!nonblank(fields['System.Title'])) throw problem('work item title is missing or malformed');
  const type = fields['System.WorkItemType'];
  const state = fields['System.State'];
  if (!Object.hasOwn(project.config.states, type) || project.columnOf(type, state) === null) throw problem('work item type/state mapping drift; update the configured native mappings');
  if (fields['System.Description'] !== undefined && typeof fields['System.Description'] !== 'string') throw problem('work item description is malformed');
  if (fields['System.AssignedTo'] !== undefined && !validUuid(fields['System.AssignedTo']?.id)) throw problem('work item assignee has no native identity UUID');
  const labels = tagsOf(issue);
  const kinds = Object.entries(boardConfig.KIND_LABELS).filter(([, label]) => labels.includes(label));
  if (kinds.length === 1 && project.config.workItemTypes[kinds[0][0]] !== type) throw problem('kind label/native work item type mapping drift');
  if (issue.url !== undefined && targetId(issue.url, project) !== issue.id) throw problem('work item URL has another native identity');
  relationships(issue, project);
  return issue;
}

function issueAt(id, project, exec, cache) {
  if (!cache?.has(id)) {
    const issue = checkedIssue(get(exec, rootOf(project) + '/workitems/' + id, { $expand: 'All' }), project, id);
    cache?.set(id, issue);
    return issue;
  }
  return cache.get(id);
}

export function readAzureIssue(id, exec = azureExec, project) {
  const number = nativeId(id);
  return issueAt(number, project ?? readAzureProject(exec), exec);
}

// All supported work-item changes share revision, native-rule validation and direct confirmation policy.
export function mutateAzureIssue(command, exec = azureExec) {
  const creating = command.name === 'create';
  if (!creating) nativeId(command.id);
  if (!['create', 'edit', 'assign', 'unassign', 'parent', 'block', 'move'].includes(command.name)) throw problem('unsupported mutation');
  const project = readAzureProject(exec);
  const before = creating ? null : issueAt(nativeId(command.id), project, exec);
  const fields = {};
  const links = [];
  let assignment;
  const type = creating ? project.config.workItemTypes[command.kind] : before.fields['System.WorkItemType'];
  if (creating || command.title !== undefined) fields['System.Title'] = command.title;
  if (creating || command.description !== undefined) fields['System.Description'] = command.description;
  let column;
  if (creating || command.name === 'move') {
    column = Object.keys(project.config.states[type]).find((name) => name.toLowerCase() === String(command.status).trim().toLowerCase());
    if (!column) throw problem('unknown status ' + command.status);
    fields['System.State'] = project.config.states[type][column];
  }
  if (creating) fields['System.Tags'] = boardConfig.KIND_LABELS[command.kind];
  if (command.name === 'assign' || command.name === 'unassign') {
    const owner = before.fields['System.AssignedTo']?.id;
    if (owner !== undefined && owner !== project.viewer.id) throw problem('ownership belongs to another native identity');
    assignment = command.name === 'assign' ? project.viewer.id : null;
    if ((owner ?? null) !== assignment) fields['System.AssignedTo'] = assignment === null ? '' : project.viewer.emailAddress;
  }
  const existing = before ? relationships(before, project) : [];
  const addLink = (rel, id) => {
    const target = nativeId(id);
    if (target === before?.id) throw problem('card cannot link to itself');
    issueAt(target, project, exec);
    if (rel === 'System.LinkTypes.Hierarchy-Reverse' && existing.some((link) => link.rel === rel && link.id !== target)) throw problem('different existing parent; refusing to reparent');
    if (!existing.some((link) => link.rel === rel && link.id === target)) links.push({ rel, url: `https://dev.azure.com/${project.config.organization}/${project.id}/_apis/wit/workitems/${target}` });
  };
  if (command.name === 'parent') addLink('System.LinkTypes.Hierarchy-Reverse', command.to);
  if (command.name === 'block') addLink('System.LinkTypes.Dependency-Reverse', command.by);
  if (creating) {
    if (command.parent !== null) addLink('System.LinkTypes.Hierarchy-Reverse', command.parent);
    for (const id of command.blockedBy) addLink('System.LinkTypes.Dependency-Reverse', id);
  }
  const fieldPatch = Object.entries(fields).filter(([name, value]) => creating || before.fields[name] !== value).map(([name, value]) => ({ op: 'add', path: '/fields/' + name, value }));
  const changes = [...fieldPatch, ...links.map((value) => ({ op: 'add', path: '/relations/-', value }))];
  if (!changes.length) return { issue: before, skipped: true, viewer: project.viewer, column };
  const patch = creating ? changes : [{ op: 'test', path: '/rev', value: before.rev }, ...changes];
  const path = rootOf(project) + '/workitems/' + (creating ? '$' + encodeURIComponent(type) : before.id);
  const intended = (issue) => {
    if (issue.fields['System.WorkItemType'] !== type) throw problem('work item type changed');
    for (const [name, value] of Object.entries(fields)) {
      if (name === 'System.AssignedTo') {
        if ((issue.fields[name]?.id ?? null) !== assignment) throw problem('assignee native identity does not confirm the authenticated identity');
      } else if (issue.fields[name] !== value) throw problem('intended field ' + name + ' is unconfirmed');
    }
    const expectedLinks = [...existing, ...links.map((link) => ({ rel: link.rel, id: targetId(link.url, project) }))];
    const observedLinks = relationships(issue, project);
    if (expectedLinks.length !== observedLinks.length || expectedLinks.some((link) => !observedLinks.some((observed) => observed.rel === link.rel && observed.id === link.id))) throw problem('intended native relationships are unconfirmed');
    if (before) {
      for (const name of ['System.Tags', 'System.AssignedTo']) {
        if (Object.hasOwn(fields, name)) continue;
        const identity = (value) => name === 'System.AssignedTo' ? value?.id : value;
        if (identity(issue.fields[name]) !== identity(before.fields[name])) throw problem('existing labels or ownership changed');
      }
    }
  };
  try {
    const validation = exec({ method: creating ? 'POST' : 'PATCH', path, query: { 'api-version': '7.1', validateOnly: true }, body: patch });
    // Assignment must resolve the supplied principal to the profile UUID before any real write.
    if (assignment !== undefined && (validation?.fields?.['System.AssignedTo']?.id ?? null) !== assignment) throw problem('validated assignee identity does not match authenticated identity');
  } catch (error) { throw problem('validation failed; inspect native process required fields and setup: ' + error.message, error); }
  let returned;
  try { returned = exec({ method: creating ? 'POST' : 'PATCH', path, query: { 'api-version': '7.1' }, body: patch }); }
  catch (error) {
    if (creating) throw problem(`create outcome unknown in ${project.name} for title ${JSON.stringify(command.title)}; inspect the project before retrying; no retry sent: ${error.message}`, error);
    throw problem(`${command.id} mutation failed or outcome unknown: ${error.message}; inspect current card; no retry sent`, error);
  }
  const known = creating && validId(returned?.id) ? publicId(returned.id) : command.id;
  if (creating && !known) throw problem(`create outcome unknown in ${project.name} for title ${JSON.stringify(command.title)}; inspect the project before retrying; no retry sent`);
  try {
    const accepted = checkedIssue(returned, project, creating ? undefined : before.id);
    if (!creating && accepted.rev <= before.rev) throw problem('revision did not advance');
    intended(accepted);
    const confirmed = issueAt(accepted.id, project, exec);
    if (confirmed.rev < accepted.rev || (!creating && confirmed.rev <= before.rev)) throw problem('readback revision did not advance');
    intended(confirmed);
    return { issue: confirmed, skipped: false, viewer: project.viewer, column };
  } catch (error) {
    throw problem(`${creating ? 'created ' : ''}${known} outcome unconfirmed: ${error.message}; inspect the native card${creating ? '; do not rerun create' : '; no retry sent'}`, error);
  }
}

export function moveAzureCards(pairs, exec = azureExec) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw problem('move requires at least one card/status pair');
  for (const pair of pairs) {
    nativeId(pair?.issueNumber);
    if (!nonblank(pair.statusName)) throw problem('move requires a status');
  }
  const completed = [];
  for (const { issueNumber, statusName } of pairs) {
    try {
      const result = mutateAzureIssue({ name: 'move', id: issueNumber, status: statusName }, exec);
      completed.push({ issueNumber, statusName: result.column, skipped: result.skipped });
    } catch (error) {
      throw problem(`move failed; confirmed ${completed.map((item) => item.issueNumber + ' ' + item.statusName).join(', ') || 'none'}; ${issueNumber}: ${error.message}`, error);
    }
  }
  return completed;
}

function parentOf(issue, project, exec, cache) {
  const parent = relationships(issue, project).find(({ rel }) => rel === 'System.LinkTypes.Hierarchy-Reverse');
  return parent ? publicId(issueAt(parent.id, project, exec, cache).id) : null;
}

function childrenOf(issue, project, exec, cache) {
  const issues = relationships(issue, project).filter(({ rel }) => rel === 'System.LinkTypes.Hierarchy-Forward').map(({ id }) => {
    const child = issueAt(id, project, exec, cache);
    const parent = relationships(child, project).find(({ rel }) => rel === 'System.LinkTypes.Hierarchy-Reverse');
    if (parent?.id !== issue.id) throw problem('child relationship does not identify the requested parent');
    return child;
  });
  return { issues, total: issues.length, completed: issues.filter((child) => columnOf(child, project) === 'Done').length };
}

export function readAzureChildren(id, exec = azureExec, project, issue) {
  const number = nativeId(id);
  project ??= readAzureProject(exec);
  return childrenOf(issue ?? issueAt(number, project, exec), project, exec, new Map());
}

const columnOf = (issue, project) => project.columnOf(issue.fields['System.WorkItemType'], issue.fields['System.State']);
const stateOf = (issue, project) => columnOf(issue, project) === 'Done' ? 'CLOSED' : 'OPEN';

function allIssues(project, exec) {
  let response;
  try {
    response = exec({ method: 'POST', path: rootOf(project) + '/wiql', query: { 'api-version': '7.1' }, body: {
      query: 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.Id] ASC',
    } });
  } catch (error) {
    const failure = problem('project query unavailable, including possible native query limits; inspect the project/query limit: ' + error.message);
    if (error.rateLimited) failure.rateLimited = true;
    throw failure;
  }
  if (response?.queryType !== 'flat' || !validDate(response.asOf) || !Array.isArray(response.workItems) || response.workItemRelations !== undefined) throw problem('project query is malformed or incomplete');
  const ids = response.workItems.map((item) => item?.id);
  if (!ids.every(validId) || new Set(ids).size !== ids.length) throw problem('project query returned malformed or duplicate identities');
  const issues = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const requested = ids.slice(offset, offset + 200);
    const batch = collection(exec({ method: 'POST', path: rootOf(project) + '/workitemsbatch', query: { 'api-version': '7.1' },
      body: { ids: requested, asOf: response.asOf, errorPolicy: 'Fail', $expand: 'All' } }), 'work item batch');
    const returned = new Map();
    for (const native of batch) {
      const issue = checkedIssue(native, project);
      if (!requested.includes(issue.id) || returned.has(issue.id)) throw problem('work item batch returned unexpected or duplicate identities');
      returned.set(issue.id, issue);
    }
    if (returned.size !== requested.length) throw problem('work item batch is incomplete against requested identities');
    issues.push(...requested.map((id) => returned.get(id)));
  }
  return issues;
}

function blockersOf(issue, project, exec, cache) {
  return relationships(issue, project).filter(({ rel }) => rel === 'System.LinkTypes.Dependency-Reverse').map(({ id }) => {
    const target = issueAt(id, project, exec, cache);
    return { number: publicId(target.id), state: stateOf(target, project) };
  });
}

export { blockersOf as readAzureBlockers, parentOf as readAzureParent, tagsOf as azureTags };

// This provider-local adaptation keeps Jira's delivery policy unchanged while binding Azure project URLs.
function closingPulls(ids, project, ghExec) {
  const repository = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;
  let pages;
  try { pages = JSON.parse(ghExec(['api', `repos/${repository}/pulls?state=all&per_page=100`, '--paginate', '--slurp'])); }
  catch (error) { throw new Error('GitHub pull-request pages are unavailable: ' + error.message); }
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every(Array.isArray)) throw new Error('GitHub pull-request pages are malformed or incomplete');
  const matches = new Map(ids.map((id) => [id, []]));
  const seen = new Set();
  for (const pull of pages.flat()) {
    if (!Number.isSafeInteger(pull?.number) || pull.number < 1 || seen.has(pull.number)) throw new Error('GitHub returned malformed or duplicate pull-request identities');
    seen.add(pull.number);
    if (!['open', 'closed'].includes(pull.state) || typeof pull.draft !== 'boolean' ||
        typeof pull.head?.ref !== 'string' || typeof pull.base?.ref !== 'string' ||
        typeof pull.base.repo?.full_name !== 'string' || !(pull.head.repo === null || typeof pull.head.repo?.full_name === 'string') ||
        !(pull.body === null || typeof pull.body === 'string') || !(pull.merged_at === null || validDate(pull.merged_at))) throw new Error('GitHub pull-request evidence is malformed');
    if (pull.state !== 'open' && pull.merged_at === null) continue;
    if (pull.head.repo?.full_name !== repository || pull.base.repo.full_name !== repository || pull.base.ref !== 'main') continue;
    const lines = (pull.body ?? '').split(/\r?\n/);
    for (const id of ids) {
      if (pull.head.ref === 'job/' + publicId(id) && lines.includes('Closes ' + publicId(id)) &&
          lines.includes(`Azure Boards: https://dev.azure.com/${project.config.organization}/${project.id}/_workitems/edit/${id}`)) matches.get(id).push({ number: pull.number });
    }
  }
  return matches;
}

export function readAzureBoard(exec = azureExec, ghExec = defaultGhExec) {
  const project = readAzureProject(exec);
  const issues = allIssues(project, exec);
  const pulls = closingPulls(issues.map(({ id }) => id), project, ghExec);
  const cache = new Map(issues.map((issue) => [issue.id, issue]));
  return { items: issues.map((issue) => {
    parentOf(issue, project, exec, cache);
    const { total, completed } = childrenOf(issue, project, exec, cache);
    return {
      id: issue.id, status: columnOf(issue, project), title: issue.fields['System.Title'], routing: null,
      labels: tagsOf(issue), assignees: issue.fields['System.AssignedTo'] === undefined ? [] : [issue.fields['System.AssignedTo'].id],
      blockers: blockersOf(issue, project, exec, cache), closingPullRequests: pulls.get(issue.id),
      content: { __typename: 'Issue', number: publicId(issue.id), state: stateOf(issue, project), subIssuesSummary: { total, completed } },
    };
  }) };
}

function commentsOf(issue, project, exec) {
  const comments = [];
  const ids = new Set();
  const cursors = new Set();
  let continuationToken;
  let total;
  for (;;) {
    const page = get(exec, rootOf(project) + '/workitems/' + issue.id + '/comments', {
      'api-version': '7.1-preview.4', $top: 100, includeDeleted: true, order: 'asc',
      ...(continuationToken === undefined ? {} : { continuationToken }),
    });
    if (!Array.isArray(page?.comments) || !Number.isSafeInteger(page.count) || page.count !== page.comments.length || page.count > 100 ||
        !Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || (total !== undefined && total !== page.totalCount)) throw problem('comment page count/total is malformed or changed');
    total = page.totalCount;
    for (const comment of page.comments) {
      const id = comment?.id ?? comment?.commentId;
      if (!validId(id) || (comment.id !== undefined && comment.commentId !== undefined && comment.id !== comment.commentId) || ids.has(id)) throw problem('comment identity is malformed, ambiguous or duplicated');
      if (comment.workItemId !== issue.id || !validUuid(comment.createdBy?.id) || !validDate(comment.createdDate) ||
          !Number.isSafeInteger(comment.version) || comment.version < 1 ||
          (comment.isDeleted !== undefined && typeof comment.isDeleted !== 'boolean') ||
          (comment.modifiedBy !== undefined && !validUuid(comment.modifiedBy?.id)) ||
          (comment.modifiedDate !== undefined && !validDate(comment.modifiedDate)) ||
          (comment.format !== undefined && comment.format !== null && !nonblank(comment.format)) ||
          !(typeof comment.text === 'string' || (comment.isDeleted === true && comment.text === undefined))) throw problem('comment has incomplete work item, author, time, version or native text evidence');
      ids.add(id);
      comments.push({ ...comment, id, body: comment.text ?? '', nativeFormat: comment.format ?? null, format: ['html', 'markdown'].includes(comment.format) ? comment.format : 'unknown legacy',
        isDeleted: comment.isDeleted === true, accountId: comment.createdBy.id, createdAt: new Date(comment.createdDate).toISOString(),
        url: `https://dev.azure.com/${project.config.organization}/${project.id}/_workitems/edit/${issue.id}?discussionId=${id}` });
    }
    if (comments.length > total) throw problem('comment pages exceed their reported total');
    const next = page.continuationToken;
    if (next === undefined || next === null || next === '') {
      if (comments.length !== total) throw problem('comment evidence is incomplete against its reported total');
      break;
    }
    if (!nonblank(next) || cursors.has(next) || page.comments.length === 0 || comments.length === total) throw problem('comment page cursor cannot progress; evidence is incomplete');
    cursors.add(next);
    continuationToken = next;
  }
  return comments.map((comment, index) => ({ ...comment, position: index + 1 }));
}

export function readAzureComments(id, exec = azureExec, project, issue) {
  const number = nativeId(id);
  project ??= readAzureProject(exec);
  return commentsOf(issue ?? issueAt(number, project, exec), project, exec);
}

export function azureCardDetails(exec, ids) {
  let project;
  try {
    ids.forEach(nativeId);
    project = readAzureProject(exec);
  } catch (error) { return new Map(ids.map((number) => [number, { number, unavailable: error.message }])); }
  let rateLimit;
  return new Map(ids.map((number) => {
    if (rateLimit) return [number, { number, unavailable: rateLimit.message }];
    try {
      const issue = issueAt(nativeId(number), project, exec);
      const parent = parentOf(issue, project, exec);
      const comments = commentsOf(issue, project, exec);
      return [number, { number, body: issue.fields['System.Description'] ?? '', bodyFormat: 'html', parent,
        claim: AZURE_CLAIM_ADVISORY,
        comments: comments.map((comment) => `comment ${comment.id} | ${comment.format}${comment.format === 'unknown legacy' && comment.nativeFormat !== null ? ' (' + comment.nativeFormat + ')' : ''} | author ${comment.accountId} | ${comment.createdAt}${comment.isDeleted ? ' | deleted tombstone (not an active claim)' : ''}\n${comment.body}`),
        commentCount: comments.length, commentsUnavailable: null }];
    } catch (error) {
      if (error.rateLimited) rateLimit = error;
      return [number, { number, unavailable: error.message }];
    }
  }));
}
