// board-read.mjs — the board command's two reads, chosen by tracker: readBoard reads the board's items
// (and, for a markdown install, the cards and claims readDetails reads its details from), readDetails
// reads the details of the cards a listing names. Each branch calls its tracker's own reader and passes
// its result through unchanged. On GitHub a caller may hand either read the outcomes of the reads it
// started itself, `opening` as fetchBoard takes it and `started` as fetchCardDetails does, and the board read the
// `pause` fetchBoard waits through between retries.

import { fetchBoard, fetchCardDetails } from './board.mjs';
import { linearCardDetails, readLinearBoard } from './board-linear.mjs';
import { jiraCardDetails, readJiraBoard } from './board-jira.mjs';
import { azureCardDetails, readAzureBoard } from './board-azure.mjs';
import { markdownCardDetails, readMarkdownBoard } from './board-markdown.mjs';

/** @typedef {NonNullable<Parameters<typeof fetchBoard>[1]>} FetchOptions */
/** @typedef {import('./board.mjs').GhExecutor} GhExecutor */
/** @typedef {{ github: number, markdown: number, linear: string, jira: string, azure: string }} IdentifierByTracker what each tracker's card identifier is */
/** @typedef {(query: string, variables: unknown) => unknown} LinearExecutor */
/** @typedef {(request: unknown) => unknown} RequestExecutor the Jira and Azure transport: one request in, the parsed reply out */
/** @typedef {Array<(() => string) | undefined>} StartedDetails each a started batch read, in `cardDetailRequests` order */
/**
 * @template T
 * @typedef {T extends keyof IdentifierByTracker ? Array<IdentifierByTracker[T]> : never} IdentifiersFor one identifier list per tracker, distributed over a union T
 */

/**
 * @param {string} tracker
 * @param {{ executor: GhExecutor, linear?: LinearExecutor, jira?: RequestExecutor, azure?: RequestExecutor, onOmission?: (advisory: string) => void, opening?: FetchOptions['opening'], pause?: FetchOptions['pause'], budget?: FetchOptions['budget'] }} readers
 */
export function readBoard(tracker, { executor, linear, jira, azure, onOmission, opening, pause, budget }) {
  /** @type {ReturnType<typeof readMarkdownBoard> | null} */
  let markdown = null;
  let items;
  if (tracker === 'markdown') {
    markdown = readMarkdownBoard(executor);
    ({ items } = markdown);
  } else if (tracker === 'linear') {
    ({ items } = readLinearBoard(linear));
  } else if (tracker === 'jira') {
    ({ items } = readJiraBoard(jira, executor));
  } else if (tracker === 'azure') {
    ({ items } = readAzureBoard(azure, executor));
  } else {
    items = fetchBoard(executor, { onOmission, opening, pause, budget });
  }
  return { items, markdown };
}

/**
 * @template {keyof IdentifierByTracker} T
 * @param {T} tracker
 * @param {{ executor: GhExecutor, linear?: LinearExecutor, jira?: RequestExecutor, azure?: RequestExecutor, markdown?: ReturnType<typeof readMarkdownBoard> | null, started?: StartedDetails }} readers
 * @param {IdentifiersFor<T>} numbers
 */
export function readDetails(tracker, { executor, linear, jira, azure, markdown, started }, numbers) {
  return {
    markdown: () => {
      if (markdown == null) throw new Error('readDetails: a markdown details read needs the board snapshot readBoard returned');
      return markdownCardDetails(markdown.cards, numbers, markdown.refs);
    },
    linear: () => linearCardDetails(linear, numbers),
    jira: () => jiraCardDetails(jira, numbers),
    azure: () => azureCardDetails(azure, numbers),
    github: () => fetchCardDetails(executor, numbers, started),
  }[tracker]();
}

export const isFailedEmptyRead = (tracker, items) => tracker === 'github' && items.length === 0;
