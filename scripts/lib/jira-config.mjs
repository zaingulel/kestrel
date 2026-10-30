// Validate customer-owned Jira configuration before any provider request.
const COLUMNS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
const KINDS = ['epic', 'feature', 'task', 'bug', 'docs'];
const POSITIVE_ID = /^[1-9]\d*$/;
const SITE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const found = Object.keys(value);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const extra = found.filter((key) => !keys.includes(key));
  if (missing.length || extra.length) {
    throw new Error(`${label} must contain exactly ${keys.join(', ')}; missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'}`);
  }
}

function mapping(value, keys, label) {
  exactKeys(value, keys, label);
  for (const key of keys) {
    if (typeof value[key] !== 'string' || !POSITIVE_ID.test(value[key])) {
      throw new Error(`${label}.${key} must be a positive decimal ID string without leading zeros`);
    }
  }
  return Object.freeze({ ...value });
}

export function validateJiraConfig(value, label = 'JIRA_CONFIG') {
  exactKeys(value, ['site', 'project', 'states', 'issueTypes', 'blockLinkType'], label);
  if (typeof value.site !== 'string' || !SITE.test(value.site)) {
    throw new Error(`${label}.site must be an exact https://<tenant>.atlassian.net origin without credentials, path, query, fragment or port`);
  }
  if (typeof value.project !== 'string' || !/^[A-Z][A-Z0-9]+$/.test(value.project)) {
    throw new Error(`${label}.project must be a project key in capitals, such as ENG`);
  }
  const states = mapping(value.states, COLUMNS, `${label}.states`);
  if (new Set(Object.values(states)).size !== COLUMNS.length) {
    throw new Error(`${label}.states must use a distinct status ID for every column`);
  }
  const issueTypes = mapping(value.issueTypes, KINDS, `${label}.issueTypes`);
  if (typeof value.blockLinkType !== 'string' || !POSITIVE_ID.test(value.blockLinkType)) {
    throw new Error(`${label}.blockLinkType must be a positive decimal ID string without leading zeros`);
  }
  return Object.freeze({ site: value.site, project: value.project, states, issueTypes, blockLinkType: value.blockLinkType });
}
