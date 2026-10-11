// board-rules.test.mjs — mutation-proof unit tests for the eight board drift rules.
// Run: node --test scripts/lib/   (or `npm run test:scripts`)
//
// The rules are judged from ONE board read, so every rule test drives the real
// scanBoard over parsed board items rather than the rule function alone: a rule that
// is never called from scanBoard sees no card, and a test that only called the pure
// predicate would stay green while the board reported clean. Each rule test carries a
// twin card that must NOT produce the row, so a rule widened into a false alarm fails
// here too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_OWNER,
  KIND_LABELS,
  PICKABLE_STATUSES,
  ROUTING_FIELD,
  TERMINAL_STATUSES,
  WAIT_STATUSES,
} from './board-config.mjs';
import { leanBoardPage, leanNode } from './board-fixtures.mjs';
import { normalizeItem, parseBoardPage } from './board.mjs';
import {
  blockedClaimDrift,
  formatDrift,
  formatUnreadable,
  intakeCards,
  intakeOutcome,
  isEpic,
  isInFlight,
  scanBoard,
  scanOutcome,
  stalledClaimDrift,
  unassignedClaimDrift,
  unfieldedDrift,
  unreadableBlock,
  unreadableCards,
} from './board-rules.mjs';

function parsedLeanItems(nodes) {
  return parseBoardPage(leanBoardPage(nodes)).items;
}

// One Issue card as the fused board read returns it. Every default is the shape that
// fires NO rule — an OPEN, fielded, assigned, unlabelled issue with no blockers, no
// closing pull request and no sub-issues — so a test spells out only the facts its
// rule turns on and any extra row is that rule's own doing.
function issueNode({
  number,
  status,
  title = `card ${number}`,
  routing = 'Product',
  labels = [],
  state = 'OPEN',
  subIssues = { total: 0, completed: 0 },
  assignees = [BOARD_OWNER],
  blockers = [],
  closingPullRequests = [],
}) {
  return leanNode({
    id: `PVTI_${number}`,
    content: {
      __typename: 'Issue',
      number,
      title,
      labels,
      state,
      subIssuesSummary: subIssues,
      assignees,
      blockers,
      closingPullRequests,
    },
    status,
    routing,
  });
}

// Every rule test goes through the REAL scanBoard over really-parsed board items: drop
// a rule's call from scanBoard and the row disappears from here, whatever the pure
// rule function still returns.
const scan = (cards) => scanBoard(parsedLeanItems(cards.map(issueNode)));
const rowsFor = (drifted, number) => drifted.filter((d) => d.number === number);
// Fatal means the row fails the closeout strict gate; an advisory row is printed there
// but never fails it. Asserted per rule, so a mis-tagged row cannot pass.
const closeoutExit = (drifted) => scanOutcome({ drifted, unreadable: [], closeout: true }).exitCode;

test('rule 1 — a closed issue whose card is not in Done is fatal drift, in ANY non-terminal column; an open pickable card is not', () => {
  const { drifted } = scan([
    { number: 1, status: 'In progress', state: 'CLOSED' },
    { number: 2, status: 'Backlog', state: 'CLOSED' }, // the #272 close-without-move
    { number: 3, status: 'Ready', state: 'OPEN' }, // twin: open in a pickable column
  ]);
  assert.deepEqual(rowsFor(drifted, 1), [{
    number: 1,
    status: 'In progress',
    title: 'card 1',
    reason: 'issue closed but card still in "In progress" (not Done)',
  }]);
  assert.deepEqual(rowsFor(drifted, 2).map((d) => d.reason), ['issue closed but card still in "Backlog" (not Done)']);
  assert.deepEqual(rowsFor(drifted, 3), []);
  assert.equal(closeoutExit(drifted), 1);
});

test('rule 2 — an open issue whose card sits in Done is fatal drift; a closed card in Done is correct', () => {
  const { drifted } = scan([
    { number: 1, status: 'Done', state: 'OPEN' },
    { number: 2, status: 'Done', state: 'CLOSED' }, // twin: the normal shipped card
  ]);
  assert.deepEqual(rowsFor(drifted, 1), [{
    number: 1,
    status: 'Done',
    title: 'card 1',
    reason: 'issue open but card in "Done" — close the issue or move the card back to Backlog or Ready',
  }]);
  assert.deepEqual(rowsFor(drifted, 2), []);
  assert.equal(closeoutExit(drifted), 1);
});

test('rule 3 — an open native blocker on non-Backlog work is an advisory; a closed blocker and a blocked card already in Backlog are not', () => {
  const { drifted } = scan([
    {
      number: 1,
      status: 'In progress',
      blockers: [{ number: 5, state: 'OPEN' }, { number: 6, state: 'OPEN' }],
      closingPullRequests: [{ number: 9 }],
    },
    // twin: the blocker has closed, so it blocks nothing.
    {
      number: 2,
      status: 'In progress',
      blockers: [{ number: 7, state: 'CLOSED' }],
      closingPullRequests: [{ number: 10 }],
    },
    // twin: already where a blocked card belongs.
    { number: 3, status: 'Backlog', blockers: [{ number: 8, state: 'OPEN' }] },
  ]);
  assert.deepEqual(rowsFor(drifted, 1), [{
    number: 1,
    status: 'In progress',
    title: 'card 1',
    reason: 'in "In progress" but blocked by open #5, #6 — move it to Backlog until the blockers close',
    advisory: true,
  }]);
  assert.deepEqual(rowsFor(drifted, 2), []);
  assert.deepEqual(rowsFor(drifted, 3), []);
  assert.equal(closeoutExit(drifted), 0);
});

test('rule 4 — active work with no assignee is an advisory; an assigned card and a card still in Ready are not', () => {
  const { drifted } = scan([
    { number: 1, status: 'In progress', assignees: [], closingPullRequests: [{ number: 9 }] },
    { number: 2, status: 'In progress', assignees: [BOARD_OWNER], closingPullRequests: [{ number: 10 }] },
    { number: 3, status: 'Ready', assignees: [] }, // twin: nothing is claimed yet
  ]);
  assert.deepEqual(rowsFor(drifted, 1), [{
    number: 1,
    status: 'In progress',
    title: 'card 1',
    reason: 'claimed in "In progress" with no assignee — assign the session\'s owner (gh issue edit 1 --add-assignee @me) or return it to Backlog or Ready',
    advisory: true,
  }]);
  assert.deepEqual(rowsFor(drifted, 2), []);
  assert.deepEqual(rowsFor(drifted, 3), []);
  assert.equal(closeoutExit(drifted), 0);
});

// GitHub closes an issue when its closing pull request merges into the default branch,
// and every merge here goes to main, so an OPEN issue with a merged closing pull
// request was reopened on purpose. Its live state decides: no column reports it as
// shipped, and the closed and Done-but-open cases stay with rules 1 and 2.
test('an open issue whose closing pull request merged is not reported as shipped in any column; its live state decides', () => {
  const merged = [{ number: 40, merged: true }];
  const { drifted } = scan([
    { number: 1, status: 'In progress', closingPullRequests: merged },
    { number: 2, status: 'Ready', closingPullRequests: merged },
    { number: 3, status: 'Done', closingPullRequests: merged },
    { number: 4, status: 'In review', state: 'CLOSED', closingPullRequests: merged },
  ]);
  assert.deepEqual(drifted.filter((d) => d.reason.includes('shipped')), []);
  assert.deepEqual(rowsFor(drifted, 1), []);
  assert.deepEqual(rowsFor(drifted, 2), []);
  assert.deepEqual(rowsFor(drifted, 3).map((d) => d.reason), [
    'issue open but card in "Done" — close the issue or move the card back to Backlog or Ready',
  ]);
  assert.deepEqual(rowsFor(drifted, 4).map((d) => d.reason), ['issue closed but card still in "In review" (not Done)']);
});

test('rule 5 — a claim with no closing pull request at all is an advisory; an open one, an epic, and Awaiting push are not', () => {
  const { drifted } = scan([
    { number: 1, status: 'In progress' },
    // twin: an open draft is exactly what an in-flight job looks like.
    { number: 2, status: 'In review', closingPullRequests: [{ number: 50 }] },
    // twin: a slice's "Closes #<slice>" creates no closing reference on the epic wrapper.
    { number: 3, status: 'In progress', labels: [KIND_LABELS.epic], subIssues: { total: 1, completed: 0 } },
    // twin: Awaiting push is the gap before any push has happened.
    { number: 4, status: 'Awaiting push' },
  ]);
  assert.deepEqual(rowsFor(drifted, 1), [{
    number: 1,
    status: 'In progress',
    title: 'card 1',
    reason: 'claimed in "In progress" but no closing pull request exists — if no session is actively building it, resume it or return it to Ready',
    advisory: true,
  }]);
  assert.deepEqual(rowsFor(drifted, 2), []);
  assert.deepEqual(rowsFor(drifted, 3), []);
  assert.deepEqual(rowsFor(drifted, 4), []);
  assert.equal(closeoutExit(drifted), 0);
});

// This repository's own config parks no lane, so no card this file's board read produces is
// parked: these call the rules on the normalized card with `parked` set, and the
// copied-toolkit read that really parks one is board-portability.test.mjs's.
const normalizedCard = (facts) => normalizeItem(parsedLeanItems([issueNode(facts)])[0]);

test('rule 5 — a parked claim with no closing pull request is not stalled; the identical unparked card is', () => {
  const claim = normalizedCard({ number: 1, status: 'In progress' });
  assert.equal(stalledClaimDrift({ ...claim, parked: true }), null);
  assert.deepEqual(stalledClaimDrift({ ...claim, parked: false }), {
    number: 1,
    status: 'In progress',
    title: 'card 1',
    reason: 'claimed in "In progress" but no closing pull request exists — if no session is actively building it, resume it or return it to Ready',
    advisory: true,
  });
});

test('a parked claim is still reported by rule 4 when unassigned and by rule 3 when an open blocker holds it', () => {
  const unassigned = { ...normalizedCard({ number: 1, status: 'In progress', assignees: [] }), parked: true };
  assert.deepEqual(unassignedClaimDrift(unassigned), {
    number: 1,
    status: 'In progress',
    title: 'card 1',
    reason: 'claimed in "In progress" with no assignee — assign the session\'s owner (gh issue edit 1 --add-assignee @me) or return it to Backlog or Ready',
    advisory: true,
  });
  const blocked = { ...normalizedCard({ number: 2, status: 'In progress', blockers: [{ number: 5, state: 'OPEN' }] }), parked: true };
  assert.deepEqual(blockedClaimDrift(blocked), {
    number: 2,
    status: 'In progress',
    title: 'card 2',
    reason: 'in "In progress" but blocked by open #5 — move it to Backlog until the blockers close',
    advisory: true,
  });
});

test('rule 6 — an open epic whose every child is closed is fatal drift; one open child or zero children is not', () => {
  const { drifted } = scan([
    { number: 1, status: 'Ready', labels: [KIND_LABELS.epic], subIssues: { total: 3, completed: 3 } },
    { number: 2, status: 'Ready', labels: [KIND_LABELS.epic], subIssues: { total: 2, completed: 1 } },
    // twin: nothing can be "all closed" with no children — that is rule 7's shape.
    { number: 3, status: 'Ready', labels: [KIND_LABELS.epic], subIssues: { total: 0, completed: 0 } },
  ]);
  assert.deepEqual(rowsFor(drifted, 1), [{
    number: 1,
    status: 'Ready',
    title: 'card 1',
    reason: 'epic open but all 3 child issues closed — close it and move to Done',
  }]);
  assert.deepEqual(rowsFor(drifted, 2), []);
  assert.deepEqual(rowsFor(drifted, 3), []);
  assert.equal(closeoutExit(drifted), 1);
});

test('rule 7 — an epic claimed with no sub-issues is an advisory; one sub-issue or a card still in Ready is not', () => {
  const { drifted } = scan([
    { number: 1, status: 'In progress', labels: [KIND_LABELS.epic], subIssues: { total: 0, completed: 0 } },
    { number: 2, status: 'In progress', labels: [KIND_LABELS.epic], subIssues: { total: 1, completed: 0 } },
    // twin: an undecomposed epic waiting in Ready is the normal pre-pick state.
    { number: 3, status: 'Ready', labels: [KIND_LABELS.epic], subIssues: { total: 0, completed: 0 } },
  ]);
  assert.deepEqual(rowsFor(drifted, 1), [{
    number: 1,
    status: 'In progress',
    title: 'card 1',
    reason: 'claimed in "In progress" but has no sub-issues — if no session is actively decomposing it, decompose it or return it to Ready',
    advisory: true,
  }]);
  assert.deepEqual(rowsFor(drifted, 2), []);
  assert.deepEqual(rowsFor(drifted, 3), []);
  assert.equal(closeoutExit(drifted), 0);
});

// The #357–#361 failure mode: `gh project item-add` drops a card on the board with no
// Status and no routing value, which grows a phantom "No Status"/"No Workstream" lane
// and hides the card from every status-scoped rule above (isInFlight(null) is false,
// the pickable set never matches null). Draft cards live on the board too, so they are
// judged here as well — this is the one rule a numberless card can reach.
test('rule 8 — a card missing Status or the routing field is fatal drift, including a draft; a fully fielded card is not', () => {
  const { drifted } = scanBoard(parsedLeanItems([
    leanNode({ id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, title: 'draft note' }),
    issueNode({ number: 2, status: 'Ready' }), // twin: fully fielded
  ]));
  assert.deepEqual(drifted, [{
    number: '?',
    status: '(no status)',
    title: 'draft note',
    reason: `card missing Status + ${ROUTING_FIELD} — set the field(s); item-add leaves them empty`,
  }]);
  assert.equal(closeoutExit(drifted), 1);
  // It formats as a real report line without printing undefined for the missing number.
  assert.equal(formatDrift(drifted[0]).includes('undefined'), false);
});

test('rule 8 names exactly the missing field(s) — no more, no less — and never a fully fielded card', () => {
  const drift = unfieldedDrift([
    { number: 357, status: null, routing: null, title: 'both missing' },
    { number: 358, status: 'Backlog', routing: null, title: 'routing missing' },
    { number: 359, status: null, routing: 'Product', title: 'status missing' },
    { number: 266, status: 'Ready', routing: 'Product', title: 'fully fielded' },
  ]);
  assert.deepEqual(drift.map((d) => d.number), [357, 358, 359]);
  assert.match(drift[0].reason, new RegExp(`Status \\+ ${ROUTING_FIELD}`));
  assert.match(drift[1].reason, new RegExp(ROUTING_FIELD));
  assert.equal(drift[1].reason.includes('Status +'), false);
  assert.match(drift[2].reason, /missing Status /);
});

// The 2026-07-28 failure mode: adding a fourth routing option through the GitHub Projects
// field mutation replaced the routing field's option list and cleared the value on all
// 218 cards at once. Per-card item-add blame printed 218 times would send the next
// session hunting the wrong cause, so a mass unfielding of ONE field summarises to one
// line — which still carries the affected identities, because a misfiring hypothesis
// must not cost the operator facts the repair needs.
function unfieldedCards(count, field, from = 1000) {
  return Array.from({ length: count }, (_, i) => ({
    number: from + i,
    status: field === 'Status' ? null : 'Ready',
    routing: field === ROUTING_FIELD ? null : 'Product',
    title: `card ${from + i}`,
  }));
}

test('rule 8: many cards missing the SAME field summarise to one field-schema overwrite line, not per-card item-add blame', () => {
  const drift = unfieldedDrift(unfieldedCards(30, ROUTING_FIELD));
  assert.equal(drift.length, 1);
  assert.match(drift[0].reason, /field-schema overwrite/);
  assert.match(drift[0].reason, /option list/);
  // The whole point: the item-add cause must NOT be asserted for a mass unfielding.
  assert.equal(drift[0].reason.includes('item-add leaves them empty'), false);
  // The cause is a hypothesis the scan cannot verify, so it stays hedged.
  assert.match(drift[0].reason, /likely/);
  // The count is named so the operator sees the scale.
  assert.match(`${drift[0].title} ${drift[0].reason}`, /30/);
  // KEY regression guard: the heuristic is ADDITIVE — it may explain, it must never
  // cost the operator the identities the repair needs. 30 contiguous cards from 1000
  // are #1000-#1029 (1000 + 30 - 1), counted off the fixture, not off the code.
  assert.match(drift[0].reason, /#1000-#1029/);
  // It must read as a summary, never as a real card, and never print undefined.
  const line = formatDrift(drift[0]);
  assert.equal(line.includes('undefined'), false);
  assert.match(line, /^#\(summary\) \[\(board-wide\)\]/);
  assert.equal(/^#\d/.test(line), false);
  assert.match(line, new RegExp(ROUTING_FIELD));
});

test('rule 8: a scattered mass unfielding lists the card numbers and says how many it omitted', () => {
  // Non-contiguous numbers (every other one) cannot collapse to a range, so this is
  // the path where the identity list can grow unreadably long — and the one where a
  // silent drop would reintroduce the defect above in smaller form. 26 cards stepping
  // by 2 from 1000 run 1000, 1002, … 1050 (1000 + 2 * 25).
  const cards = Array.from({ length: 26 }, (_, i) => ({
    number: 1000 + i * 2,
    status: 'Ready',
    routing: null,
    title: `card ${1000 + i * 2}`,
  }));
  const drift = unfieldedDrift(cards);
  assert.equal(drift.length, 1);
  assert.match(drift[0].reason, /field-schema overwrite/);
  assert.equal(drift[0].reason.includes('#1000-#1050'), false); // not a contiguous run
  // The listed identities are really there…
  assert.match(drift[0].reason, /#1000, #1002, /);
  assert.match(drift[0].reason, /#1038/); // the 20th (1000 + 2 * 19), the last one listed
  // …and the truncation states its own count instead of silently dropping the rest.
  assert.equal(drift[0].reason.includes('#1040'), false); // the 21st, beyond the cap
  assert.equal(drift[0].reason.includes('#1050'), false);
  assert.match(drift[0].reason, /\+6 more/); // 26 - 20
});

test('rule 8: at the threshold the ordinary per-card item-add entries are produced', () => {
  const drift = unfieldedDrift(unfieldedCards(25, ROUTING_FIELD));
  assert.deepEqual(
    drift.map((d) => d.number),
    [
      1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012,
      1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024,
    ],
  );
  for (const d of drift) {
    assert.match(d.reason, new RegExp(`card missing ${ROUTING_FIELD} — set the field\\(s\\); item-add leaves them empty`));
  }
});

test('rule 8: BOUNDARY — six cards missing a field are item-add territory, so every card is still named', () => {
  // Six cards is the ORIGINAL #357–#361 shape (that incident was five). At this scale
  // a schema-overwrite verdict would be flat wrong — an overwrite clears EVERY card
  // carrying the field — and suppressing the numbers would strip exactly the
  // identities the operator needs to repair them.
  const drift = unfieldedDrift(unfieldedCards(6, ROUTING_FIELD));
  assert.deepEqual(drift.map((d) => d.number), [1000, 1001, 1002, 1003, 1004, 1005]);
  assert.equal(drift.some((d) => /field-schema overwrite/.test(d.reason)), false);
});

test('rule 8: a card missing both fields where only one crossed the threshold is reported once per cause, never twice', () => {
  const cards = [
    ...unfieldedCards(30, ROUTING_FIELD),
    { number: 2000, status: null, routing: null, title: 'both missing' },
  ];
  const drift = unfieldedDrift(cards);
  // One routing-field summary (31 cards) + one per-card entry for the Status miss.
  assert.equal(drift.length, 2);
  const summary = drift.find((d) => /field-schema overwrite/.test(d.reason));
  const perCard = drift.find((d) => d.number === 2000);
  assert.ok(summary && perCard);
  assert.match(`${summary.title} ${summary.reason}`, /31/);
  // The per-card entry names ONLY the field that was not summarised.
  assert.match(perCard.reason, /card missing Status — set/);
  assert.equal(perCard.reason.includes(ROUTING_FIELD), false);
  // And no second entry for the same card.
  assert.equal(drift.filter((d) => d.number === 2000).length, 1);
});

// #600: an unresolved card keeps its field values, so the unfielded rule would happily
// print repair advice about a card nothing is known about. It belongs to the unreadable
// channel alone, and every other rule skips it because the issue's own state is absent.
test('scanBoard: a card whose content did not resolve is unreadable only — never drift, and never judged by the unfielded rule', () => {
  const { drifted, unreadable } = scanBoard(parsedLeanItems([
    leanNode({ id: 'PVTI_unresolved_unfielded', content: null, routing: 'Product' }),
    leanNode({ id: 'PVTI_unresolved_inflight', content: null, status: 'In progress', routing: 'Product' }),
  ]));
  assert.deepEqual(drifted, []);
  assert.deepEqual(unreadable.map((c) => c.id), ['PVTI_unresolved_unfielded', 'PVTI_unresolved_inflight']);
});

test('isInFlight: true for any column that is neither pickable nor terminal', () => {
  assert.equal(isInFlight('In progress'), true);
  assert.equal(isInFlight('In review'), true);
  assert.equal(isInFlight('A future column'), true); // rename-robust: unknown column still counts
  assert.equal(isInFlight('Backlog'), false);
  assert.equal(isInFlight('Ready'), false);
  assert.equal(isInFlight('Done'), false);
  assert.equal(isInFlight(null), false);
  assert.equal(isInFlight(''), false);
});

// The vocabulary is board-config's, not this module's: the pickable and terminal sets
// are what isInFlight excludes, and Awaiting push is deliberately IN flight (a shipped
// card there is still drift) while being exempt from the stalled claim rule alone.
test('the pickable, terminal and wait columns are board-config\'s, and Awaiting push is still in-flight', () => {
  assert.deepEqual([...PICKABLE_STATUSES].sort(), ['Backlog', 'Ready']);
  assert.deepEqual(TERMINAL_STATUSES, ['Done']);
  assert.deepEqual(WAIT_STATUSES, ['Awaiting push']);
  for (const status of [...PICKABLE_STATUSES, ...TERMINAL_STATUSES]) {
    assert.equal(isInFlight(status), false, status);
  }
  for (const status of WAIT_STATUSES) {
    assert.equal(isInFlight(status), true, status);
  }
});

test('isEpic: true for the configured epic kind label alone, false for any other label', () => {
  assert.equal(isEpic({ labels: [KIND_LABELS.epic] }), true);
  assert.equal(isEpic({ labels: ['area:ui', KIND_LABELS.epic] }), true);
  assert.equal(isEpic({ labels: [`x:${KIND_LABELS.epic}`] }), false);
  assert.equal(isEpic({ labels: [KIND_LABELS.feature] }), false);
  assert.equal(isEpic({ labels: [] }), false);
});

test('formatDrift: renders #number, the column and the reason', () => {
  const line = formatDrift({ number: 319, status: 'In progress', title: 'Move refresh()', reason: 'issue closed but card still in "In progress" (not Done)' });
  assert.equal(line, '#319 [In progress] Move refresh() — issue closed but card still in "In progress" (not Done)');
});

// The #600 failure mode: a card whose GraphQL content did not resolve keeps its
// field values (Status/Workstream/Title come from fieldValues, not content), so it
// passes the unfielded rule AND falls out of every rule that reads the issue's own
// state. Build the raw nullable response once, then reach the normalized
// `content: {}` shape only through parseBoardPage.
const RAW_ITEMS = parsedLeanItems([
  // The bug: an in-flight, fully-fielded card whose content did not resolve.
  leanNode({
    id: 'PVTI_unresolved',
    content: null,
    status: 'In progress',
    routing: 'Product',
  }),
  // Legitimately numberless — never an unreadable card.
  leanNode({
    id: 'PVTI_draft',
    content: { __typename: 'DraftIssue' },
    title: 'draft note',
    status: 'Backlog',
    routing: 'Product',
  }),
  leanNode({
    id: 'PVTI_pr',
    content: { __typename: 'PullRequest' },
    title: 'a pull request card',
    status: 'Ready',
    routing: 'Product',
  }),
  leanNode({
    id: 'PVTI_issue',
    content: { __typename: 'Issue', number: 600, title: 'a resolved issue', labels: [] },
    status: 'Ready',
    routing: 'Product',
  }),
]);

test('unreadableCards: flags a card whose content did not resolve, never a draft/pull-request/resolved card', () => {
  const unreadable = unreadableCards(RAW_ITEMS);
  assert.deepEqual(unreadable.map((c) => c.id), ['PVTI_unresolved']);
  // KEY mutation guard: a bare `number == null` check would report the draft and
  // the pull-request card, both of which are numberless by design.
  assert.equal(unreadable.some((c) => c.id === 'PVTI_draft'), false);
  assert.equal(unreadable.some((c) => c.id === 'PVTI_pr'), false);
  // The reason names a READ problem (re-run the read), not a board problem.
  assert.match(unreadable[0].reason, /could not be read/);
  assert.match(unreadable[0].reason, /re-run the read/);
  // Keyed by id (there is no number), and an empty title never prints as undefined.
  const line = formatUnreadable(unreadable[0]);
  assert.match(line, /PVTI_unresolved/);
  assert.match(line, /\(no title\)/);
  assert.equal(line.includes('undefined'), false);
  assert.equal(formatUnreadable({ id: 'PVTI_x', reason: 'r' }).includes('undefined'), false);
});

// The #600 honesty invariant lives in scanOutcome, so it is provable without any
// board read at all. The expected column below is read off the documented contract —
// exit 1 when drift is present, or when a card was unreadable AND this is a closeout
// scan; the unqualified clean sentence only when the scan covered the whole board.
const UNQUALIFIED_CLEAN = 'board: no drift found.';
const DRIFTED_CARD = { number: 319, status: 'In progress', title: 'Move refresh()', reason: 'issue closed but card still in "In progress" (not Done)' };
const SCAN_MATRIX = [
  { drift: false, unread: false, closeout: false, exitCode: 0 },
  { drift: false, unread: false, closeout: true, exitCode: 0 },
  { drift: false, unread: true, closeout: false, exitCode: 0 },
  { drift: false, unread: true, closeout: true, exitCode: 1 }, // the closeout gate's whole point
  { drift: true, unread: false, closeout: false, exitCode: 1 },
  { drift: true, unread: false, closeout: true, exitCode: 1 },
  { drift: true, unread: true, closeout: false, exitCode: 1 },
  { drift: true, unread: true, closeout: true, exitCode: 1 },
];

test('ANTI-REGRESSION (#600 honesty invariant): scanOutcome exit code and clean sentence across the whole drift x unreadable x closeout matrix', () => {
  for (const row of SCAN_MATRIX) {
    const drifted = row.drift ? [DRIFTED_CARD] : [];
    const unreadable = row.unread ? unreadableCards(RAW_ITEMS) : [];
    const { lines, exitCode } = scanOutcome({ drifted, unreadable, closeout: row.closeout });
    const label = `drift=${row.drift} unreadable=${row.unread} closeout=${row.closeout}`;
    assert.equal(exitCode, row.exitCode, `${label}: expected exit ${row.exitCode}`);
    // The honesty invariant: an unread card can never be reported as a clean board.
    assert.equal(lines.join('\n').includes(UNQUALIFIED_CLEAN), !row.drift && !row.unread, label);
  }
});

test('scanOutcome: an advisory row fails an ordinary scan but never strands the closeout proof gate', () => {
  const advisoryRow = {
    number: 618,
    status: 'In progress',
    title: 'claimed into In progress and never started',
    reason: 'claimed in "In progress" but no closing pull request exists — if no session is actively building it, resume it or return it to Ready',
    advisory: true,
  };

  // The ordinary scan is the session-start/closeout bookend the class exists for.
  const ordinary = scanOutcome({ drifted: [advisoryRow], unreadable: [], closeout: false });
  assert.equal(ordinary.exitCode, 1);
  assert.match(ordinary.lines.join('\n'), /#618/);

  // --closeout is one merge's proof gate, and a SIBLING card's claim status is not that
  // merge's business — it is still printed, never fatal.
  const closeout = scanOutcome({ drifted: [advisoryRow], unreadable: [], closeout: true });
  assert.equal(closeout.exitCode, 0, closeout.lines.join('\n'));
  assert.match(closeout.lines.join('\n'), /#618/);
  // …and the run that survives never claims a clean board over a printed drift row.
  assert.equal(closeout.lines.some((line) => line.includes(UNQUALIFIED_CLEAN)), false);

  // Every fatal class keeps its behaviour: a closed card left in flight still fails the proof gate.
  assert.equal(scanOutcome({ drifted: [DRIFTED_CARD], unreadable: [], closeout: true }).exitCode, 1);
  assert.equal(scanOutcome({ drifted: [DRIFTED_CARD, advisoryRow], unreadable: [], closeout: true }).exitCode, 1);
});

test('scanOutcome: a partial read that does not exit 1 says so instead of claiming coverage', () => {
  const { lines, exitCode } = scanOutcome({ drifted: [], unreadable: unreadableCards(RAW_ITEMS), closeout: false });
  assert.equal(exitCode, 0);
  const last = lines[lines.length - 1];
  assert.match(last, /no drift/);
  assert.match(last, /1 card/);
  assert.match(last, /not cover the whole board/);
  assert.equal(last.includes(UNQUALIFIED_CLEAN), false);
});

test('scanOutcome: unreadable cards get their own block, never mixed into the drift block', () => {
  const { lines } = scanOutcome({
    drifted: [DRIFTED_CARD],
    unreadable: unreadableCards(RAW_ITEMS),
    closeout: false,
  });
  const driftHeader = lines.findIndex((l) => l.includes('BOARD DRIFT'));
  const unreadHeader = lines.findIndex((l) => l.includes('BOARD READ INCOMPLETE'));
  assert.ok(driftHeader === 0 && unreadHeader > driftHeader);
  // "#319 … out of sync with reality" is a claim; the unread card sits after it.
  assert.match(lines[driftHeader + 1], /#319/);
  assert.match(lines[unreadHeader + 1], /PVTI_unresolved/);
  // No clean sentence at all on a run that exits 1.
  assert.equal(lines.some((l) => l.includes('no drift')), false);
  // The block is the shared builder's output verbatim, so a second reader of the same
  // data prints the same sentence rather than a hand-written copy that drifts from it.
  assert.deepEqual(lines.slice(unreadHeader), unreadableBlock(unreadableCards(RAW_ITEMS)));
});

// An unresolved card carrying blank fields must not be handed the unfielded rule's
// repair advice: nothing about it is trustworthy, including its blank fields.
test('scanOutcome: an unresolved card with blank fields is fatal to an ordinary scan without contradictory repair advice', () => {
  const unreadable = unreadableCards(parsedLeanItems([leanNode({
    id: 'PVTI_unresolved_unfielded',
    content: null,
    routing: 'Product',
  })]));

  const { lines, exitCode } = scanOutcome({ drifted: [], unreadable, closeout: false });

  assert.equal(exitCode, 1);
  assert.equal(lines.filter((line) => line.includes('re-run the read')).length, 1);
  assert.equal(lines.join('\n').includes('set the field(s)'), false);
  assert.equal(ROUTING_FIELD, 'Workstream'); // the field the unfielded rule names below
});

// The detail set follows what the owner must be shown, not what the drift rules flag:
// cards 42 (waiting column) and 44 (undecomposed epic) are exempt from rule 5 yet are
// still claims with nothing behind them, so a stalledClaimDrift filter would drop them.
test('ANTI-REGRESSION: intakeCards keeps every numbered pickable card and every claimed card with no closing pull request, and counts the numberless', () => {
  const [backlog, ready] = PICKABLE_STATUSES;
  const items = parsedLeanItems([
    ...[
      { number: 30, status: ready },
      { number: 10, status: backlog },
      { number: 20, status: backlog },
      { number: 40, status: 'In progress' },
      { number: 41, status: 'In progress', closingPullRequests: [{ number: 50 }] },
      { number: 44, status: 'In progress', labels: [KIND_LABELS.epic] },
      { number: 42, status: WAIT_STATUSES[0] },
      { number: 43, status: TERMINAL_STATUSES[0], state: 'CLOSED' },
    ].map(issueNode),
    leanNode({ id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, title: 'draft note', status: backlog, routing: 'Product' }),
  ]);

  const { candidates, claims, numberless } = intakeCards(items);

  assert.deepEqual(candidates.map((c) => c.number), [30, 10, 20]);
  assert.deepEqual(claims.map((c) => c.number), [40, 42, 44]);
  assert.equal(numberless, 1);
});

// The exit codes are read off the intake exit table: 0 whole and clean, 3 drift with every
// detail read, 4 something unread without drift, 5 both. The details are hand-built in the
// entry shapes fetchCardDetails returns.
test('ANTI-REGRESSION: intakeOutcome exits 0 only when nothing drifted and every detail was read, and 3, 4 and 5 otherwise', () => {
  const read = { number: 1, body: 'b', parent: null, comments: ['c'], commentCount: 1, commentsUnavailable: null };
  const complete = new Map([[1, read], [2, { ...read, number: 2 }], [3, { ...read, number: 3 }]]);
  const withEntry = (entry) => new Map([...complete, [entry.number, entry]]);
  const cardUnavailable = withEntry({ number: 3, unavailable: 'gh: timed out' });
  const commentsPartial = withEntry({ ...read, number: 3, commentCount: 5, commentsUnavailable: 'offline' });
  const unreadable = unreadableCards(RAW_ITEMS);
  const allRead = 'board intake: details complete for 3 card(s).';
  const someUnread = 'board intake: details UNAVAILABLE in whole or part for 1 of 3 card(s): #3.';

  const cases = [
    { label: 'complete', drifted: [], unreadable: [], details: complete, exitCode: 0, tail: allRead },
    { label: 'no card to detail', drifted: [], unreadable: [], details: new Map(), exitCode: 0, tail: 'board intake: details complete for 0 card(s).' },
    { label: 'drift alone', drifted: [DRIFTED_CARD], unreadable: [], details: complete, exitCode: 3, tail: allRead },
    { label: 'a card unavailable', drifted: [], unreadable: [], details: cardUnavailable, exitCode: 4, tail: someUnread },
    { label: 'comments partly unavailable', drifted: [], unreadable: [], details: commentsPartial, exitCode: 4, tail: someUnread },
    { label: 'a card the board could not read', drifted: [], unreadable, details: complete, exitCode: 4, tail: allRead },
    { label: 'drift with a card unavailable', drifted: [DRIFTED_CARD], unreadable: [], details: cardUnavailable, exitCode: 5, tail: someUnread },
    { label: 'drift with a card the board could not read', drifted: [DRIFTED_CARD], unreadable, details: complete, exitCode: 5, tail: allRead },
  ];
  for (const { label, drifted, unreadable: unread, details, exitCode, tail } of cases) {
    const outcome = intakeOutcome({ drifted, unreadable: unread, details });
    assert.equal(outcome.exitCode, exitCode, label);
    // The ordinary scan's own lines, then the details line.
    assert.deepEqual(
      outcome.lines,
      [...scanOutcome({ drifted, unreadable: unread, closeout: false }).lines, tail],
      label,
    );
  }
});
