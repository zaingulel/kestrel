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
// verifyMarkdownPublication applies the same checks to a markdown-tracked board's card files, and
// verifyLinearPublication, verifyJiraPublication and verifyAzurePublication to their native provider issues.

import { BOARD_OWNER, BOARD_REPOSITORY, KIND_LABELS, ROUTING_FIELD, TERMINAL_STATUSES } from './board-config.mjs';
import { allNodes, linearTeamKey, readLinearBoard } from './board-linear.mjs';
import { CARDS_DIR } from './board-markdown.mjs';
import { lookupIssueBoardItem } from './board-move.mjs';
import { isContentUnresolved, normalizeItem, parseNode } from './board.mjs';
import { isClosedState } from './linear-card.mjs';
import { readJiraChildren, readJiraIssue, readJiraProject } from './board-jira.mjs';
import { readAzureChildren, readAzureIssue, readAzureProject, azureTags } from './board-azure.mjs';
import { JIRA_IDENTIFIER, LINEAR_IDENTIFIER, cardRef, compareCardIds, isAzureIdentifier } from './tracker.mjs';

const FIELDS_VERIFIED = ROUTING_FIELD ? `Statuses and ${ROUTING_FIELD}s` : 'Statuses';
const KIND_LABEL_NAMES = Object.values(KIND_LABELS);

// On native providers "number" carries the provider's public card identifier.
export function parseIssuePublishArgs(args, tracker = 'github') {
  if (!Array.isArray(args) || args.length < 1) {
    throw new Error(tracker === 'jira' ? 'expected a Jira issue key, optionally followed by child keys' : 'expected an issue number, optionally followed by child numbers');
  }

  const keyed = tracker === 'linear' || tracker === 'jira' || tracker === 'azure';
  const identifier = tracker === 'jira' ? JIRA_IDENTIFIER : LINEAR_IDENTIFIER;
  const numbers = args.map((arg) => {
    if (tracker === 'azure') {
      if (!isAzureIdentifier(arg)) throw new Error('expected an Azure card identifier AB-<positive int32>');
      return arg;
    }
    if (keyed) {
      if (typeof arg !== 'string' || !identifier.test(arg)) {
        throw new Error(`expected a ${tracker === 'jira' ? 'Jira issue key' : 'Linear issue ID'} such as ENG-123, received ${JSON.stringify(arg)}`);
      }
      return arg;
    }
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
    if (seen.has(number)) throw new Error(`duplicate issue ${keyed ? `ID ${number}` : `number #${number}`}`);
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

// A requested card's fields: a routing value where the board has a routing field, a Status, and exactly one
// kind label. Shared by every tracker's path; cardRef prints a GitHub number as #<number>.
function checkCardFields(number, card) {
  if (ROUTING_FIELD && (typeof card.routing !== 'string' || card.routing.trim() === '')) {
    throw new Error(`requested issue ${cardRef(number)} has no non-empty ${ROUTING_FIELD}`);
  }
  if (typeof card.status !== 'string' || card.status.trim() === '') {
    throw new Error(`requested issue ${cardRef(number)} has no non-empty Status`);
  }
  if (card.labels.some((label) => typeof label !== 'string')) {
    throw new Error(`requested issue ${cardRef(number)} has a label whose name is not text`);
  }
  const kindLabelCount = card.labels.filter((label) => KIND_LABEL_NAMES.includes(label)).length;
  if (kindLabelCount !== 1) {
    throw new Error(
      `requested issue ${cardRef(number)} needs exactly one kind label (${KIND_LABEL_NAMES.join(', ')}) but has ${kindLabelCount} (labels found: ${card.labels.length === 0 ? 'none' : card.labels.join(', ')})`,
    );
  }
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
    checkCardFields(number, card);
  }
  return archivedNumbers;
}

function formatNumbers(numbers) {
  return numbers.length === 0 ? 'none' : numbers.map(cardRef).join(', ');
}

// An Epic's children must be exactly the supplied set; either difference fails, each named.
function assertChildSet(subjectNumber, childNumbers, nativeChildNumbers) {
  const nativeSet = new Set(nativeChildNumbers);
  const suppliedSet = new Set(childNumbers);
  const notNative = childNumbers.filter((number) => !nativeSet.has(number)).sort(compareCardIds);
  const notSupplied = nativeChildNumbers.filter((number) => !suppliedSet.has(number)).sort(compareCardIds);
  if (notNative.length > 0 || notSupplied.length > 0) {
    throw new Error(
      `Epic ${cardRef(subjectNumber)} child mismatch: supplied but not native children: ${formatNumbers(notNative)}; native children but not supplied: ${formatNumbers(notSupplied)}`,
    );
  }
}

function boardVerifiedLines(requestedNumbers) {
  const requested = formatNumbers(requestedNumbers);
  return [
    `issue-publish: board presence verified for ${requested}.`,
    `issue-publish: ${FIELDS_VERIFIED} verified for ${requested}.`,
    `issue-publish: exactly one kind label verified for ${requested}.`,
  ];
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
  const verified = [
    ...boardVerifiedLines(requestedNumbers),
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

  assertChildSet(subjectNumber, childNumbers, nativeChildNumbers);

  return [
    ...verified,
    `issue-publish: native child set verified: #${subjectNumber} has exactly the ${childNumbers.length} supplied child issues.`,
  ];
}

// The pure card-file counterpart of verifyIssuePublication: the requested cards must each have a card file
// in the checkout (the reader already refused any file that lacks a real Status, kind or routing value),
// and an Epic's children, read from the Parent lines, must be exactly the supplied set.
export function verifyMarkdownPublication(args, cards) {
  const { subjectNumber, childNumbers } = parseIssuePublishArgs(args);
  const requestedNumbers = [subjectNumber, ...childNumbers];
  for (const number of requestedNumbers) {
    if (!cards.has(number)) throw new Error(`#${number} has no card file ${CARDS_DIR}/${number}.md in this checkout`);
  }
  const requested = formatNumbers(requestedNumbers);
  const verified = [
    `issue-publish: card files verified for ${requested}.`,
    `issue-publish: ${FIELDS_VERIFIED} verified for ${requested}.`,
    `issue-publish: exactly one kind verified for ${requested}.`,
  ];
  const children = [...cards.values()].filter((card) => card.parent === subjectNumber).map((card) => card.number);

  if (childNumbers.length === 0) {
    return [
      ...verified,
      `issue-publish: #${subjectNumber} verified as a standalone card; it has ${children.length} child cards (none supplied; pass them as arguments to verify an Epic).`,
    ];
  }

  assertChildSet(subjectNumber, childNumbers, children);
  return [
    ...verified,
    `issue-publish: child card set verified: #${subjectNumber} has exactly the ${childNumbers.length} supplied child cards.`,
  ];
}

const LINEAR_CHILDREN_QUERY =
  'query($id: String!, $after: String) { issue(id: $id) { children(first: 50, after: $after, includeArchived: true) { nodes { identifier } pageInfo { hasNextPage endCursor } } } }';

const LINEAR_DIRECT_QUERY =
  'query($id: String!) { issue(id: $id) { identifier team { key } archivedAt state { type } labels(first: 20) { nodes { name } pageInfo { hasNextPage } } } }';

// A requested card the Linear board read lacks, read directly. The board read leaves archived issues out, so a
// closed archived card of the team is judged as a Done card, an open archived one is the operator's to unarchive,
// and an issue that is not archived is one the read lagged.
function directLinearCard(id, exec) {
  const { issue } = exec(LINEAR_DIRECT_QUERY, { id });
  if (issue.identifier !== id) {
    throw new Error(`requested issue ${id} is ${issue.identifier} in Linear now, so this read is not the requested card; check the identifier rather than adding the card again.`);
  }
  if (issue.labels.pageInfo.hasNextPage) throw new Error(`${id}'s labels run past one page, so its kind label cannot be checked`);
  if (issue.team.key !== linearTeamKey()) {
    throw new Error(`requested issue ${id} belongs to team ${issue.team.key}, not the configured team ${linearTeamKey()}, so it is not on this board`);
  }
  if (issue.archivedAt === null) throw new Error(`requested issue ${id} is not in this board read, which lagged the card; re-run this check rather than adding the card again.`);
  if (!isClosedState(issue.state)) throw new Error(`requested issue ${id} is archived while still open; unarchive it, never add a second.`);
  return { status: TERMINAL_STATUSES[0], routing: null, labels: issue.labels.nodes.map((label) => label.name) };
}

// The Linear counterpart of verifyIssuePublication over the executor `exec(query, variables) -> data`: every
// requested card on the team's board with a Status and one kind label, and an Epic's children, archived ones
// included, exactly the supplied set by identifier.
export function verifyLinearPublication(args, exec) {
  const { subjectNumber, childNumbers } = parseIssuePublishArgs(args, 'linear');
  const requestedNumbers = [subjectNumber, ...childNumbers];
  const cards = new Map(readLinearBoard(exec).items.map(normalizeItem).map((card) => [card.number, card]));
  const archivedNumbers = [];
  for (const id of requestedNumbers) {
    let card = cards.get(id);
    if (!card) {
      card = directLinearCard(id, exec);
      archivedNumbers.push(id);
    }
    checkCardFields(id, card);
  }
  const children = allNodes(exec, LINEAR_CHILDREN_QUERY, { id: subjectNumber }, (data) => data.issue.children).map((child) => child.identifier);
  const verified = [
    ...boardVerifiedLines(requestedNumbers),
    ...(archivedNumbers.length === 0 ? [] : [
      `issue-publish: closed cards archived in Linear, verified by a direct read: ${formatNumbers(archivedNumbers)}.`,
    ]),
  ];
  if (childNumbers.length === 0) {
    return [
      ...verified,
      `issue-publish: ${subjectNumber} verified as a standalone issue; it has ${children.length} child issues (none supplied; pass them as arguments to verify an Epic).`,
    ];
  }
  assertChildSet(subjectNumber, childNumbers, children);
  return [
    ...verified,
    `issue-publish: child set verified: ${subjectNumber} has exactly the ${childNumbers.length} supplied child issues.`,
  ];
}


// Direct project-bound Jira reads need no GitHub board or pull-request call to verify filing.
export function verifyJiraPublication(args, exec) {
  const { subjectNumber, childNumbers } = parseIssuePublishArgs(args, 'jira');
  const project = readJiraProject(exec);
  const requested = [subjectNumber, ...childNumbers];
  for (const key of requested) {
    const issue = readJiraIssue(key, exec);
    if (!Array.isArray(issue.fields.labels)) throw new Error(`requested issue ${key} has unavailable labels`);
    checkCardFields(key, { status: project.columnOf(issue.fields.status), routing: null, labels: issue.fields.labels });
    const kind = Object.keys(KIND_LABELS).find((name) => issue.fields.labels.includes(KIND_LABELS[name]));
    if (issue.fields.issuetype.id !== project.config.issueTypes[kind]) throw new Error(`requested issue ${key} has an issue type that does not match its ${kind} kind`);
  }
  const children = readJiraChildren(subjectNumber, exec);
  const verified = boardVerifiedLines(requested);
  if (childNumbers.length === 0) {
    return [...verified, `issue-publish: ${subjectNumber} verified as a standalone issue; it has ${children.total} child issues (none supplied; pass them as arguments to verify an Epic).`];
  }
  assertChildSet(subjectNumber, childNumbers, children.issues.map(({ key }) => key));
  return [...verified, `issue-publish: child set verified: ${subjectNumber} has exactly the ${childNumbers.length} supplied child issues.`];
}

// Native direct reads prove the exact child identities and reciprocal parent evidence.
export function verifyAzurePublication(args, exec) {
  const { subjectNumber, childNumbers } = parseIssuePublishArgs(args, 'azure');
  const project = readAzureProject(exec);
  const requested = [subjectNumber, ...childNumbers];
  let subject;
  for (const id of requested) {
    const issue = readAzureIssue(id, exec, project);
    if (id === subjectNumber) subject = issue;
    const labels = azureTags(issue);
    checkCardFields(id, { status: project.columnOf(issue.fields['System.WorkItemType'], issue.fields['System.State']), routing: null, labels });
  }
  const children = readAzureChildren(subjectNumber, exec, project, subject);
  const verified = boardVerifiedLines(requested);
  if (childNumbers.length === 0) return [...verified, `issue-publish: ${subjectNumber} verified as a standalone issue; it has ${children.total} child issues (none supplied; pass them as arguments to verify an Epic).`];
  assertChildSet(subjectNumber, childNumbers, children.issues.map(({ id }) => 'AB-' + id));
  return [...verified, `issue-publish: child set verified: ${subjectNumber} has exactly the ${childNumbers.length} supplied child issues.`];
}
