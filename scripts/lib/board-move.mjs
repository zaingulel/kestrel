// board-move.mjs — pure id-resolution + orchestration for moving GitHub Projects
// cards' Status, and for parking them in (or releasing them from) the parked lane.
//
// Guards the failure mode that stranded #272: a /handoff CLOSED the issue but never
// moved its board card out of Backlog, because closing an issue does NOT touch its
// Project Status field — they are two separate operations. There was no tool to move
// a card (only a hand-rolled `gh project item-edit` with manually-fetched node-ids),
// so the move was skipped. This is the pure resolve layer the CLI
// (scripts/board-move.mjs) drives; kept pure so it is unit-testable without `gh`.
//
// #461: the original resolve strategy (`gh project view` + `field-list` +
// `item-list --limit 200`) cost a measured 308 GraphQL points PER card move — a
// 20-move handoff blew the entire 5,000/hr budget. Replaced with two lean GraphQL
// queries (1 point each, measured): a single "Status field + its options" query
// resolved ONCE per invocation, and a per-issue "which project item is this issue"
// query that reads off the issue side instead of paging the whole board. `moveCards`
// batches N pairs behind one status-field resolve, dropping a move to ~3 points.

import {
  BOARD_OWNER, BOARD_OWNER_TYPE, BOARD_PROJECT_NUMBER, BOARD_REPOSITORY, PARKED_LANE, ROUTING_FIELD,
} from './board-config.mjs';

// The value that clears a non-Status field (`--lane 12:none` releases a parked card).
// Status is never cleared: an unfielded card is drift the board scan reports.
const CLEAR_VALUE = 'none';

// GraphQL for a single-select field (id + options) on project #2. Also carries the
// project id, so one read resolves both.
export function singleSelectFieldQuery(fieldName) {
  return `{ ${BOARD_OWNER_TYPE}(login:"${BOARD_OWNER}") { projectV2(number:${BOARD_PROJECT_NUMBER}) { id field(name:"${fieldName}") ` +
    '{ ... on ProjectV2SingleSelectField { id options { id name } } } } } }';
}

// GraphQL for the project-item nodes backing issue #issueNumber, read off the issue
// side (no board paging). Carries the item's current value of `fieldName` alongside its
// id so moveCards can skip a redundant write (see parseIssueItemValue) in the same round
// trip, never a second one.
export function issueItemQuery(issueNumber, fieldName = 'Status') {
  return `{ repository(owner:"${BOARD_OWNER}", name:"${BOARD_REPOSITORY}") { issue(number:${issueNumber}) ` +
    '{ projectItems(first:10) { nodes { id project { number } '
    + `value: fieldValueByName(name: "${fieldName}") { ... on ProjectV2ItemFieldSingleSelectValue { name } } `
    + '} } } } }';
}

// From a singleSelectFieldQuery response, the project id + field id + its options.
// Fail-loud if the shape is malformed or the field is missing. `fieldName` only
// names the field in those two messages (defaults to Status, this module's caller).
export function parseSingleSelectField(json, fieldName = 'Status') {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const projectV2 = d?.data?.[BOARD_OWNER_TYPE]?.projectV2;
  if (!projectV2 || typeof projectV2.id !== 'string' || !projectV2.id) {
    throw new Error(`${fieldName.toLowerCase()}-field JSON has no project id`);
  }
  const field = projectV2.field;
  if (!field || typeof field.id !== 'string' || !field.id) {
    throw new Error(`no "${fieldName}" field on the project`);
  }
  const options = Array.isArray(field.options) ? field.options : [];
  return { projectId: projectV2.id, fieldId: field.id, options };
}

// Map a single-select value to its option id (case-insensitive, trimmed, multi-word
// like "In review" allowed). Throws — listing the valid options — if unknown, so a typo
// can never silently move a card to the wrong column or quietly no-op. `fieldName`
// names the field in that error only; board-add reads Workstream through this too, and
// a Workstream typo reported as `unknown Status` sends the reader to the wrong field.
export function optionIdFor(options, statusName, fieldName = 'Status') {
  const want = String(statusName).trim().toLowerCase();
  const opt = options.find((o) => String(o.name).toLowerCase() === want);
  if (!opt) {
    throw new Error(`unknown ${fieldName} "${statusName}" — valid options: ${options.map((o) => o.name).join(', ')}`);
  }
  return opt.id;
}

// The issueItemQuery response's project-item node for THIS project (number 2) among
// the issue's projectItems. Throws (fail-loud) if the issue isn't on the board — a
// move against a nonexistent card must fail, not no-op. Shared by parseIssueItemId
// and parseIssueItemValue so the "not on the board" diagnosis is worded once.
function findProjectItemNode(json, issueNumber) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const nodes = d?.data?.repository?.issue?.projectItems?.nodes;
  if (!Array.isArray(nodes)) throw new Error('issue projectItems JSON has no nodes[] array');
  const node = nodes.find((n) => n?.project?.number === BOARD_PROJECT_NUMBER);
  // Name the way forward: refusing without one is what pushed callers to a bare
  // `gh project item-add`, which drops a card with its fields empty — the #357-#361
  // drift the board scan catches only after the fact.
  if (!node) {
    throw new Error(ROUTING_FIELD
      ? `issue #${issueNumber} is not on the board — add it with Status and ${ROUTING_FIELD}: `
        + `node scripts/board-add.mjs ${issueNumber} <Status> <${ROUTING_FIELD}>`
      : `issue #${issueNumber} is not on the board — add it with a Status: node scripts/board-add.mjs ${issueNumber} <Status>`);
  }
  return node;
}

// From the issueItemQuery response, the project-item node id for THIS project.
export function parseIssueItemId(json, issueNumber) {
  const node = findProjectItemNode(json, issueNumber);
  if (typeof node.id !== 'string' || !node.id) throw new Error(`board item for #${issueNumber} has no id`);
  return node.id;
}

// From the same issueItemQuery response, the item's current option name for the queried
// field, or null when the field carries no value (a card added without one, #357-#361).
// Read off the same response parseIssueItemId already has — never a second query — so
// moveCards can tell a redundant write from a real one.
export function parseIssueItemValue(json, issueNumber) {
  return findProjectItemNode(json, issueNumber).value?.name ?? null;
}

// Parse `--batch <issue#>:<Status> [...]` (or `--lane <issue#>:<Lane>`) CLI args into
// { issueNumber, statusName } pairs. Splits on the FIRST colon so a value is never
// truncated. Fail-loud on a malformed pair — missing colon, non-numeric issue, or empty
// value. `valueLabel` only names the value in those messages.
export function parseBatchArgs(args, valueLabel = 'Status') {
  return args.map((arg) => {
    const idx = arg.indexOf(':');
    if (idx <= 0) throw new Error(`malformed batch pair "${arg}" — expected "<issue#>:<${valueLabel}>"`);
    const issueNumber = Number(arg.slice(0, idx));
    const statusName = arg.slice(idx + 1).trim();
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`malformed batch pair "${arg}" — issue number must be a positive integer`);
    }
    if (!statusName) throw new Error(`malformed batch pair "${arg}" — ${valueLabel.toLowerCase()} must not be empty`);
    return { issueNumber, statusName };
  });
}

// Set the single-select field `fieldName` (default Status) on each `{ issueNumber,
// statusName }` pair's card, resolving the field ONCE regardless of pair count. For a
// non-Status field, a value of CLEAR_VALUE clears the field instead; for Status it is
// just an unknown option. `exec(args) → stdout` is injectable so this is testable
// without `gh`. Fail-loud: a per-pair failure throws immediately — no silent
// continuation past a failed move — naming which moves already completed. A card
// already at the target value (closeout's Done, when the item-closed workflow already
// moved it), or already clear for a clear, is a no-op: no item-edit runs, so no
// redundant change event lands in the card's history. Returns the completed
// `{ issueNumber, statusName, skipped, cleared }` pairs, written (`skipped: false`) or
// already-there (`skipped: true`) alike, so a caller can report which happened. `cleared`
// is true when the pair cleared the field, whether this call wrote the clear or the field
// was already clear — computed once here so callers never re-derive it.
export function moveCards(pairs, exec, fieldName = 'Status') {
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('moveCards requires at least one pair');
  const { projectId, fieldId, options } = parseSingleSelectField(
    exec(['api', 'graphql', '-f', `query=${singleSelectFieldQuery(fieldName)}`]),
    fieldName,
  );
  const completed = [];
  for (const { issueNumber, statusName } of pairs) {
    try {
      // Validate here, not only in the CLI arg parsers: the exported moveCard()
      // is an in-process entry point, and issueNumber is interpolated into the
      // GraphQL query string — an unvalidated value must fail, not be sent.
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error(`invalid issue number: ${issueNumber}`);
      }
      if (typeof statusName !== 'string' || !statusName.trim()) {
        throw new Error(`invalid status name: ${JSON.stringify(statusName)}`);
      }
      const clear = fieldName !== 'Status' && statusName.trim().toLowerCase() === CLEAR_VALUE;
      const optionId = clear ? null : optionIdFor(options, statusName, fieldName);
      const itemJson = exec(['api', 'graphql', '-f', `query=${issueItemQuery(issueNumber, fieldName)}`]);
      const itemId = parseIssueItemId(itemJson, issueNumber);
      const current = parseIssueItemValue(itemJson, issueNumber);
      const alreadyThere = clear
        ? current == null
        : current != null && current.trim().toLowerCase() === statusName.trim().toLowerCase();
      if (!alreadyThere) {
        exec([
          'project', 'item-edit',
          '--id', itemId,
          '--project-id', projectId,
          '--field-id', fieldId,
          ...(clear ? ['--clear'] : ['--single-select-option-id', optionId]),
        ]);
      }
      completed.push({ issueNumber, statusName, skipped: alreadyThere, cleared: clear });
    } catch (err) {
      const done = completed.map((c) => `#${c.issueNumber} → ${c.statusName}`).join(', ') || 'none';
      throw new Error(
        `failed to move #${issueNumber} → "${statusName}" (already completed: ${done}) — ${err.message}`,
        { cause: err },
      );
    }
  }
  return completed;
}

// Park each `{ issueNumber, statusName }` pair's card in the parked lane's field, or
// release it with CLEAR_VALUE. With no parked lane configured this refuses before any
// `gh` call rather than writing a field the board does not use.
export function moveLanes(pairs, exec) {
  if (!PARKED_LANE) {
    throw new Error('--lane needs a parked lane, but scripts/lib/board-config.mjs sets PARKED_LANE = null');
  }
  return moveCards(pairs, exec, PARKED_LANE.field);
}
