// Native Jira reads become the common board shape only after complete identity and paging checks.
import * as boardConfig from './board-config.mjs';
import { jiraExec } from './jira-api.mjs';
import { validateJiraConfig } from './jira-config.mjs';
import { ghExec as defaultGhExec } from './gh-exec.mjs';
import { JIRA_IDENTIFIER } from './tracker.mjs';

const FIELDS = 'summary,status,project,issuetype,labels,assignee,parent,issuelinks,description';
const ID = /^[1-9]\d*$/;
const CATEGORIES = new Set(['new', 'indeterminate', 'done']);
const nonblank = (value) => typeof value === 'string' && value.trim() !== '';
const validId = (value) => typeof value === 'string' && ID.test(value);
const problem = (message) => new Error(`Jira ${message}`);
const get = (exec, path, query) => exec({ method: 'GET', path, ...(query === undefined ? {} : { query }) });
const stateOf = (status) => status.statusCategory.key === 'done' ? 'CLOSED' : 'OPEN';

function checkedStatus(status) {
  if (!validId(status?.id) || !nonblank(status.name) || !CATEGORIES.has(status.statusCategory?.key)) throw problem('returned a malformed status or category');
  return status;
}

export function readJiraProject(exec = jiraExec) {
  const config = validateJiraConfig(boardConfig.JIRA_CONFIG, 'Jira board-config.mjs JIRA_CONFIG');
  if (boardConfig.BOARD_PROJECT_NUMBER !== null || boardConfig.ROUTING_FIELD !== null ||
      !Array.isArray(boardConfig.ROUTING_OPTIONS) || boardConfig.ROUTING_OPTIONS.length !== 0 || boardConfig.PARKED_LANE !== null) {
    throw problem('board-config.mjs must have no GitHub project number, routing field/options or parked lane');
  }
  const project = get(exec, `/rest/api/3/project/${config.project}`);
  if (!validId(project?.id) || project.key !== config.project || !Array.isArray(project.issueTypes)) throw problem(`project metadata does not identify ${config.project}`);
  const types = new Map();
  for (const type of project.issueTypes) {
    if (!validId(type?.id) || !Number.isInteger(type.hierarchyLevel) || types.has(type.id)) throw problem('project has malformed or duplicate issue types');
    types.set(type.id, type);
  }
  for (const [kind, id] of Object.entries(config.issueTypes)) {
    if (types.get(id)?.hierarchyLevel !== (kind === 'epic' ? 1 : 0)) throw problem(`issue type ${id} has incompatible hierarchy for ${kind}`);
  }
  const metadata = get(exec, `/rest/api/3/project/${config.project}/statuses`);
  if (!Array.isArray(metadata)) throw problem('project statuses metadata is not an array');
  const statuses = new Map();
  const typeIds = new Set();
  for (const type of metadata) {
    if (!types.has(type?.id) || typeIds.has(type.id) || !Array.isArray(type.statuses)) throw problem('project statuses have malformed or duplicate issue types');
    typeIds.add(type.id);
    const given = new Set();
    for (const candidate of type.statuses) {
      const status = checkedStatus(candidate);
      if (given.has(status.id)) throw problem(`duplicate status ${status.id} in issue type ${type.id}`);
      given.add(status.id);
      if (statuses.has(status.id) && statuses.get(status.id).statusCategory.key !== status.statusCategory.key) throw problem(`status ${status.id} has inconsistent categories`);
      statuses.set(status.id, status);
    }
  }
  for (const id of new Set(Object.values(config.issueTypes))) if (!typeIds.has(id)) throw problem(`project statuses omit mapped issue type ${id}`);
  for (const [column, id] of Object.entries(config.states)) {
    const status = statuses.get(id);
    if (!status) throw problem(`project has no status ${id} mapped to ${column}`);
    if ((status.statusCategory.key === 'done') !== (column === 'Done')) throw problem(`status category for ${column} is incompatible with Done meaning`);
  }
  const links = get(exec, '/rest/api/3/issueLinkType');
  if (!Array.isArray(links?.issueLinkTypes)) throw problem('issue link types are unavailable');
  const linkIds = new Set();
  for (const type of links.issueLinkTypes) {
    if (!validId(type?.id) || linkIds.has(type.id) || ![type.name, type.inward, type.outward].every(nonblank)) throw problem('issue link types are malformed or duplicated');
    linkIds.add(type.id);
  }
  const linkType = links.issueLinkTypes.find(({ id }) => id === config.blockLinkType);
  if (!linkType) throw problem(`configured blocking link type ${config.blockLinkType} is missing`);
  const columns = new Map(Object.entries(config.states).map(([column, id]) => [id, column]));
  return { id: project.id, key: project.key, config, types, statuses, linkType, columnOf: (status) => columns.get(status.id) ?? null };
}

function issueKey(key, project) {
  if (typeof key !== 'string' || !JIRA_IDENTIFIER.test(key) || !key.startsWith(`${project.key}-`)) throw problem(`issue ${key} is outside configured project ${project.key}`);
  return key;
}

function checkedIssue(issue, project, expected) {
  if (!validId(issue?.id)) throw problem('issue has no valid identity');
  issueKey(issue.key, project);
  if (expected !== undefined && issue.key !== expected) throw problem(`returned ${issue.key} for requested ${expected}`);
  if (issue.fields?.project?.id !== project.id || issue.fields.project.key !== project.key) throw problem(`issue ${issue.key} belongs to a different project`);
  if (!nonblank(issue.fields.summary)) throw problem(`issue ${issue.key} has missing, blank or non-string summary`);
  if (issue.fields.description === undefined) throw problem(`issue ${issue.key} has unavailable description evidence`);
  checkedStatus(issue.fields.status);
  if (!project.types.has(issue.fields.issuetype?.id)) throw problem(`issue ${issue.key} has a type outside its project`);
  return issue;
}

function issueAt(key, project, exec) {
  issueKey(key, project);
  return checkedIssue(get(exec, `/rest/api/3/issue/${key}`, { fields: FIELDS }), project, key);
}

export function readJiraIssue(key, exec = jiraExec) {
  return issueAt(key, readJiraProject(exec), exec);
}

function searchIssues(jql, project, exec, post = false) {
  const issues = [];
  const ids = new Set();
  const keys = new Set();
  const cursors = new Set();
  let nextPageToken;
  let total;
  for (;;) {
    const query = { jql, fields: post ? FIELDS.split(',') : FIELDS, maxResults: 100, ...(nextPageToken === undefined ? {} : { nextPageToken }) };
    const page = post
      ? exec({ method: 'POST', path: '/rest/api/3/search/jql', body: query })
      : get(exec, '/rest/api/3/search/jql', query);
    if (!Array.isArray(page?.issues) || typeof page.isLast !== 'boolean') throw problem('search page is malformed or incomplete');
    if (page.total !== undefined) {
      if (!Number.isSafeInteger(page.total) || page.total < 0 || (total !== undefined && total !== page.total)) throw problem('search page total is malformed or changed');
      total = page.total;
    }
    for (const native of page.issues) {
      const issue = checkedIssue(native, project);
      if (ids.has(issue.id) || keys.has(issue.key)) throw problem(`duplicate issue identity ${issue.key} across search pages`);
      ids.add(issue.id);
      keys.add(issue.key);
      issues.push(issue);
    }
    if (total !== undefined && issues.length > total) throw problem('search exceeded its reported total');
    if (page.isLast) {
      if (total !== undefined && issues.length !== total) throw problem('search is incomplete against its reported total');
      return issues;
    }
    if (!nonblank(page.nextPageToken) || cursors.has(page.nextPageToken) || page.issues.length === 0) throw problem('search page cursor cannot progress; evidence is incomplete');
    cursors.add(page.nextPageToken);
    nextPageToken = page.nextPageToken;
  }
}

function relatedIssue(relation, project, exec, directIssues) {
  if (!validId(relation?.id)) throw problem('relationship has no issue identity');
  const issue = directIssues?.get(relation.key) ?? issueAt(relation.key, project, exec);
  if (issue.id !== relation.id) throw problem(`relationship for ${relation.key} returned another issue ID`);
  directIssues?.set(relation.key, issue);
  return issue;
}

function parentOf(issue, project, exec, directIssues) {
  return issue.fields.parent == null ? null : relatedIssue(issue.fields.parent, project, exec, directIssues).key;
}

function childrenOf(parent, project, exec) {
  const issues = searchIssues(`parent = ${parent.key} ORDER BY key ASC`, project, exec);
  for (const child of issues) {
    if (child.fields.parent?.key !== parent.key || child.fields.parent.id !== parent.id || child.id === parent.id) throw problem(`child ${child.key} does not identify the requested parent ${parent.key}`);
  }
  return { issues, total: issues.length, completed: issues.filter((child) => stateOf(child.fields.status) === 'CLOSED').length };
}

export function readJiraChildren(key, exec = jiraExec) {
  const project = readJiraProject(exec);
  return childrenOf(issueAt(key, project, exec), project, exec);
}

function boardChildren(issues, project, exec) {
  const counts = new Map(issues.map(({ key }) => [key, { total: 0, completed: 0 }]));
  const ids = new Set();
  const keys = new Set();
  for (let offset = 0; offset < issues.length; offset += 50) {
    const parents = new Map(issues.slice(offset, offset + 50).map(({ key, id }) => [key, id]));
    const children = searchIssues(`parent IN (${[...parents.keys()].join(', ')}) ORDER BY key ASC`, project, exec, true);
    for (const child of children) {
      if (ids.has(child.id) || keys.has(child.key)) throw problem(`duplicate child identity ${child.key} across child batches`);
      const parent = parents.get(child.fields.parent?.key);
      if (parent === undefined || child.fields.parent.id !== parent || child.id === parent || child.key === child.fields.parent.key) {
        throw problem(`child ${child.key} does not identify a requested parent`);
      }
      ids.add(child.id);
      keys.add(child.key);
      const count = counts.get(child.fields.parent.key);
      count.total++;
      if (stateOf(child.fields.status) === 'CLOSED') count.completed++;
    }
  }
  return counts;
}

function blockersOf(issue, project, exec, directIssues) {
  if (!Array.isArray(issue.fields.issuelinks)) throw problem(`issue ${issue.key} has unavailable issue links`);
  const blockers = [];
  const given = new Set();
  for (const link of issue.fields.issuelinks) {
    if (!validId(link?.id) || given.has(link.id) || !validId(link.type?.id)) throw problem(`issue ${issue.key} has malformed or duplicate links`);
    given.add(link.id);
    if (link.type.id !== project.config.blockLinkType) continue;
    if (Boolean(link.inwardIssue) === Boolean(link.outwardIssue)) throw problem(`blocking link ${link.id} has ambiguous direction`);
    if (link.outwardIssue) continue;
    const target = relatedIssue(link.inwardIssue, project, exec, directIssues);
    blockers.push({ number: target.key, state: stateOf(target.fields.status) });
  }
  return blockers;
}

function closingPulls(keys, ghExec) {
  const name = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;
  let pages;
  try { pages = JSON.parse(ghExec(['api', `repos/${name}/pulls?state=all&per_page=100`, '--paginate', '--slurp'])); }
  catch (error) { throw new Error(`GitHub pull-request pages are unavailable: ${error.message}`); }
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every(Array.isArray)) throw new Error('GitHub pull-request pages are malformed or incomplete');
  const matches = new Map(keys.map((key) => [key, []]));
  const seen = new Set();
  for (const pull of pages.flat()) {
    if (!Number.isSafeInteger(pull?.number) || pull.number < 1 || seen.has(pull.number)) throw new Error('GitHub returned malformed or duplicate pull-request identities');
    seen.add(pull.number);
    if (!['open', 'closed'].includes(pull.state) || typeof pull.draft !== 'boolean' ||
        typeof pull.head?.ref !== 'string' || typeof pull.base?.ref !== 'string' ||
        typeof pull.base.repo?.full_name !== 'string' ||
        !(pull.head.repo === null || typeof pull.head.repo?.full_name === 'string') ||
        !(pull.body === null || typeof pull.body === 'string') ||
        !(pull.merged_at === null || (typeof pull.merged_at === 'string' && Number.isFinite(Date.parse(pull.merged_at))))) throw new Error('GitHub pull-request evidence is malformed');
    if (pull.state !== 'open' && pull.merged_at === null) continue;
    if (pull.head.repo?.full_name !== name || pull.base.repo.full_name !== name || pull.base.ref !== 'main') continue;
    for (const key of keys) {
      if (pull.head.ref === `job/${key}` && (pull.body ?? '').split(/\r?\n/).includes(`Closes ${key}`)) matches.get(key).push({ number: pull.number });
    }
  }
  return matches;
}

export function readJiraBoard(exec = jiraExec, ghExec = defaultGhExec) {
  const project = readJiraProject(exec);
  const issues = searchIssues(`project = ${project.key} ORDER BY key ASC`, project, exec);
  const pulls = closingPulls(issues.map(({ key }) => key), ghExec);
  const children = boardChildren(issues, project, exec);
  const directIssues = new Map();
  const items = issues.map((issue) => {
    const { fields } = issue;
    if (!Array.isArray(fields.labels) || !fields.labels.every((label) => typeof label === 'string') ||
        !(fields.assignee === null || nonblank(fields.assignee?.accountId))) throw problem(`issue ${issue.key} has incomplete labels or assignee evidence`);
    parentOf(issue, project, exec, directIssues);
    const { total, completed } = children.get(issue.key);
    return {
      id: issue.id, status: project.columnOf(fields.status), title: fields.summary, routing: null,
      labels: fields.labels, assignees: fields.assignee === null ? [] : [fields.assignee.accountId],
      blockers: blockersOf(issue, project, exec, directIssues), closingPullRequests: pulls.get(issue.key),
      content: { __typename: 'Issue', number: issue.key, state: stateOf(fields.status), subIssuesSummary: { total, completed } },
    };
  });
  return { items };
}

// ADF remains native JSON: each supported container keeps its text boundaries, never Markdown parsing.
export function adfText(document) {
  if (document === null) return '';
  if (document?.type !== 'doc' || document.version !== 1) throw problem('ADF description is not a version 1 document');
  if (!Array.isArray(document.content)) throw problem('ADF document content must be an array');
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') throw problem('ADF node is malformed');
    if (node.type === 'text') {
      if (typeof node.text !== 'string') throw problem('ADF text leaf is malformed');
      const marks = node.marks === undefined ? [] : node.marks;
      if (!Array.isArray(marks)) throw problem('ADF text marks are malformed');
      let text = node.text;
      for (const mark of marks) {
        if (!nonblank(mark?.type)) throw problem('ADF text mark is malformed');
        if (mark.type !== 'link') continue;
        const href = mark.attrs?.href;
        if (!nonblank(href)) throw problem('ADF link mark href is missing or malformed');
        if (node.text !== href) text += ` (${href})`;
      }
      return text;
    }
    if (node.type === 'inlineCard') {
      if (!nonblank(node.attrs?.url) || Object.hasOwn(node.attrs, 'data')) throw problem('ADF inlineCard requires a nonblank URL without embedded data');
      return node.attrs.url;
    }
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'mention' || node.type === 'emoji') {
      const text = node.type === 'mention' ? node.attrs?.text : node.attrs?.shortName;
      if (!nonblank(text)) throw problem(`ADF ${node.type} has no text`);
      return text;
    }
    const inline = ['paragraph', 'heading', 'codeBlock'];
    const block = ['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'table', 'tableCell', 'tableHeader'];
    if (![...inline, ...block, 'tableRow'].includes(node.type)) throw problem(`unsupported meaningful ADF node ${node.type}`);
    const content = node.content ?? [];
    if (!Array.isArray(content)) throw problem(`ADF ${node.type} content is malformed`);
    return content.map(walk).join(inline.includes(node.type) ? '' : node.type === 'tableRow' ? '\t' : '\n');
  };
  return walk(document);
}

function commentsOf(issue, project, exec) {
  const comments = [];
  const given = new Set();
  let startAt = 0;
  let total;
  for (;;) {
    const page = get(exec, `/rest/api/3/issue/${issue.key}/comment`, { startAt, maxResults: 100 });
    if (!Array.isArray(page?.comments) || page.startAt !== startAt || !Number.isSafeInteger(page.total) || page.total < 0 ||
        !Number.isSafeInteger(page.maxResults) || page.maxResults < 1 || page.comments.length > page.maxResults ||
        (total !== undefined && page.total !== total)) throw problem(`comment page for ${issue.key} has malformed total or offset`);
    total = page.total;
    for (const comment of page.comments) {
      if (!validId(comment?.id) || given.has(comment.id)) throw problem(`duplicate or malformed comment identity on ${issue.key}`);
      given.add(comment.id);
      if (!nonblank(comment.author?.accountId) || typeof comment.created !== 'string' || !Number.isFinite(Date.parse(comment.created)) || comment.body?.type !== 'doc') throw problem(`comment ${comment.id} has incomplete author, time or ADF evidence`);
      if (comment.self !== undefined && ![`${project.config.site}/rest/api/3/issue/${issue.id}/comment/${comment.id}`, `${project.config.site}/rest/api/3/issue/${issue.key}/comment/${comment.id}`].includes(comment.self)) throw problem(`comment ${comment.id} belongs to another issue or site`);
      comments.push({ ...comment, body: adfText(comment.body), accountId: comment.author.accountId, createdAt: new Date(comment.created).toISOString(), url: `${project.config.site}/browse/${issue.key}?focusedCommentId=${comment.id}` });
    }
    startAt += page.comments.length;
    if (startAt > total) throw problem(`comment pages for ${issue.key} exceed the reported total`);
    if (startAt === total) break;
    if (page.comments.length === 0) throw problem(`comment page for ${issue.key} cannot progress; evidence is incomplete`);
  }
  comments.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return comments.map((comment, index) => ({ ...comment, position: index + 1 }));
}

export function readJiraComments(key, exec = jiraExec) {
  const project = readJiraProject(exec);
  return commentsOf(issueAt(key, project, exec), project, exec);
}

export function jiraCardDetails(exec, ids) {
  let project;
  try { project = readJiraProject(exec); }
  catch (error) { return new Map(ids.map((number) => [number, { number, unavailable: error.message }])); }
  let rateLimit;
  return new Map(ids.map((number) => {
    if (rateLimit) return [number, { number, unavailable: rateLimit.message }];
    try {
      const issue = issueAt(number, project, exec);
      const parent = parentOf(issue, project, exec);
      const body = adfText(issue.fields.description);
      const comments = commentsOf(issue, project, exec);
      return [number, { number, body, parent, comments: comments.map((comment) => comment.body), commentCount: comments.length, commentsUnavailable: null }];
    } catch (error) {
      if (error.rateLimited) rateLimit = error;
      return [number, { number, unavailable: error.message }];
    }
  }));
}

// Card filing shares the complete project scan without fetching unrelated children or GitHub evidence.
export function readJiraIssues(exec = jiraExec) {
  const project = readJiraProject(exec);
  return { project, issues: searchIssues(`project = ${project.key} ORDER BY key ASC`, project, exec) };
}

export const readJiraBlockers = blockersOf;

export function moveJiraCards(pairs, exec = jiraExec) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw problem('move requires at least one card/status pair');
  const project = readJiraProject(exec);
  const completed = [];
  for (const { issueNumber, statusName } of pairs) {
    try {
      const column = Object.keys(project.config.states).find((name) => name.toLowerCase() === String(statusName).trim().toLowerCase());
      if (!column) throw problem(`unknown status ${statusName}`);
      const target = project.config.states[column];
      const issue = issueAt(issueNumber, project, exec);
      if (issue.fields.status.id === target) {
        completed.push({ issueNumber, statusName: column, skipped: true });
        continue;
      }
      const available = get(exec, `/rest/api/3/issue/${issueNumber}/transitions`, { expand: 'transitions.fields' });
      if (!Array.isArray(available?.transitions)) throw problem('available transitions are malformed');
      const ids = new Set();
      for (const transition of available.transitions) {
        if (!validId(transition?.id) || ids.has(transition.id)) throw problem('available transitions have malformed or duplicate identities');
        ids.add(transition.id);
        checkedStatus(transition.to);
      }
      const choices = available.transitions.filter((transition) => transition.to.id === target);
      if (choices.length !== 1) throw problem(`expected one unique transition to ${column}, found ${choices.length}`);
      const [transition] = choices;
      if (!transition.fields || typeof transition.fields !== 'object' || Array.isArray(transition.fields)) throw problem('transition field metadata is unavailable');
      for (const [name, field] of Object.entries(transition.fields)) {
        if (typeof field?.required !== 'boolean') throw problem(`transition field metadata for ${name} is malformed`);
        if (field.required && field.hasDefaultValue !== true) throw problem(`transition requires unsupported field ${name}; configure a satisfiable transition before moving`);
      }
      exec({ method: 'POST', path: `/rest/api/3/issue/${issueNumber}/transitions`, body: { transition: { id: transition.id } } });
      if (issueAt(issueNumber, project, exec).fields.status.id !== target) throw problem(`status read-back did not confirm ${issueNumber} in ${column}`);
      completed.push({ issueNumber, statusName: column, skipped: false });
    } catch (error) {
      throw new Error(`Jira failed to move ${issueNumber} to ${statusName}; completed ${completed.map((pair) => `${pair.issueNumber} ${pair.statusName}`).join(', ') || 'none'}; ${error.message}; inspect current status before retrying`);
    }
  }
  return completed;
}
