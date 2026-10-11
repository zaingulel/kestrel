// Canonical test fixture for the raw boardQuery response shape.
// GitHub's ProjectV2Item.content field is nullable. parseBoardPage then
// normalizes that raw null to content: {}, which downstream tests should reach
// through the real parser rather than spelling a second response shape.
//
// Issue content defaults to the WHOLE shape boardQuery asks for — an OPEN issue in
// the configured repository, an empty sub-issue summary and four empty connections —
// so a test spells out only the field it is about. An explicit `null` is preserved,
// because the malformed shapes the parser's guards exist for are exactly those.

import {
  BOARD_OWNER,
  BOARD_OWNER_TYPE,
  BOARD_PROJECT_NUMBER,
  BOARD_REPOSITORY,
  PARKED_LANE,
  ROUTING_FIELD,
  ROUTING_OPTIONS,
  STATUS_OPTIONS,
} from './board-config.mjs';

function connection(nodes) {
  return { totalCount: nodes.length, nodes };
}

const withDefault = (value, fallback) => (value === undefined ? fallback : value);

// A friendly array → the connection the query returns. Only an array is converted:
// anything else (a hand-built truncated connection, an explicit null) rides through
// untouched so a guard test can spell the malformed shape it needs.
function issueConnection(value, toNode) {
  if (value === undefined) return connection([]);
  if (!Array.isArray(value)) return value;
  return connection(value.map(toNode));
}

const asNode = (node) => node;

export function leanNode({
  id = 'PVTI_fixture',
  content = null,
  fieldValues,
  title,
  status,
  routing,
  lane,
} = {}) {
  if (lane !== undefined && !PARKED_LANE) {
    throw new Error('leanNode: lane was passed but board-config.mjs configures no PARKED_LANE');
  }
  let normalizedContent = content;
  if (content != null && content.__typename === 'Issue') {
    const { labels, assignees, blockers, closingPullRequests, ...rest } = content;
    normalizedContent = {
      ...rest,
      state: withDefault(rest.state, 'OPEN'),
      repository: withDefault(rest.repository, { nameWithOwner: `${BOARD_OWNER}/${BOARD_REPOSITORY}` }),
      subIssuesSummary: withDefault(rest.subIssuesSummary, { total: 0, completed: 0 }),
      labels: issueConnection(labels, (name) => ({ name })),
      assignees: issueConnection(assignees, (login) => ({ login })),
      blockedBy: issueConnection(blockers, asNode),
      closedByPullRequestsReferences: issueConnection(closingPullRequests, asNode),
    };
  }

  const generatedFieldValues = [
    title != null ? { text: title, field: { name: 'Title' } } : null,
    status != null ? { name: status, field: { name: 'Status' } } : null,
    ROUTING_FIELD && routing != null ? { name: routing, field: { name: ROUTING_FIELD } } : null,
    lane != null ? { name: lane, field: { name: PARKED_LANE.field } } : null,
  ].filter(Boolean);
  if (fieldValues !== undefined && generatedFieldValues.length > 0) {
    throw new Error('leanNode: pass either fieldValues or named field shorthands, not both');
  }

  return {
    id,
    content: normalizedContent,
    fieldValues: connection(fieldValues ?? generatedFieldValues),
  };
}

// Fresh objects per page: a guard test mutates the schema it was handed, and a shared
// literal would leak that mutation into every later fixture in the file.
function fieldSchema() {
  return [
    { name: 'Title', dataType: 'TITLE' },
    { name: 'Status', dataType: 'SINGLE_SELECT', options: STATUS_OPTIONS.map((name) => ({ name })) },
    ...(ROUTING_FIELD
      ? [{ name: ROUTING_FIELD, dataType: 'SINGLE_SELECT', options: ROUTING_OPTIONS.map((name) => ({ name })) }]
      : []),
    ...(PARKED_LANE
      ? [{ name: PARKED_LANE.field, dataType: 'SINGLE_SELECT', options: [{ name: PARKED_LANE.option }] }]
      : []),
  ];
}

export function leanBoardPage(
  nodes,
  {
    totalCount = nodes.length,
    pageInfo = { hasNextPage: false, endCursor: null },
  } = {},
) {
  return {
    data: {
      [BOARD_OWNER_TYPE]: {
        login: BOARD_OWNER,
        projectV2: {
          id: 'PVT_fixture',
          number: BOARD_PROJECT_NUMBER,
          closed: false,
          fields: connection(fieldSchema()),
          items: { totalCount, pageInfo, nodes },
        },
      },
    },
  };
}
