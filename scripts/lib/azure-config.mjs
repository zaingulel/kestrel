const COLUMNS = ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done'];
const KINDS = ['epic', 'feature', 'task', 'bug', 'docs'];
const FIELDS = ['organization', 'project', 'workItemTypes', 'states'];
const ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,47}[A-Za-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- Reject ASCII and C1 controls in untrusted configuration.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;

function exactKeys(value, keys, label, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (Reflect.ownKeys(value).length !== keys.length
      || keys.some((key) => !Object.hasOwn(value, key))) {
    // Unexpected keys and native type names can themselves contain credentials.
    throw new Error(`${label} must contain exactly ${expected}`);
  }
}

function nativeName(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || CONTROLS.test(value)) {
    throw new Error(`${label} must be a nonblank string of at most 255 code units without control characters`);
  }
}

export function validateAzureConfig(value, label = 'AZURE_CONFIG') {
  exactKeys(value, FIELDS, label, FIELDS.join(', '));
  nativeName(value.organization, `${label}.organization`);
  if (!ORGANIZATION.test(value.organization)) {
    throw new Error(`${label}.organization must be a 1-49 character organization slug with letters, digits or hyphens and alphanumeric ends`);
  }
  if (typeof value.project !== 'string' || value.project.length !== 36 || !UUID.test(value.project)) {
    throw new Error(`${label}.project must be a UUID in hexadecimal 8-4-4-4-12 form`);
  }
  exactKeys(value.workItemTypes, KINDS, `${label}.workItemTypes`, KINDS.join(', '));
  for (const kind of KINDS) nativeName(value.workItemTypes[kind], `${label}.workItemTypes.${kind}`);
  const types = [...new Set(Object.values(value.workItemTypes))];
  exactKeys(value.states, types, `${label}.states`, 'the configured work item types');
  const states = Object.fromEntries(types.map((type) => {
    const mapping = value.states[type];
    exactKeys(mapping, COLUMNS, `${label}.states`, COLUMNS.join(', '));
    for (const column of COLUMNS) nativeName(mapping[column], `${label}.states.${column}`);
    if (new Set(Object.values(mapping)).size !== COLUMNS.length) {
      throw new Error(`${label}.states must use a distinct native state for every column of each work item type`);
    }
    return [type, Object.freeze({ ...mapping })];
  }));
  return Object.freeze({
    organization: value.organization,
    project: value.project.toLowerCase(),
    workItemTypes: Object.freeze({ ...value.workItemTypes }),
    states: Object.freeze(states),
  });
}
