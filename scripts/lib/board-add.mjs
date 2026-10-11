// board-add.mjs — pure id-resolution + orchestration for ADDING an issue to the
// board with its Status and routing field (Workstream here) already set; a board
// configured with no routing field sets Status only.
//
// board-move.mjs correctly refuses an issue that has no card ("#N is not on the
// board"), and the only scripted way forward was a bare `gh project item-add`,
// which drops a card with NO Status and NO Workstream — the #357-#361 failure mode
// the board scan's `unfieldedDrift` rule exists to catch AFTER the fact. This is
// the seam that prevents it, so that check goes back to being a backstop rather
// than the routine way these are found. `exec(args) → stdout` is injectable so this
// is unit-testable without `gh`.
//
// Field ids and option ids are resolved through board-move.mjs's helpers (one lean
// GraphQL read per field, off the project side) rather than re-derived here.

import { BOARD_OWNER, BOARD_REPOSITORY, ROUTING_FIELD } from './board-config.mjs';
import {
  singleSelectFieldQuery,
  parseSingleSelectField,
  optionIdFor,
} from './board-move.mjs';

// GraphQL for the issue's node id — what addProjectV2ItemById takes as contentId.
export function issueNodeIdQuery(issueNumber) {
  return `{ repository(owner:"${BOARD_OWNER}", name:"${BOARD_REPOSITORY}") { issue(number:${issueNumber}) { id } } }`;
}

// From the issueNodeIdQuery response, the issue's node id. Fail-loud if the shape is
// malformed or the id is missing — adding a card for an unresolved issue must fail.
export function parseIssueNodeId(json, issueNumber) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const id = d?.data?.repository?.issue?.id;
  if (typeof id !== 'string' || !id) throw new Error(`no node id for issue #${issueNumber}`);
  return id;
}

// Adds the issue's card. Idempotent by GitHub's own contract: for an issue already
// on the board, addProjectV2ItemById returns the EXISTING item instead of creating a
// duplicate, so re-running the seam is safe.
function addItemMutation(projectId, contentId) {
  return `mutation { addProjectV2ItemById(input:{projectId:"${projectId}", contentId:"${contentId}"}) ` +
    '{ item { id } } }';
}

function parseAddedItemId(json, issueNumber) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const id = d?.data?.addProjectV2ItemById?.item?.id;
  if (typeof id !== 'string' || !id) throw new Error(`add-item response has no item id for issue #${issueNumber}`);
  return id;
}

function setFieldMutation(projectId, itemId, fieldId, optionId) {
  return 'mutation { updateProjectV2ItemFieldValue(input:{' +
    `projectId:"${projectId}", itemId:"${itemId}", fieldId:"${fieldId}", ` +
    `value:{singleSelectOptionId:"${optionId}"}}) { projectV2Item { id } } }`;
}

function projectItemFieldsQuery(itemId) {
  return `{ node(id:"${itemId}") { ... on ProjectV2Item { fieldValues(first:20) { totalCount nodes { ` +
    '... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } } } } } }';
}

function parseProjectItemFields(json, itemId) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  if (
    d
    && typeof d === 'object'
    && Object.hasOwn(d, 'errors')
    && (!Array.isArray(d.errors) || d.errors.length > 0)
  ) {
    throw new Error(`board item ${itemId} field re-read returned GraphQL errors`);
  }
  const fieldValues = d?.data?.node?.fieldValues;
  if (!Array.isArray(fieldValues?.nodes) || fieldValues.totalCount !== fieldValues.nodes.length) {
    throw new Error(`board item ${itemId} field re-read was incomplete`);
  }
  const fields = {};
  for (const value of fieldValues.nodes) {
    const fieldName = value?.field?.name;
    if (fieldName !== 'Status' && (!ROUTING_FIELD || fieldName !== ROUTING_FIELD)) continue;
    if (typeof value.name !== 'string' || value.name === '') {
      throw new Error(`board item ${itemId} ${fieldName} field value was malformed`);
    }
    if (Object.hasOwn(fields, fieldName)) {
      throw new Error(`board item ${itemId} returned duplicate ${fieldName} field values`);
    }
    fields[fieldName] = value.name;
  }
  return fields;
}

function observedFieldOutcome(fieldName, fields) {
  return fields[fieldName] == null ? `${fieldName} is unset` : `${fieldName} = ${fields[fieldName]}`;
}

function shellArgument(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

// Put issue #issueNumber on the board with Status and, when ROUTING_FIELD is configured,
// the routing field set, and return `{ issueNumber, itemId, statusName, workstreamName }`
// (workstreamName is undefined with no routing field). Every id is resolved BEFORE
// the card is created, so an unknown Status or routing name fails without leaving
// an unfielded card behind. A failed field update throws naming which field(s) the
// card was left without — a partial add is never swallowed.
export function addIssueToBoard({ issueNumber, statusName, workstreamName }, exec) {
  // Validate here, not only in the CLI edge: issueNumber is interpolated into the
  // GraphQL query string, so an unvalidated value must fail before it is sent.
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`invalid issue number: ${issueNumber}`);
  }
  if (typeof statusName !== 'string' || !statusName.trim()) {
    throw new Error(`invalid status name: ${JSON.stringify(statusName)}`);
  }
  if (ROUTING_FIELD && (typeof workstreamName !== 'string' || !workstreamName.trim())) {
    throw new Error(`invalid workstream name: ${JSON.stringify(workstreamName)}`);
  }
  const query = (q) => exec(['api', 'graphql', '-f', `query=${q}`]);

  const contentId = parseIssueNodeId(query(issueNodeIdQuery(issueNumber)), issueNumber);
  const status = parseSingleSelectField(query(singleSelectFieldQuery('Status')), 'Status');
  const updates = [
    { fieldName: 'Status', fieldId: status.fieldId, optionId: optionIdFor(status.options, statusName) },
  ];
  if (ROUTING_FIELD) {
    const workstream = parseSingleSelectField(query(singleSelectFieldQuery(ROUTING_FIELD)), ROUTING_FIELD);
    updates.push(
      { fieldName: ROUTING_FIELD, fieldId: workstream.fieldId, optionId: optionIdFor(workstream.options, workstreamName, ROUTING_FIELD) },
    );
  }

  const itemId = parseAddedItemId(query(addItemMutation(status.projectId, contentId)), issueNumber);
  for (let i = 0; i < updates.length; i++) {
    try {
      query(setFieldMutation(status.projectId, itemId, updates[i].fieldId, updates[i].optionId));
    } catch (err) {
      const retry = [`node scripts/board-add.mjs ${issueNumber}`, shellArgument(statusName)]
        .concat(ROUTING_FIELD ? [shellArgument(workstreamName)] : [])
        .join(' ');
      let fields;
      try {
        fields = parseProjectItemFields(query(projectItemFieldsQuery(itemId)), itemId);
      } catch (readErr) {
        throw new Error(
          `#${issueNumber} was added to the board (item ${itemId}) but the ${updates[i].fieldName} update outcome is unknown — ` +
          `safely re-run the whole command: ${retry} — original error: ${err.message}; re-read failed: ${readErr.message}`,
          { cause: err },
        );
      }
      throw new Error(
        `#${issueNumber} was added to the board (item ${itemId}) but the ${updates[i].fieldName} update did not return a result — ` +
        `observed ${updates.map((update) => observedFieldOutcome(update.fieldName, fields)).join(', ')} — ` +
        `safely re-run the whole command: ${retry} — ${err.message}`,
        { cause: err },
      );
    }
  }
  return { issueNumber, itemId, statusName, workstreamName };
}
