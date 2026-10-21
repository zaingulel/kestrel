// issue-publish.mjs — pure checks for a published issue, with or without children.
//
// A board card can exist without a Status or routing value, and an issue can be
// linked in a body rather than as a native child. This verifier keeps publication
// honest: every named issue must be on the board with a real Status and, when
// board-config.mjs configures a routing field (Workstream here), a real routing
// value; a board with no routing field is checked for Status only. Every named
// issue must also carry exactly one of the kind labels board-config.mjs records:
// none leaves its kind unstated and two state it twice. A closed card archived on the board is
// read from its own board item and judged the same way; an open archived card fails. Given an
// Epic plus child numbers, its native children must be exactly that set — a count alone passes
// when a forgotten child is offset by a stray one. Given a single number, the count is reported
// rather than asserted, because a lone number cannot distinguish a standalone issue from an Epic
// whose children were forgotten: showing the count resolves that ambiguity visibly.

import { BOARD_OWNER, BOARD_REPOSITORY, KIND_LABELS, ROUTING_FIELD } from './board-config.mjs';
import { lookupIssueBoardItem } from './board-move.mjs';
import { isContentUnresolved, normalizeItem, parseNode } from './board.mjs';

const FIELDS_VERIFIED = ROUTING_FIELD ? `Statuses and ${ROUTING_FIELD}s` : 'Statuses';
const KIND_LABEL_NAMES = Object.values(KIND_LABELS);

export function parseIssuePublishArgs(args) {
  if (!Array.isArray(args) || args.length < 1) {
    throw new Error('expected an issue number, optionally followed by child numbers');
  }

  const numbers = args.map((arg) => {
    if (typeof arg !== 'string' || !/^[1-9]\d*$/.test(arg)) {
      throw new Error(`expected a positive issue number, received ${JSON.stringify(arg)}`);
    }
    const number = Number(arg);
    if (!Number.isSafeInteger(number)) {
      throw new Error(`expected a positive issue number, received ${JSON.stringify(arg)}`);
    }
    return number;
  });

  const seen = new Set();
  for (const number of numbers) {
    if (seen.has(number)) throw new Error(`duplicate issue number #${number}`);
    seen.add(number);
  }

  // No separate `standalone` flag: it would be computed from args.length while the
  // branch it guards is about childNumbers.length. They agree only by construction, and
  // a future arg shape could make them disagree — reporting "standalone" for a call that
  // supplied children. The caller derives it from childNumbers instead.
  return { subjectNumber: numbers[0], childNumbers: numbers.slice(1) };
}

function nativeChildrenQuery(subjectNumber) {
  return `{ repository(owner:"${BOARD_OWNER}", name:"${BOARD_REPOSITORY}") { issue(number:${subjectNumber}) { subIssues(first:100) { totalCount nodes { number } } } } }`;
}

function parseNativeChildren(graphqlResponse) {
  let payload;
  try {
    payload = typeof graphqlResponse === 'string' ? JSON.parse(graphqlResponse) : graphqlResponse;
  } catch {
    throw new Error('native children GraphQL response is not valid JSON');
  }

  const subIssues = payload?.data?.repository?.issue?.subIssues;
  const totalCount = subIssues?.totalCount;
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new Error('native children GraphQL response has no non-negative integer totalCount');
  }
  if (!Array.isArray(subIssues.nodes)) {
    throw new Error('native children GraphQL response has no nodes[] array');
  }
  const numbers = subIssues.nodes.map((node) => {
    if (!Number.isSafeInteger(node?.number) || node.number <= 0) {
      throw new Error(
        `native children GraphQL response has a non-positive-integer child number ${JSON.stringify(node?.number)}`,
      );
    }
    return node.number;
  });
  // A repeated number would survive both the truncation guard and the set comparison —
  // two identical children read as one supplied child and the check would report success.
  if (numbers.length !== new Set(numbers).size) {
    const repeated = numbers.find((number, index) => numbers.indexOf(number) !== index);
    throw new Error(`native children GraphQL response has a duplicate child number #${repeated}`);
  }
  return { totalCount, numbers };
}

export function boardCardsByNumber(items) {
  if (!Array.isArray(items)) throw new Error('board reader returned a non-array item list');
  const cards = new Map();
  let unresolvedCount = 0;
  for (const item of items) {
    const card = normalizeItem(item);
    // Skipped, not rejected: a numberless card cannot be indexed, and rejecting would break
    // any ordinary run against a board holding a draft card, a supported state `formatRow`
    // already renders as `#?`. Skipping hides nothing: a requested number is always a positive
    // integer, so an unindexed card still fails loud in `verifyBoardCards`. Counting the
    // unresolved ones is what lets that failure name the right cause: an unresolved card
    // carries no number, so it can never be matched to a requested issue, but its presence
    // makes "never added" a claim this read cannot support (#572).
    if (!Number.isSafeInteger(card.number) || card.number <= 0) {
      if (isContentUnresolved(item)) unresolvedCount += 1;
      continue;
    }
    if (cards.has(card.number)) {
      throw new Error(`duplicate board cards for issue #${card.number}`);
    }
    cards.set(card.number, card);
  }
  return { cards, unresolvedCount };
}

// The hedged cause, named from the board read alone: the read carried cards it could not
// resolve, so one of them may be the requested issue. Shared by the probe-failure route,
// which must not discard evidence the board read already established.
function unresolvedReadMessage(number, unresolvedCount) {
  return `requested issue #${number} is not on this board read, which returned ${unresolvedCount} card(s) whose content did not resolve — a just-added card lags the board read, so #${number} may be one of them. Re-run this check before adding the card again.`;
}

// The card of a requested issue the board read could not list because it is archived: read
// from the issue-side probe's own board item through the board read's parser, so it is judged
// like a listed card. Only a closed card passes; an open one is the operator's to unarchive, and
// an item that cannot be read as this issue's card is never accepted.
function archivedClosedCard(number, item) {
  const archived = `requested issue #${number} is archived on the board`;
  let card;
  try {
    card = normalizeItem(parseNode(item));
  } catch (err) {
    throw new Error(`${archived}, but its board item could not be read: ${err.message}`);
  }
  if (card.number !== number) {
    throw new Error(
      `${archived}, but its board item could not be read: its content resolved to ${card.number == null ? 'no issue' : `#${card.number}`}`,
    );
  }
  if (card.state !== 'CLOSED') {
    throw new Error(`${archived} while still open, so this read — which lists only unarchived cards — does not show it; unarchive the card rather than adding it again.`);
  }
  return card;
}

// Returns the requested numbers that were verified from an archived board item.
function verifyBoardCards(numbers, cardsByNumber, unresolvedCount, ghExec) {
  const archivedNumbers = [];
  for (const number of numbers) {
    let card = cardsByNumber.get(number);
    if (!card) {
      // Every way out of here but a closed archived card is a failure — the ordering only names
      // the cause the operator should act on, and never softens the verdict on a read the check
      // could not confirm (#572):
      // 1. the probe failed and the read returned unresolved cards → the evidence the read DID
      //    establish beats the evidence the probe could not: report the hedged cause;
      // 2. the probe failed on a clean read → no cause is established at all, so say only that;
      // 3. the issue reports an ARCHIVED item on this project → the board read lists unarchived
      //    cards only, so that item is the card's one view: a closed card is read from it and
      //    checked below like a listed one, and an open card fails, since unarchiving is the only fix;
      // 4. it reports an unarchived item on THIS project → the board read lagged, positively identified;
      // 5. no item on this project → the hedged cause if the read was dirty, otherwise a
      //    confirmed absence, not an inference from nothing.
      let probe;
      try {
        probe = lookupIssueBoardItem(number, ghExec, { card: true }).item;
      } catch (err) {
        if (unresolvedCount > 0) throw new Error(unresolvedReadMessage(number, unresolvedCount));
        throw new Error(
          `could not confirm whether issue #${number} is on the board: ${err.message}`,
        );
      }
      if (probe?.isArchived) {
        card = archivedClosedCard(number, probe);
        archivedNumbers.push(number);
      } else if (probe) {
        throw new Error(`requested issue #${number} is on the board but not in this board read, which lagged the card; re-run this check rather than adding the card again.`);
      } else {
        throw new Error(unresolvedCount > 0
          ? unresolvedReadMessage(number, unresolvedCount)
          : `requested issue #${number} is absent from the board`);
      }
    }
    if (ROUTING_FIELD && (typeof card.routing !== 'string' || card.routing.trim() === '')) {
      throw new Error(`requested issue #${number} has no non-empty ${ROUTING_FIELD}`);
    }
    if (typeof card.status !== 'string' || card.status.trim() === '') {
      throw new Error(`requested issue #${number} has no non-empty Status`);
    }
    if (card.labels.some((label) => typeof label !== 'string')) {
      throw new Error(`requested issue #${number} has a label whose name is not text`);
    }
    const kindLabelCount = card.labels.filter((label) => KIND_LABEL_NAMES.includes(label)).length;
    if (kindLabelCount !== 1) {
      throw new Error(
        `requested issue #${number} needs exactly one kind label (${KIND_LABEL_NAMES.join(', ')}) but has ${kindLabelCount} (labels found: ${card.labels.length === 0 ? 'none' : card.labels.join(', ')})`,
      );
    }
  }
  return archivedNumbers;
}

function formatNumbers(numbers) {
  return numbers.length === 0 ? 'none' : numbers.map((number) => `#${number}`).join(', ');
}

// The transport functions are injected so the verifier is deterministic in
// tests. The board is deliberately read once, then the subject gets one native
// `subIssues` query for its total and its child numbers: no raw project-list read.
// The board-item probe is one extra request for each requested card the board read
// lacks, which fails unless the probe finds it closed and archived.
export function verifyIssuePublication(args, { fetchBoard, ghExec }) {
  const { subjectNumber, childNumbers } = parseIssuePublishArgs(args);
  const standalone = childNumbers.length === 0;
  const requestedNumbers = [subjectNumber, ...childNumbers];
  const { cards, unresolvedCount } = boardCardsByNumber(fetchBoard(ghExec));
  const archivedNumbers = verifyBoardCards(requestedNumbers, cards, unresolvedCount, ghExec);

  const response = ghExec([
    'api', 'graphql', '-f', `query=${nativeChildrenQuery(subjectNumber)}`,
  ]);
  const { totalCount, numbers: nativeChildNumbers } = parseNativeChildren(response);
  const requested = formatNumbers(requestedNumbers);
  const verified = [
    `issue-publish: board presence verified for ${requested}.`,
    `issue-publish: ${FIELDS_VERIFIED} verified for ${requested}.`,
    `issue-publish: exactly one kind label verified for ${requested}.`,
    ...(archivedNumbers.length === 0 ? [] : [
      `issue-publish: closed cards archived on the board, verified from their own board items: ${formatNumbers(archivedNumbers)}.`,
    ]),
  ];

  // The standalone branch compares nothing, so a truncated page cannot mislead it:
  // `totalCount` is accurate however many nodes were read.
  if (standalone) {
    return [
      ...verified,
      `issue-publish: #${subjectNumber} verified as a standalone issue; it has ${totalCount} native child issues (none supplied; pass them as arguments to verify an Epic).`,
    ];
  }

  // Guard before any comparison: a partial page compared as if complete would report
  // absent children that are merely on page two.
  if (nativeChildNumbers.length !== totalCount) {
    throw new Error(
      `#${subjectNumber} reports ${totalCount} native child issues but the check read only one page of ${nativeChildNumbers.length}; the comparison would be incomplete`,
    );
  }

  const nativeSet = new Set(nativeChildNumbers);
  const suppliedSet = new Set(childNumbers);
  const ascending = (a, b) => a - b;
  const notNative = childNumbers.filter((number) => !nativeSet.has(number)).sort(ascending);
  const notSupplied = nativeChildNumbers.filter((number) => !suppliedSet.has(number)).sort(ascending);
  if (notNative.length > 0 || notSupplied.length > 0) {
    throw new Error(
      `Epic #${subjectNumber} child mismatch: supplied but not native children: ${formatNumbers(notNative)}; native children but not supplied: ${formatNumbers(notSupplied)}`,
    );
  }

  return [
    ...verified,
    `issue-publish: native child set verified: #${subjectNumber} has exactly the ${childNumbers.length} supplied child issues.`,
  ];
}
