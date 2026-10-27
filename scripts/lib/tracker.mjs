// tracker.mjs — which tracker an install runs, and how a card's identity prints and sorts on all
// of them. Pure and free of any configuration import, so every tool can share it.
//
// A GitHub or markdown card is identified by a positive integer. A Linear card is identified by
// its identifier string such as ENG-123 (Issue.identifier; the prefix is Team.key), so on a Linear
// board every field the other trackers call a number carries that string.

const TRACKERS = ['github', 'markdown', 'linear'];

// A configuration without TRACKER is a GitHub install; any other value is refused, so a typo can
// never silently pick another tracker.
export function trackerOf(config) {
  const tracker = config.TRACKER === undefined ? 'github' : config.TRACKER;
  if (!TRACKERS.includes(tracker)) {
    throw new Error(`scripts/lib/board-config.mjs: TRACKER must be "github", "markdown" or "linear"; found ${JSON.stringify(config.TRACKER)}`);
  }
  return tracker;
}

export const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;

// A Linear identifier prints as it is. Anything else prints as `#<value>`, so every GitHub and
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

// Null sorts last. Two numbers compare numerically. Two identifiers compare by team, then by the
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
