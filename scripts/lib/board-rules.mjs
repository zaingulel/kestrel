// board-rules.mjs — the drift rules a board read is judged by, and the report they
// produce. Pure: no gh call, no I/O, no second read. Every rule below answers its
// question from ONE normalized card of a single fused board read (scripts/lib/board.mjs),
// which is what lets scanBoard judge the whole board in one pass.
//
// Two channels come out, and they are not the same claim. `drifted` says a card's
// board position contradicts a known reality; `unreadable` says nothing is known
// about the card at all, including whether it drifted (#600), so it never carries a
// repair instruction and never lets the scan claim it covered the board.

import { INTAKE_EXIT, isContentUnresolved, normalizeItem, pickable, sortForDisplay } from './board.mjs';
import {
  KIND_LABELS,
  PICKABLE_STATUSES,
  ROUTING_FIELD,
  TERMINAL_STATUSES,
  WAIT_STATUSES,
} from './board-config.mjs';

// Every column word in every reason below comes from board-config.mjs, so a Status
// rename is one edit there and not a hunt through eight reason strings. Both lists are
// in board order: the backlog column first, then ready, and Done ends the line.
const [BACKLOG, READY] = PICKABLE_STATUSES;
const [DONE] = TERMINAL_STATUSES;
const PICKABLE_PHRASE = PICKABLE_STATUSES.join(' or ');

// True for any column that is neither pickable nor terminal — In progress, Awaiting
// push, In review, a future rename. Deliberately status-rename robust: we don't
// enumerate the in-flight column names, we exclude the two known non-in-flight sets.
export function isInFlight(status) {
  return Boolean(status) && !PICKABLE_STATUSES.includes(status) && !TERMINAL_STATUSES.includes(status);
}

// Board labels arrive as bare names; an epic carries the configured epic kind label.
export function isEpic(card) {
  return card.labels.includes(KIND_LABELS.epic);
}

// A card missing its Status still reaches the rules below that quote its column. The
// unfielded rule reports the missing field itself; this only keeps a reason from
// printing `null` where a column name belongs.
const column = (status) => status ?? '(no status)';

// One drift row. `advisory` marks a row that is reported in every mode but does not
// fail the closeout proof gate (see scanOutcome).
const row = (card, reason) => ({
  number: card.number,
  status: column(card.status),
  title: card.title,
  reason,
});
const advisory = (card, reason) => ({ ...row(card, reason), advisory: true });

// 1. The #272/#319 failure mode: closing an issue does not touch its Project Status, so
// a close-without-move strands the card wherever it was — in a pickable column the next
// pick re-proposes it, in an in-flight column it reads as live work for weeks. Any
// non-terminal column, because every one of them makes a claim the closed issue no
// longer backs.
export function closedNotDoneDrift(card) {
  if (card.state !== 'CLOSED' || TERMINAL_STATUSES.includes(card.status)) return null;
  return row(card, `issue closed but card still in "${column(card.status)}" (not ${DONE})`);
}

// 2. The reverse: a card parked in Done whose issue never closed. Done is the board's
// own record of finished work, so an open issue sitting there silently removes the work
// from every pick view while nothing has actually shipped.
export function openInTerminalDrift(card) {
  if (card.state !== 'OPEN' || !TERMINAL_STATUSES.includes(card.status)) return null;
  return row(card, `issue open but card in "${card.status}" — close the issue or move the card back to ${PICKABLE_PHRASE}`);
}

// 3. Work that cannot proceed should not look available or claimed. Reads GitHub's
// NATIVE blockedBy dependencies only (normalizeItem has already dropped the closed
// ones) — never the issue body's prose, which is not a contract. Advisory: a blocker
// can close minutes later, so this informs the next pick rather than failing a merge.
export function blockedClaimDrift(card) {
  if (card.state !== 'OPEN' || card.openBlockers.length === 0) return null;
  if (card.status === BACKLOG || TERMINAL_STATUSES.includes(card.status)) return null;
  const blockers = card.openBlockers.map((number) => `#${number}`).join(', ');
  return advisory(card, `in "${column(card.status)}" but blocked by open ${blockers} — move it to ${BACKLOG} until the blockers close`);
}

// 4. An active card with no assignee names no one accountable: the board shows work in
// progress that no session has actually taken. Advisory for the same reason as above —
// a card is claimed at pick time, before the assignment is necessarily made.
export function unassignedClaimDrift(card) {
  if (card.state !== 'OPEN' || !isInFlight(card.status) || card.assignees.length > 0) return null;
  return advisory(card, `claimed in "${card.status}" with no assignee — assign the session's owner (gh issue edit ${card.number} --add-assignee @me) or return it to ${PICKABLE_PHRASE}`);
}

// 5. The #654 failure mode, the reverse direction of #319: a card CLAIMED into an
// in-flight column that then produced nothing — #646 and #618 sat stranded for days
// while both mandatory bookends reported clean. Evidence is closing pull-request
// existence, merged or NOT: an open draft is exactly what an in-flight job looks like.
// Not commits — a commit scan would have to infer the lane branch from a naming
// convention, and an unresolved branch would conclude work exists and go quiet,
// manufacturing a fresh false-clean in the one case this rule exists for.
// Three exemptions: Awaiting push is the gap between local review passing and push
// authorisation, before any push has happened, so no closing pull request is the
// expected shape there; a slice's "Closes #<slice>" creates no closing reference on
// its EPIC, so an epic whose slices are building has the stalled shape (rule 7 is what
// covers an epic claim instead); and a parked card waits on an answer from outside the
// session, not on a session, so no closing pull request is the expected shape there too
// (rules 3, 4 and 7 still judge it).
export function stalledClaimDrift(card) {
  if (card.state !== 'OPEN' || !isInFlight(card.status) || card.parked) return null;
  if (WAIT_STATUSES.includes(card.status) || isEpic(card) || card.closingPullRequests.length > 0) return null;
  return advisory(card, `claimed in "${card.status}" but no closing pull request exists — if no session is actively building it, resume it or return it to ${READY}`);
}

// 6. The #337 failure mode: an epic still OPEN and not terminal whose every child is
// closed — the work is done and only the wrapper lingers (#337 sat in Ready after all
// 13 slices shipped). No other rule sees it: the epic's own issue is open, and no
// merged pull request references the wrapper. An epic with zero children is never
// flagged (nothing to be "all closed"); "closed" is GitHub's own completed count, so a
// child closed as not planned counts as done here.
export function epicDoneDrift(card) {
  if (!isEpic(card) || card.state !== 'OPEN' || TERMINAL_STATUSES.includes(card.status)) return null;
  const { total, completed } = card.subIssues;
  if (total === 0 || completed !== total) return null;
  return row(card, `epic open but all ${total} child issues closed — close it and move to ${DONE}`);
}

// 7. The #660 failure mode, in the gap between rules 5 and 6: an epic claimed in-flight
// whose decomposition never happened sits claimed indefinitely while every scan reports
// clean. Zero children is what makes the case unambiguous — there is nothing in flight
// beneath the claim. Scoped to active work, so an undecomposed epic waiting in Backlog
// or Ready (the normal pre-pick state) is silent: the claim, not the decomposition, is
// what this reports.
export function epicUnstartedDrift(card) {
  if (!isEpic(card) || card.state !== 'OPEN' || !isInFlight(card.status)) return null;
  if (card.subIssues.total !== 0) return null;
  return advisory(card, `claimed in "${card.status}" but has no sub-issues — if no session is actively decomposing it, decompose it or return it to ${READY}`);
}

// One unreadable card → the one-line report row. Keyed by `id`: an unresolved card
// has no number, and its Title field may be empty, so both degrade to an explicit
// placeholder rather than printing `undefined`.
export function formatUnreadable(card) {
  return `${card.id} [${card.status || '(no status)'}] ${card.title || '(no title)'} — ${card.reason}`;
}

// The unreadable-card report block (header + one line per card). Every reader of this
// class calls it, so the same card is described in the same sentence whichever command
// the operator ran. Every line already ends in "re-run the read", so the header does
// not repeat the remedy.
export function unreadableBlock(cards) {
  return [
    '⚠ BOARD READ INCOMPLETE — card(s) whose content did not resolve on this read:',
    ...cards.map(formatUnreadable),
  ];
}

// One drifted card → the one-line report row.
export function formatDrift(card) {
  return `#${card.number} [${card.status}] ${card.title} — ${card.reason}`;
}

// The #600 failure mode: a card whose GraphQL content did not resolve on this read
// keeps its field values (Status, the routing field and the Title text come from
// fieldValues, not from content), so the unfielded rule sees a fully-fielded card
// while every rule that reads the issue's own state skips it — it vanished from the
// scan and the board reported clean. This is NOT a drift class: nothing is known about
// the card, including whether it drifted. Takes RAW board items (pre-normalizeItem),
// which is the shape isContentUnresolved reads; that predicate is the single home of
// the draft/pull-request exemption (a numberless DraftIssue is legitimate, not
// unreadable), so never re-derive it here.
//
// SCOPE: this detects a card that IS in the read but whose content did not resolve.
// It cannot detect a card the read omitted altogether — the owner's live capture on
// #572 shows the same propagation lag can drop a just-added card out of
// projectV2.items entirely, which yields no unreadable entry and no drift. That is a
// separate, observed shape, so a scan with no unreadable cards is not proof that the
// whole board was read.
export function unreadableCards(items) {
  return items
    .filter(isContentUnresolved)
    .map((i) => ({
      id: i.id,
      status: i.status,
      title: i.title,
      _hasBlankField: !i.status || Boolean(ROUTING_FIELD && !i.routing),
      reason: 'card content could not be read on this scan — nothing is known about it, including whether it drifted; re-run the read',
    }));
}

// Above this many cards missing the SAME field, the cause is a field-schema overwrite,
// not many bad item-adds: on 2026-07-28 adding a fourth routing option through the Projects
// field mutation replaced the whole routing-field option list and cleared the value on
// all 218 cards at once (an existing option only survives if it is echoed back with its
// id). 25 is picked to sit near NEITHER scale: an item-add backlog accumulates in single
// digits between sessions (the #357–#361 incident was five cards), while a schema
// overwrite clears every card carrying the field in one mutation — roughly an order of
// magnitude above the one and an order below the other, so no realistic case lands near
// the boundary.
const MASS_UNFIELDED_THRESHOLD = 25;

// How many card numbers the mass-unfielded summary line may list before it truncates.
// A contiguous run collapses to one range whatever its size, so this only binds on a
// scattered set; beyond it the line lists that many numbers and then states how many it
// left out. It never drops an identity silently — the summary's whole job is to explain
// WITHOUT costing the operator the numbers the repair needs.
const MASS_UNFIELDED_IDENTITY_CAP = 20;

// The affected card numbers as one compact identity string: a contiguous run as
// `#1000-#1217`, anything else as a comma list capped above. Always sorted, numbers
// ascending and numberless cards last, so the line does not inherit board order — a
// draft card has no issue number, so it degrades to `?` rather than undefined.
function formatIdentities(numbers) {
  const sorted = [...numbers].sort((a, b) => {
    if (a == null) return b == null ? 0 : 1;
    if (b == null) return -1;
    return a - b;
  });
  if (sorted.every((n, i) => Number.isInteger(n) && n === sorted[0] + i)) {
    return `#${sorted[0]}-#${sorted[sorted.length - 1]}`;
  }
  const listed = sorted.slice(0, MASS_UNFIELDED_IDENTITY_CAP).map((n) => (n == null ? '?' : `#${n}`));
  const omitted = sorted.length - listed.length;
  return omitted > 0 ? `${listed.join(', ')} (+${omitted} more not listed)` : listed.join(', ');
}

// 8. The #357–#361 failure mode: `gh project item-add` (and the bare "add item" UI
// path) drops a card on the board with NO Status and NO routing value. Grouped views
// then grow a phantom "No Status"/"No Workstream" lane, and the card is invisible to
// every status-scoped rule above (isInFlight(null) is false by design, the pickable set
// never matches null). Draft cards (no issue number) live on the board too, so they are
// flagged as well — this is the one rule a numberless card reaches.
//
// Two paths, split at MASS_UNFIELDED_THRESHOLD: at or below it every affected card is
// named so the next session repairs it instead of a human spotting the phantom column;
// above it that one field collapses to a single summary line — but the line still
// carries the affected identities, so the threshold governs only how verbose the
// EXPLANATION is, never whether the scan reports what it found (a misfiring hypothesis
// must not cost facts).
export function unfieldedDrift(cards) {
  const missing = { Status: [], ...(ROUTING_FIELD ? { [ROUTING_FIELD]: [] } : {}) };
  for (const card of cards) {
    if (!card.status) missing.Status.push(card.number ?? null);
    if (ROUTING_FIELD && !card.routing) missing[ROUTING_FIELD].push(card.number ?? null);
  }
  const drift = [];
  const summarised = [];
  for (const [field, affected] of Object.entries(missing)) {
    if (affected.length <= MASS_UNFIELDED_THRESHOLD) continue;
    summarised.push(field);
    drift.push({
      number: '(summary)',
      status: '(board-wide)',
      title: `${affected.length} cards missing ${field}`,
      reason: `likely a field-schema overwrite, not ${affected.length} bad item-adds — editing a single-select field replaces its whole option list, and any option not echoed back with its id is cleared from every card; re-check the ${field} field's option list and restore the values. Affected cards: ${formatIdentities(affected)}`,
    });
  }
  for (const card of cards) {
    const fields = [!card.status && 'Status', !card.routing && ROUTING_FIELD]
      .filter(Boolean)
      .filter((field) => !summarised.includes(field));
    if (fields.length === 0) continue;
    drift.push({
      number: card.number ?? '?',
      status: column(card.status),
      title: card.title,
      reason: `card missing ${fields.join(' + ')} — set the field(s); item-add leaves them empty`,
    });
  }
  return drift;
}

// The seven per-card rules, in report order. scanBoard calls every one of them on every
// readable card: the rules are disjoint only where their conditions make them so (a
// CLOSED card cannot also be open in Done), and a card genuinely breaking two rules
// is told both things.
const CARD_RULES = [
  closedNotDoneDrift,
  openInTerminalDrift,
  blockedClaimDrift,
  unassignedClaimDrift,
  stalledClaimDrift,
  epicDoneDrift,
  epicUnstartedDrift,
];

// One board read → the two channels. Every rule is answered from the cards already in
// hand, so the whole board is judged in one pass and no rule can cost a second read.
// The unreadable cards are taken off the RAW items (normalizeItem drops the content
// typename the draft/pull-request exemption needs) and then excluded from the rules:
// blank fields on a card whose content did not resolve are not trustworthy repair
// evidence, and every other rule would skip it anyway for want of an issue state.
export function scanBoard(items) {
  const unreadable = unreadableCards(items);
  const cards = items.filter((item) => !isContentUnresolved(item)).map(normalizeItem);
  const drifted = [];
  for (const card of cards) {
    for (const rule of CARD_RULES) {
      const found = rule(card);
      if (found) drifted.push(found);
    }
  }
  drifted.push(...unfieldedDrift(cards));
  return { drifted, unreadable };
}

// The cards the session must show with their details: every numbered pickable card in
// pick order, then every numbered claimed card with no closing pull request. Deliberately
// not stalledClaimDrift's set: its exemptions (a waiting column, an epic, a parked card)
// are right for a drift row and wrong here, where an exempt claim is still one the owner
// must see. A card with no number cannot be looked up, so it is counted, never dropped.
export function intakeCards(items) {
  const picks = sortForDisplay(pickable(items)).map(normalizeItem);
  const claimed = items.map(normalizeItem)
    .filter((card) => isInFlight(card.status) && card.closingPullRequests.length === 0);
  const numbered = (cards) => cards.filter((card) => card.number != null);
  const candidates = numbered(picks);
  const claims = numbered(claimed).sort((a, b) => a.number - b.number);
  return {
    candidates,
    claims,
    numberless: picks.length + claimed.length - candidates.length - claims.length,
  };
}

// The single decider for what a board scan prints and exits with, so the CLI holds no
// judgment of its own and this whole contract is unit-testable.
// An unreadable card is FATAL only under --closeout: the closeout gate's whole
// contract is proof, so a scan that admits it could not read part of the board has
// proven nothing and must not certify. An ordinary interactive scan reports it but
// is never stranded by a transient read lag (the #589 stranding failure). And a
// scan that could not read N cards must never print the unqualified clean sentence
// (#600) — the operator would read "verified clean" off an unread board.
export function scanOutcome({ drifted, unreadable, closeout }) {
  // This marker preserves the former unfielded verdict without emitting its
  // untrustworthy repair advice.
  const unreadableUnfielded = unreadable.some((card) => card._hasBlankField);
  // An advisory row is reported in every mode but is fatal only to an ordinary scan.
  // --closeout is the per-merge proof mode the closeout skill runs after a merge, and a
  // SIBLING lane's claim status is not that merge's business — cards enter an in-flight
  // column at pick time, hours before any pull request exists, so failing there would
  // strand an unrelated merged pull request (the #589 stranding class the PR42 ruling
  // removed). The ordinary scan is the session-start and closeout bookend whose whole
  // job is to surface exactly this, so there it still exits 1.
  const fatal = closeout ? drifted.filter((card) => !card.advisory) : drifted;
  const lines = [];
  if (drifted.length > 0) {
    lines.push('⚠ BOARD DRIFT — cards out of sync with reality:');
    for (const card of drifted) lines.push(formatDrift(card));
  }
  // Its own block: "out of sync with reality" would be a claim about a card nothing
  // is known about.
  if (unreadable.length > 0) lines.push(...unreadableBlock(unreadable));
  if (fatal.length > 0 || unreadableUnfielded || (unreadable.length > 0 && closeout)) {
    return { lines, exitCode: 1 };
  }
  // No clean sentence over drift rows just printed — the surviving advisory-under-
  // closeout run is the only way to reach here with any.
  if (drifted.length === 0) {
    lines.push(
      unreadable.length > 0
        ? `board: no drift found, but ${unreadable.length} card(s) could not be read — this scan did not cover the whole board.`
        : 'board: no drift found.',
    );
  }
  return { lines, exitCode: 0 };
}

// What `--intake` prints on stderr after its document, and what it exits with. Drift alone
// is 3 and a read that stopped short alone is 4: a card whose details (or some of its
// comments) were not read, or a card the board could not read. Only a clean scan with
// every detail read is 0. The scan lines are the ordinary scan's own, so the wording of
// a drift row or an unread card has one home.
export function intakeOutcome({ drifted, unreadable, details }) {
  const unread = [...details.values()].filter((entry) => entry.unavailable !== undefined || entry.commentsUnavailable !== null);
  const drift = drifted.length > 0;
  const incomplete = unread.length > 0 || unreadable.length > 0;
  let exitCode = INTAKE_EXIT.complete;
  if (drift && incomplete) exitCode = INTAKE_EXIT.driftAndIncomplete;
  else if (drift) exitCode = INTAKE_EXIT.drift;
  else if (incomplete) exitCode = INTAKE_EXIT.incomplete;
  const summary = unread.length === 0
    ? `board intake: details complete for ${details.size} card(s).`
    : `board intake: details UNAVAILABLE in whole or part for ${unread.length} of ${details.size} card(s): ${unread.map((entry) => `#${entry.number}`).join(', ')}.`;
  return { lines: [...scanOutcome({ drifted, unreadable, closeout: false }).lines, summary], exitCode };
}
