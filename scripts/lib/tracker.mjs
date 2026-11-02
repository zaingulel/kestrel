// tracker.mjs — which tracker an install runs, whether it records a card's kind as a native issue
// type, and how a card's identity prints and sorts on all of them. Pure and free of any
// configuration import, so every tool can share it.
//
// A GitHub or markdown card is identified by a positive integer. A Linear or Jira card carries
// an issue key such as ENG-123, with a team or project prefix, in fields the other trackers call
// a number. An Azure Boards work item uses AB-<positive int32>.

const TRACKERS = ['github', 'markdown', 'linear', 'jira', 'azure'];

// A configuration without TRACKER is a GitHub install; any other value is refused, so a typo can
// never silently pick another tracker.
export function trackerOf(config) {
  const tracker = config.TRACKER === undefined ? 'github' : config.TRACKER;
  if (!TRACKERS.includes(tracker)) {
    throw new Error(`scripts/lib/board-config.mjs: TRACKER must be "github", "markdown", "linear", "jira" or "azure"; found ${JSON.stringify(config.TRACKER)}`);
  }
  return tracker;
}

const KINDS = ['epic', 'feature', 'task', 'bug', 'docs'];

// A configuration without KIND_TYPES keeps its kinds as labels and answers null. One that exports it
// chooses GitHub native issue types, which only a GitHub organisation's repositories have, and is
// otherwise refused, so a misplaced map can never silently fall back to labels. Checked after the
// absence, so a bad TRACKER keeps the refusal trackerOf gives it. The map holds the five kinds, each
// a unique trimmed type name, because a type two kinds shared would make every such card an epic.
export function kindTypesOf(config) {
  const types = config.KIND_TYPES;
  if (types === undefined) return null;
  const tracker = trackerOf(config);
  if (tracker !== 'github') {
    throw new Error(`scripts/lib/board-config.mjs: KIND_TYPES chooses GitHub native issue types, which apply only to the GitHub tracker, but TRACKER is "${tracker}"; remove KIND_TYPES`);
  }
  if (config.BOARD_OWNER_TYPE !== 'organization') {
    throw new Error(`scripts/lib/board-config.mjs: KIND_TYPES chooses GitHub native issue types, which only an organisation's repositories have, but BOARD_OWNER_TYPE is "${config.BOARD_OWNER_TYPE}"; remove KIND_TYPES`);
  }
  const valid = types !== null && typeof types === 'object' && !Array.isArray(types)
    && Object.keys(types).length === KINDS.length
    && KINDS.every((kind) => typeof types[kind] === 'string' && types[kind] !== '' && types[kind] === types[kind].trim())
    && new Set(Object.values(types)).size === KINDS.length;
  if (!valid) {
    throw new Error(`scripts/lib/board-config.mjs: KIND_TYPES must map exactly the kinds ${KINDS.join(', ')} to unique non-empty type names`);
  }
  return types;
}

export const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;
export const JIRA_IDENTIFIER = /^[A-Z][A-Z0-9]+-[1-9]\d*$/;

export function isAzureIdentifier(id) {
  return typeof id === 'string' && /^AB-[1-9]\d*$/.test(id) && Number(id.slice(3)) <= 2147483647;
}

// An issue key prints as it is. Anything else prints as `#<value>`, so every GitHub and
// markdown output stays as it was, including the string sentinels `(summary)` and `?` that the
// unfielded rule supplies in place of a number.
export function cardRef(id) {
  return typeof id === 'string' && LINEAR_IDENTIFIER.test(id) ? id : `#${id}`;
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const splitIdentifier = (id) => {
  const dash = id.lastIndexOf('-');
  return [id.slice(0, dash), id.slice(dash + 1)];
};

// Null sorts last. Two numbers compare numerically. Two issue keys compare by prefix, then by the
// digit string's length, then the digit string itself, so a number is never converted and ENG-9
// sorts before ENG-10. A number sorts before an identifier.
export function compareCardIds(a, b) {
  if (a == null || b == null) return (a == null) - (b == null);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  const [teamA, digitsA] = splitIdentifier(a);
  const [teamB, digitsB] = splitIdentifier(b);
  return compareText(teamA, teamB) || digitsA.length - digitsB.length || compareText(digitsA, digitsB);
}
