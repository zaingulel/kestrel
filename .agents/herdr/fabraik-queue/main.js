// The Fabraik queue panel. Its own view is the inbox, drawn live from Herdr's agent list: each session blocked on the
// owner under Needs you, with the waiting menu its job asked and that menu's answers, and each working session under
// Running, each with Open, which selects its space, tab and pane. The inbox reads the waiting menus with `queue.mjs menus`
// and Herdr's terminal list at start-up, at each batch of changes under the ask folder and whenever the set of blocked
// sessions changes, never on a timer and never from the tracker; a deliver menu offers its yes only where the saved queue
// `queue.mjs refresh` wrote holds the decision card of the version its job asked about, else the control that opens
// Decisions to read it. `queue.mjs` beside this file builds that saved queue, which the views draw. Nothing here reads the
// tracker on a timer: each overlay view runs `queue.mjs refresh` once as it opens and again at each press of its Refresh control
// (and where a sheet opens or an answer lands), with the herdr-core terminal list it reads as each refresh begins; ages are
// clock times, which stay true with no timer. Its Clear runs `queue.mjs clear-digest`, and the owner's answers run
// `queue.mjs act` with the
// item's key, action and version (and an answer's text), a waiting menu's `queue.mjs answer-menu`, and Undo on a put-aside, accepted or rejected card's receipt runs `queue.mjs undo` with the record `act` printed. Each merge
// a view draws is a button that opens its merge's sheet, which shows at once the report `queue.mjs report`
// kept in `fabraik-queue/reports/`, in the file its sha and a digest of its repository name, else runs `queue.mjs report` with `<repository>@<sha>`, or joins that run
// where one is already going; the Board also reads its merges' reports that way in the background after each queue
// read. A copy opened with the props `{ view: "decisions" }` draws the
// saved queue as the Decisions view: a tile for each project, then each waiting item as a whole card under its project.
// The tile's runtime controls run `queue.mjs open-coordinator` with the registered project and runtime. Each card leads its title with the agent its card's claim names,
// or "Agent unknown". A card the view
// cannot read is a problem line in its place. One opened with `{ view: "floor" }`
// draws it as the Floor: a grid of every project's open cards, a row per project and a column per stage, whose card
// tiles are buttons that open the card's side sheet, which reads the card's current state as it opens, shows its detail and answers from the latest read. One opened with
// `{ view: "board", repository }` draws that project's board as the Board: a header naming the project and its Coordinator, a
// strip of what waits in other projects, and five columns, Needs you, Backlog, Ready to build, In progress and Merged,
// whose cards open the same side sheet and, on a GitHub board, carry the moves Move to Ready, Back to Backlog and Move
// up, which run `queue.mjs move` with the card's key, the move and the version drawn, as dragging the card between Backlog and Ready to build or to a place within it does, adding the place, and on a Ready to build or In progress
// card, and in that card's Board sheet, a Show me first switch, which runs `queue.mjs show-first` with the card's key and
// the state pressed. The inbox's Decisions and Floor controls, the Board strip's last control and the Floor's Open board
// control on a project open their view over the window in Herdr's one window overlay keyed `fabraik-queue-view`, which a
// later press replaces in place. Inbox Open selects the agent's space, tab and pane. The Decisions runtime controls
// leave a new or stopped Coordinator's tab handling to the project's locked opener. A view's header shows when it read,
// with Refresh and Close. Esc in a view ends a drag, else closes its open sheet, else closes the overlay, as its
// Close control does.
// @ts-expect-error Herdr supplies this module at panel load and ships no type declarations
import { View, div, image, svg } from "gpui-kit";
// @ts-expect-error Herdr supplies this module at panel load and ships no type declarations
import { v_flex, h_flex, TextView, Button, Toggle, InputState, Input, Progress, ProgressTrack, ProgressIndicator, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "gpui-base";
// @ts-expect-error Herdr supplies this module at panel load and ships no type declarations
import { exec, appHome, readTextFile, terminals, knownAgents, agents, panes, spaces, machines, setAgentOrder, run, watchFolder, theme, props, shared, setShared, openOverlay, closeOverlay, settings } from "herdr";

// Herdr's longest exec: queue.mjs gives each repository's reader up to 120 s, all at once.
const EXEC_OPTIONS = { timeout: 600000 };
// GPUI gives an image whose width is a share, such as w_full, its picture's own pixel height, leaving bands above and
// below a wide screenshot; a width in pixels gives it the height its proportions give. A taller one is held to this.
// The measured width is divided by the zoom: Herdr scales the panel's pixels by it, while the measure reports them after it.
const SHOT_MAX_HEIGHT = 360;
const CACHE_FORMAT = 2;
const MAX_ANSWER = 500;
// The kit takes an alpha as a last hex pair: 26 is 15 %.
const CHIP_ALPHA = "26";
const TIER_1 = ["merge", "question", "usage-limit"];
const TIER_2 = ["suggested", "failure"];
const TIERS = [...TIER_1, ...TIER_2];
// The categories that wait on the owner: each is counted and drawn as a card.
const WAITING = [...TIERS, "menu"];
const CATEGORIES = [...WAITING, "problem", "digest"];
const LABELS = {
  merge: "Merge awaiting your yes",
  question: "Blocking question",
  "usage-limit": "Stopped at a usage limit",
  suggested: "Suggested card",
  failure: "Run failed",
  menu: "Waiting at a menu",
};
// A weekly retro is a suggested item carrying its card drafts, and is named as its own kind.
const isRetro = (item) => item.proposals !== undefined;
const kindLabel = (item) => (isRetro(item) ? "Weekly retro" : isDeliver(item) ? DELIVER_CHIP : LABELS[item.category]);
const KIND_ROLES = {
  merge: "blocked",
  question: "blocked",
  failure: "blocked",
  menu: "blocked",
  "usage-limit": "working",
  suggested: "accent",
};
const SEND_LABEL = "Send answer";
// A waiting menu: a job at one of Claude's menus (queue.mjs `menu` items). The deliver question and the labels of a permission
// prompt and a plan repeat scripts/lib/owner-menu.mjs, which this panel cannot import.
const DELIVER_APPROVE = "Yes, deliver";
const DELIVER_CHIP = "Awaiting your yes";
const MENU_LABELS = { permission: ["Allow once", "Deny"], plan: ["Approve plan", "Keep planning"] };
const APPROVING = [DELIVER_APPROVE, "Allow once", "Approve plan"];
const MENU_PLACEHOLDER = "Or type your own answer";
const MENU_SEND_ALL = "Send answers";
const MENU_SEVERAL = "You may pick more than one";
const MENU_NOT_WHOLE = "The panel does not show this call whole, so it cannot allow it: deny it here, or answer in the job's tab";
const MERGE_AT_MENU = "Answer this card at its waiting menu, where the job waits for your answer";
// Why a deliver menu offers no yes: the decision card it shows is of another version than the one its job
// asked about, or the job could not read that version.
const MENU_OTHER_VERSION = "The decision card shown is not the version the job asked about";
const MENU_VERSION_UNREAD = "The job could not read the version it asked about";
// The inbox's control beside a deliver menu that offers no yes: Decisions reads the card's current version.
const READ_IN_DECISIONS = "Read it in Decisions";
// A waiting menu whose ask could not read its job's repository is grouped in the Decisions view under this heading.
const PROJECT_UNREAD = "Project not read";
const MENU_SENT = "Sent; waiting for the job to take it";
const MENU_DELIVERED = "Delivered to the job";
const NO_UNDO_MENU = "No Undo: the job may already have acted, so correct it in its tab";
const NEXT_READ = "; the queue confirms on its next read";
const RECEIPTS = {
  dismissed: "Dismissed",
  park: `Put aside${NEXT_READ}`,
  answer: `Answer recorded on the card${NEXT_READ}`,
  relay: "Sent to your coordinator chat",
  keep: `Accepted${NEXT_READ}`,
  drop: `Rejected${NEXT_READ}`,
  close: `Closed${NEXT_READ}`,
};
const PLAIN_NOTE = "Shown as written, without formatting or links.";
// The line under a merge's answer box, and the line of a merge whose waiting version the panel cannot read.
const CARRY_LINE = "Your coordinator chat gets this answer and carries it to the job.";
const UNREAD_VERSION_LINE = "The panel cannot read this card's waiting version, so answer in your coordinator chat.";
const HELD_UNREAD_LINE = "Answer this question in chat. The holding computer could not be read.";
// The saved queue is a file anyone can leave malformed, so only a name of one unbroken word is drawn as a computer's.
const heldLine = (machine) => (typeof machine === "string" && /^\S+$/.test(machine)
  ? `This question is waiting on ${machine}. Answer it in chat.` : HELD_UNREAD_LINE);
const NO_UNDO_COORDINATOR = "No Undo: your coordinator may already have read this answer, so correct it in chat";
// The written actions `queue.mjs undo` takes back; an answer has none.
const UNDOABLE = ["park", "keep", "drop"];
const NO_SCOPE_LINE = "Accept needs its What to build and acceptance criteria: answer it in chat";
const REPLACED_LINE = "This question changed; your draft was cleared.";
// The tab of a project's Herdr space its Coordinator runs in, and the state word of the line for each status Herdr gives
// its pane, after the muted label "Coordinator"; null is an agent that reports none yet.
const COORDINATOR_TAB = "Coordinator";
const COORDINATOR_OPEN = "Coordinator is already open.";
const COORDINATOR_RUNTIMES = new Map([["claude", "Claude Code"], ["codex", "Codex"]]);
const coordinatorUnread = (cause) => `Coordinator state unread: ${cause}`;
const COORDINATOR_LINES = new Map([
  ["working", { word: "working" }], ["blocked", { word: "waiting on you", blocked: true }],
  ["done", { word: "done" }], ["idle", { word: "idle" }], [null, { word: "starting" }],
]);
const PANEL_MOD = "fabraik-queue";
const VIEW_CLOSE_ID = "fabraik-queue-view-close";
const VIEW_REFRESH_ID = "fabraik-queue-view-refresh";
const FLOOR_ID = "fabraik-queue-floor-";
const SHEET_ID = `${FLOOR_ID}sheet`;
const SHEET_CLOSE_ID = `${FLOOR_ID}sheet-close`;
const SHEET_BODY_ID = `${FLOOR_ID}sheet-body`;
const SHEET_PANEL_ID = `${FLOOR_ID}sheet-panel`;
const SHEET_END_ID = `${FLOOR_ID}sheet-end`;
const SHEET_SHOTS_ID = `${FLOOR_ID}sheet-shots`;
const SHEET_TRY_ID = `${FLOOR_ID}sheet-try-again`;
const SHEET_SEEN_ID = `${FLOOR_ID}sheet-seen`;
const SHEET_PULL_ID = `${FLOOR_ID}sheet-pull`;
const SHEET_SHOW_FIRST_ID = `${FLOOR_ID}sheet-show-first`;
const DIGEST_ID = "fabraik-queue-digest-";
const SHEET_CONTEXT = "FabraikQueueSheet";
const SHEET_NEXT = "fabraik-queue-sheet-next";
const SHEET_PREV = "fabraik-queue-sheet-prev";
// A merge report's chips by outcome, and the sentences of why it did not wait that hold whatever its level and screen.
const REPORT_CHIPS = {
  nothing: "Merged, nothing needed you",
  waited: "Merged after it waited for you",
  disagrees: "Merged, but its record does not add up",
};
const REPORT_WHEN_NEEDED = "This project merges finished work on its evidence unless something needs you.";
const REPORT_ON_SCREEN = "This project merges finished work on its evidence unless it changes what you see.";
const REPORT_NOTHING_NEEDED = [
  "Its checks passed with nothing failed or untested, and its review settled every finding.",
  "It finished everything its card asked.",
  "It needed no sign-off and is easy to undo.",
  "Its card had no Show me first label when it merged.",
];
const SHEET_WIDTH = 420;
const SHEET_MAX_WIDTH = "92%";
// The sheet's slide in: its length, and the wait that lets the off-edge draw paint first, two frames at 60 Hz.
const SLIDE_MS = 150;
const SLIDE_WAIT_MS = 32;
// 99 is 60 %, the shade over the Floor or the Board behind the sheet.
const SHADE_ALPHA = "99";
// The Floor's columns after the project's, each named with a dot and an underline in its role.
const STAGES = [
  { id: "suggested", label: "Suggested", role: "accent" },
  { id: "ready", label: "Ready to build", role: "ansi5" },
  { id: "building", label: "Building", role: "working" },
  { id: "awaiting", label: "Awaiting your yes", role: "blocked" },
  { id: "merged", label: "Merged today", role: "done" },
];
const COLUMN_STAGES = new Map([["Ready", "ready"], ["In progress", "building"], ["In review", "building"], ["Awaiting push", "awaiting"]]);
const PROPOSED = "Proposed: ";
// The kinds that light a Floor tile.
const LIT_KINDS = [...TIER_1, "suggested", "failure"];
// 1F is 12 %, a lit tile's fill.
const TILE_ALPHA = "1F";
const PROJECT_WIDTH = 144;
const UNREADABLE_ENTRY = "Board unreadable: its board entry is not one this view can read";
const ORDER_MALFORMED = "the cache's build order is malformed";
// A card's version as queue.mjs writes it.
const CARD_VERSION = /^[0-9a-f]{64}$/;
const BOARD_ID = "fabraik-queue-board-";
const NEEDS_INCOMPLETE = "Not every card was read, so more may be waiting on you";
const PROBLEMS_UNREADABLE = "Project problems unreadable: the queue entry is not a list";
const NO_BOARD = "No board read for this project";
// The Merged column collapses to this many of the newest merges, plus any a report says does not add up.
const MERGED_SHOWN = 3;
const MERGED_UNCHECKED = "Not every hidden merge has been checked, so one whose record does not add up may be among them";
// The Board's columns, each named with a dot and an underline in its role.
const BOARD_COLUMNS = [
  { id: "needs", label: "Needs you", role: "blocked", empty: "Nothing waiting on you" },
  { id: "backlog", label: "Backlog", role: "idle", note: "Moving a card to Ready approves it to be built.", empty: "Nothing in the backlog" },
  { id: "ready", label: "Ready to build", role: "ansi5", note: "Cards start from the top.", empty: "Nothing ready to build" },
  { id: "progress", label: "In progress", role: "working", empty: "Nothing in progress" },
  { id: "merged", label: "Merged", role: "done", empty: "Nothing merged in the last day" },
];
const BOARD_PLACES = new Map([[null, "backlog"], ["Backlog", "backlog"], ["Ready", "ready"], ["In progress", "progress"],
  ["In review", "progress"], ["Awaiting push", "progress"]]);
// The line under a Board card's title for a proposal and for the columns In progress gathers.
const SUGGESTED_LINE = "Suggested card: accept or reject it in Needs you";
const CARD_LINES = new Map([["In review", "Merging"], ["Awaiting push", "Awaiting your yes"]]);
// The strip's chips name each kind shortly; it shows three at most. 14 is 8 %, its fill.
const SHORT_KINDS = { merge: "merge", question: "question", "usage-limit": "stopped", suggested: "suggested", failure: "failed run" };
const STRIP_CHIPS = 3;
const STRIP_ALPHA = "14";
// What a Board write's success line adds to its words, and the lines for a board that takes no moves or no Show me first.
const MOVE_CONFIRMS = "; the board confirms on its next read";
const MOVES_NOT_GITHUB = "Moves and Show me first not offered: the panel changes cards only on a GitHub board; change them in your tracker";
const MOVES_OLD_READER = "Moves and Show me first not offered: this project's queue reader predates them";
const SHOW_FIRST = "Show me first";
const SHOW_FIRST_OLD_READER = "Show me first not offered: this project's queue reader predates it";
const PLACES_OLD_READER = "Dragging a card within Ready to build not offered: this project's queue reader predates it";
// 14 is 8 %, the fill of a column's list while a dragged card would land in it.
const DROP_ALPHA = "14";
// The space between a Board list's cards, which is also how far past a card a drag still reads it as the nearest.
const BOARD_LIST_GAP = 8;
// Once a merge is queued its marker is not read again, so an In review card's switch says so.
const SHOW_FIRST_QUEUED = "If its merge is already queued, Show me first does not stop it: use Disable auto-merge on its pull request";
// The stages whose cards show the agent that holds them.
const AGENT_STAGES = /** @type {(string | null)[]} */ (["ready", "building", "awaiting"]);
// The states a tied terminal reports, most urgent first; null is no report.
const AGENT_STATES = ["blocked", "working", "done", "idle", "error", null];
const AGENT_WAITING = "Agent waiting on you";
// The line under a card's title for its agent's state.
const AGENT_LINES = new Map([["blocked", AGENT_WAITING], ["working", "Building now"], ["done", "Agent done"], ["idle", "Agent idle"],
  ["error", "Agent state unknown"], [null, "Agent state not reported"]]);
// The runtimes a claim names, each with the key of Herdr's program for it.
const RUNTIME_PROGRAMS = new Map([["Claude Code", "claude"], ["Claude Code cloud", "claude"], ["Codex", "codex"]]);
const SPINNER = "mods/workspace-chrome/spinner.svg";
const SEND = "mods/workspace-chrome/chevron-right.svg";
const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();
const folderName = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const twoDigits = (number) => String(number).padStart(2, "0");
const clock = (iso) => { const at = new Date(iso); return `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const datedClock = (at) => { const day = new Date(at); return `${day.getDate()} ${MONTHS[day.getMonth()]}, ${clock(at)}`; };
const plural = (count, unit) => `${count} ${unit}${count === 1 ? "" : "s"}`;
const cardRef = (item) => (item.category === "menu" ? `card ${item.card}` : `${folderName(item.repository)} card ${item.card}`);
const firstLine = (text) => text.split("\n").map(oneLine).find(Boolean) ?? "";
// The key a mark and a draft are kept by: the item as drawn, at the version the owner saw.
const versioned = (item) => `${item.key}@${item.version ?? item.askId}`;
const sameKeys = (a, b) => a.size === b.size && [...a].every((key) => b.has(key));
const localDate = () => new Date().toDateString();
// The questions a waiting menu asks as the panel draws them: Claude's own, or the one choice of a permission prompt or a plan.
// A permission prompt offers Allow once only where the panel shows its call whole, as the hook allows only then.
const menuForm = (item) => (item.kind === "question" ? item.questions
  : [{ question: item.kind, header: item.kind, multiSelect: false, options: MENU_LABELS[item.kind]
    .filter((label) => !(item.kind === "permission" && item.whole !== true && label === "Allow once")).map((label) => ({ label })) }]);
// A deliver menu is any question menu a question of which offers Yes, deliver, as the hook classifies it; the version check
// then decides whether the yes is offered, so a layout the hook could not record offers none.
const isDeliver = (item) => item.category === "menu" && item.kind === "question"
  && item.questions.some((q) => q.options.some((option) => option.label === DELIVER_APPROVE));
// A menu with one single-select question is answered by one press on a choice; any other is answered by one send.
const isSimple = (item) => menuForm(item).length === 1 && !menuForm(item)[0].multiSelect;
const menuDraftKey = (item, index) => `${versioned(item)}#${index}`;
const menuTitle = (item) => (item.kind === "question" ? item.questions[0].header : item.kind === "permission" ? item.toolName : "Plan");
const menuLine = (item) => (item.kind === "question" ? item.questions[0].question : item.kind === "permission" ? `Wants to run ${item.toolName}` : "Plan ready");
const titleOf = (item) => (item.category === "menu" ? menuTitle(item) : item.title);
// The merge of a waiting menu's own repository and card, none where its repository was not read: the hook records the card
// as the string the job's mark holds.
const mergeOf = (items, menu) => (menu.repository === undefined ? undefined
  : items.find((found) => found.category === "merge" && found.repository === menu.repository && found.card === Number(menu.card)));
// Whether a deliver menu's job asked about the version `merge` shows: its head and its saved files' identities.
const askedAbout = (merge, menu) => merge !== undefined && menu.version !== undefined
  && merge.head === menu.version.head && merge.identity === menu.version.identity;
// Whether a waiting menu of the merge's repository and card is listed, which is then the one place to answer it.
const hasMenu = (items, merge) => items.some((found) => found.category === "menu" && found.repository === merge.repository && Number(found.card) === merge.card);
// The record `answer-menu` writes: `entries` hold, for each question of the form, its `choices` and its `text`.
function menuAnswer(item, entries) {
  const base = { format: 1, askId: item.askId, by: "panel" };
  if (item.kind === "question") return { ...base, answers: Object.fromEntries(item.questions.map((q, index) => [q.question, entries[index]])) };
  const [{ choices, text }] = entries;
  return { ...base, ...(text === undefined ? { choice: choices[0] } : { text }) };
}
// The keys of the drafts an item holds: one answer box for a merge or an answerable question, one for each question of an
// answerable waiting menu.
const draftKeys = (item) => (item.category === "menu" ? (item.answerable ? menuForm(item).map((_, index) => menuDraftKey(item, index)) : [])
  : item.category === "merge" || (item.category === "question" && item.answerable === true) ? [versioned(item)] : []);
const digestOf = (cache) => cache.items.filter((item) => item.category === "digest");
const problemTexts = ({ problems, items }) => [
  ...problems,
  ...items.filter((item) => item.category === "problem").map((item) => `${folderName(item.repository)}: ${item.problem}`),
];

// The terminal list a refresh reads the waiting menus' terminal states from, as its one argument: each herdr-core terminal's address and
// status report state, or why the app could not give the list. Only these fields go, keeping the argument small; a
// terminal without a report key keeps none, so queue.mjs refuses the list.
function terminalList() {
  try {
    return JSON.stringify(terminals().map(({ address, report }) => ({ address, report: report && { state: report.state } })));
  } catch (error) {
    return JSON.stringify({ unread: String(/** @type {{ message?: string } | null} */ (error)?.message ?? error) });
  }
}

// The sessions the inbox draws, from Herdr's live agent list: the blocked and the working, each a record with the fields the
// inbox draws and Open selects by, and the count of records without them, which are never drawn.
const isAgent = (agent) => typeof agent === "object" && agent !== null && typeof agent.program?.name === "string"
  && ["address", "status", "space", "tab", "space_name", "tab_name"].every((field) => typeof agent[field] === "string");
function inboxAgents() {
  const list = agents();
  const readable = list.filter(isAgent);
  return {
    blocked: readable.filter((agent) => agent.status === "blocked"),
    running: readable.filter((agent) => agent.status === "working"),
    unreadable: list.length - readable.length,
  };
}
// The blocked sessions' addresses as one text, so two sets compare as equal.
const blockedKey = (blocked) => blocked.map((agent) => agent.address).sort().join("\n");

// What a run of `queue.mjs menus` printed, as `{ menus }`, the `{ items, problems }` it read, each item a waiting menu with
// the fields the inbox finds it by, or `{ failure }`, why the panel cannot read it.
const isMenuItem = (item) => typeof item === "object" && item !== null && item.category === "menu"
  && typeof item.key === "string" && typeof item.terminal === "string" && typeof item.askId === "string" && Number.isFinite(item.askedAt);
function readMenusOutput(stdout) {
  let read;
  try {
    read = JSON.parse(stdout);
  } catch {
    return { failure: "the queue printed no JSON" };
  }
  return Array.isArray(read?.items) && read.items.every(isMenuItem) && Array.isArray(read.problems) && read.problems.every(isText)
    ? { menus: read } : { failure: "the queue printed no list of waiting menus" };
}

// When a read or fetch was made, as a clock time that needs no timer to stay true: "Read at 14:02", and with the date,
// "Read 18 Nov, 14:02", when it was not today.
function stamp(verb, iso) {
  return isToday(iso) ? `${verb} at ${clock(iso)}` : `${verb} ${datedClock(iso)}`;
}

function problemLine(t, text) {
  return div().text_color(t.foreground).child(text);
}

function mutedLine(t, text) {
  return div().text_color(t.muted).child(text);
}

// A project's Coordinator line: its label muted and its state word in the foreground, on one line; a line with no state
// word muted.
function coordinatorLine(t, line) {
  if (line.word === undefined) return mutedLine(t, line.text);
  return h_flex().child(div().text_color(t.muted).child("Coordinator ")).child(div().text_color(t.foreground).child(line.word));
}

// A button pressed by `onClick`, or, where it is null, a button beneath the open sheet, which takes no press and no Tab.
const pressedBy = (button, onClick) => (onClick === null ? button.tab_stop(false) : button.on_click(onClick));

function controlButton(t, id, label, onClick, disabled = false) {
  return pressedBy(Button.new(id).h(24).min_w(24).px(8).flex().items_center().justify_center().rounded(6).border_1()
    .border_color(t.border).focus((s) => s.border_color(t.foreground)).disabled(disabled), onClick)
    .when(!disabled && onClick !== null, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
    .when(disabled, (el) => el.text_color(t.dim)).child(label);
}

function solidButton(t, id, label, onClick, disabled) {
  return pressedBy(Button.new(id).min_h(28).px(12).flex().items_center().justify_center().rounded(6).bg(t.solid).border_1()
    .border_color(t.solid).text_color(t.solid_foreground).text_size(13).font_medium()
    .focus((s) => s.bg(t.accent).border_color(t.accent).text_color(t.accent_foreground)).disabled(disabled), onClick)
    .when(!disabled && onClick !== null, (el) => el.cursor_pointer()).when(disabled, (el) => el.opacity(0.6)).child(label);
}

// The item's kind: its label in the foreground on a tint of its role, outlined in that role; a handled item's label is
// muted, with no tint or outline.
function kindChip(t, item, handled) {
  return handled ? chipBox().text_color(t.muted).child(kindLabel(item)) : roleChip(t, t[KIND_ROLES[item.category]], kindLabel(item));
}

const chipBox = () => div().flex_none().h(20).px(7).flex().items_center().rounded(5).text_size(11.5).font_semibold();

// A chip's label in the foreground on a tint of `role`, outlined in that role.
const roleChip = (t, role, label) => chipBox().text_color(t.foreground).bg(role + CHIP_ALPHA).border_1().border_color(role).child(label);

// Herdr holds the merges the owner has seen under one shared key, `{ "<repository>@<sha>": "<ISO time>" }`, so every view
// and a restarted copy find them; each write drops the marks older than 48 hours. A store that is no such record reads as
// no marks, with the cause: every merge then shows New, and the next write replaces the store.
const SEEN_KEY = "fabraik-queue.seen";
const SEEN_KEEP_MS = 48 * 3600000;
const isTime = (at) => typeof at === "string" && Number.isFinite(Date.parse(at));
function seenStore() {
  const held = shared(SEEN_KEY);
  if (held === undefined || held === null) return { marks: {}, cause: null };
  if (typeof held === "object" && !Array.isArray(held) && Object.values(held).every(isTime)) return { marks: held, cause: null };
  return { marks: {}, cause: "the stored marks are not a record of times" };
}
const isUnseen = (repository, sha) => !Object.hasOwn(seenStore().marks, `${repository}@${sha}`);
// Marks each of the repository's merges in `shas` seen, in one write.
function markSeen(repository, shas) {
  const kept = Object.entries(seenStore().marks).filter(([, at]) => Date.now() - Date.parse(at) < SEEN_KEEP_MS);
  const now = new Date().toISOString();
  setShared(SEEN_KEY, { ...Object.fromEntries(kept), ...Object.fromEntries(shas.map((sha) => [`${repository}@${sha}`, now])) });
}
// The line naming a seen store the panel cannot read, or none.
const seenNotice = (t) => {
  const { cause } = seenStore();
  return cause === null ? [] : [problemLine(t, `Seen merges not read: ${cause}`)];
};

// The chip leading a merge the owner has not seen: "New" in the foreground on a tint of accent, outlined in it.
const newChip = (t) => roleChip(t, t.accent, "New");

// A merged opener's first row: its first line, led by the New chip while the merge is unseen.
const mergeRow = (t, unseen, first) => (unseen ? h_flex().max_w_full().items_center().gap(6).child(newChip(t)).child(first.min_w_0()) : first);

// How long a card has waited, as the clock time its agent asked it, which needs no timer to stay true. Only a waiting
// menu records that time; one that is not a readable past time is said to be unreadable, never drawn as a clock.
function waitedText(item) {
  if (item.category !== "menu") return "wait time not recorded";
  if (!Number.isFinite(item.askedAt) || item.askedAt > Date.now() || Number.isNaN(new Date(item.askedAt).getTime())) return "wait time unreadable";
  return `waiting since ${isToday(item.askedAt) ? clock(item.askedAt) : datedClock(item.askedAt)}`;
}

// The kind chip, the folder and card, and its wait time, which lead a row and an open card.
function cardHeading(t, item) {
  return h_flex().items_center().gap(8).child(kindChip(t, item, false))
    .child(h_flex().text_size(11).text_color(t.muted).child(div().child(cardRef(item))).child(div().child(`, ${waitedText(item)}`)));
}

// The one line a closed item shows under its title.
function summary(item) {
  if (item.category === "menu") return menuLine(item);
  if (item.category === "merge") return item.missing ? `Proof missing: ${item.missing.fact}. ${item.missing.next}` : item.reason ?? firstLine(item.decisionCard ?? "");
  return item.category === "question" ? item.question : item.reason ?? "";
}

// A weekly retro's write-up, as Markdown or, where it is carried as plain text, line by line under its note, then its
// card drafts: each as plain lines and never through the Markdown view, so a draft reads exactly as it will be filed.
function retroDetail(t, { key, writeUp, proposals }) {
  const lines = (text) => text.split("\n").map((line) => div().child(line));
  const under = (name, texts) => [mutedLine(t, name), ...texts.flatMap(lines)];
  const draft = ({ n, repository, title, label, type, workstream, problem, build, criteria }) => v_flex().gap(6).children([
    ...lines(`Proposal ${n} for ${repository}`),
    ...lines(`Title: ${title}`),
    ...lines(label === undefined ? `Type: ${type}` : `Label: ${label}`),
    ...(workstream === undefined ? [] : lines(`Workstream: ${workstream}`)),
    ...under("Problem", [problem]),
    ...under("What to build", [build]),
    ...under("Acceptance criteria", criteria),
  ]);
  return [
    ...(typeof writeUp === "string" ? [TextView.markdown(`queue-retro-${key}`, writeUp)] : [mutedLine(t, PLAIN_NOTE), ...lines(writeUp.plain)]),
    ...(proposals.length === 0 ? [mutedLine(t, "No card can be made from this retro.")] : [v_flex().gap(12)
      .child(v_flex().gap(6).child(div().text_size(13).font_semibold().child("Cards you can make"))
        .child(mutedLine(t, "Each card is shown exactly as it will be filed, without formatting or links.")))
      .children(proposals.map(draft))]),
  ];
}

// A project's one local space, undefined where none is open, or why this computer's layout cannot tell.
function coordinatorSpace(board) {
  const layout = machines().find((machine) => machine.name === null)?.layout;
  if (layout === "loading") return { unread: coordinatorUnread("Herdr is still loading this computer's spaces") };
  if (layout !== "ready") return { unread: coordinatorUnread("Herdr reports this computer's layout unavailable") };
  const own = spaces().filter((space) => space.machine === null && [board.repository, board.folder].includes(space.folder));
  if (own.length > 1) return { unread: coordinatorUnread("two spaces open this folder") };
  const [space] = own;
  if (space && !Array.isArray(space.tabs)) return { unread: coordinatorUnread("its tabs cannot be read") };
  return { space };
}

// A project's Coordinator line and its flags, whether it waits on the owner and whether its state was not read (which only
// the Floor reads), from the project's board entry (undefined where the read has none): the Coordinator pane's most
// urgent reported status, so a running coordinator never reads as done.
/** @typedef {{ text?: string, word?: string, unread?: boolean, blocked?: boolean }} CoordinatorLine A Coordinator line and its flags. */

/** @returns {CoordinatorLine} */
function coordinatorStatus(board) {
  if (board === undefined) return { text: "Coordinator state not in this read" };
  const { space, unread } = coordinatorSpace(board);
  if (unread) return { text: unread, unread: true };
  if (!space) return { text: "No Herdr space for this project" };
  const tabs = new Set(space.tabs.filter((tab) => tab?.name === COORDINATOR_TAB).map((tab) => tab.id));
  if (tabs.size === 0) return { text: "No Coordinator tab in this project's space" };
  const states = panes().filter((pane) => tabs.has(pane.tab) && pane.program?.agent === true).map((pane) => pane.status);
  const state = ["blocked", "working", "done", "idle", null].find((status) => states.includes(status));
  return state === undefined ? { text: "Coordinator not running" } : /** @type {CoordinatorLine} */ (COORDINATOR_LINES.get(state));
}

// Opening requires an unambiguous raw tab and pane. The display line can summarize several panes, which cannot
// authorize replacing a stopped Coordinator.
function coordinatorOpenBlock(board) {
  const { space, unread } = coordinatorSpace(board);
  if (unread) return unread;
  if (!space) return null;
  if (space.tabs.some((tab) => typeof tab?.name !== "string")) return coordinatorUnread("its tabs cannot be read");
  const tabs = space.tabs.filter((tab) => tab.name === COORDINATOR_TAB);
  if (tabs.length === 0) return null;
  const [tab] = tabs;
  if (tabs.length !== 1 || typeof tab.id !== "string" || !tab.id) return coordinatorUnread("its Coordinator tab is ambiguous");
  const matching = panes().filter((pane) => pane?.tab === tab.id);
  const [pane] = matching;
  if (tab.panes !== 1 || matching.length !== 1 || typeof pane.pane !== "string" || !pane.pane
    || typeof pane.terminal !== "string" || !pane.terminal) {
    return coordinatorUnread("its Coordinator pane is ambiguous");
  }
  const { program, status } = pane;
  if (program?.shell === true && program.agent === false && status === null) return null;
  if (program?.shell === false && program.agent === true && COORDINATOR_RUNTIMES.has(program.key)
    && COORDINATOR_LINES.has(status)) return COORDINATOR_OPEN;
  return coordinatorUnread("its Coordinator pane has no recognized program state");
}

// Recheck the collector's optional settings because the mod reads the saved cache without loading queue.mjs.
function coordinatorChoice(board) {
  if (board?.moves !== true || !Array.isArray(board.cards) || board.unreadable !== undefined) return null;
  const choice = board.coordinator;
  if (choice === undefined) return { unread: "Saved default unavailable. Refresh after updating this project's Fabraik release." };
  if (typeof choice?.unread === "string" && oneLine(choice.unread) && Object.keys(choice).length === 1) {
    return { unread: `Saved default unavailable: ${firstLine(choice.unread).slice(0, 500)}` };
  }
  if (choice && Object.keys(choice).length === 2 && COORDINATOR_RUNTIMES.has(choice.runtime) && Array.isArray(choice.installed)
    && choice.installed.length > 0 && choice.installed.every((runtime) => COORDINATOR_RUNTIMES.has(runtime))
    && new Set(choice.installed).size === choice.installed.length) return choice;
  return { unread: "Saved default unavailable: the queue returned invalid coordinator settings" };
}

// The project tile keeps its Coordinator line and carries the runtime controls below it.
function projectTile(t, repository, waiting, line, controls) {
  return v_flex().flex_grow(1).flex_shrink(1).flex_basis(200).min_w(0).gap(6).px(12).py(10).rounded(10).bg(t.raised).border_1()
    .border_color(line.blocked ? t.blocked : t.border)
    .child(h_flex().items_center().justify_between().gap(8)
      .child(div().min_w(0).truncate().text_size(14).font_semibold().child(folderName(repository)))
      .child(div().flex_none().text_size(12).text_color(t.muted).child(waiting === 0 ? "Nothing for you" : `${waiting} need you`)))
    .child(coordinatorLine(t, line).text_size(12)).children(controls);
}

// The Floor stage a board card is drawn in, or null where it is not drawn: a proposed card is Suggested whatever its
// column, and Backlog, a null column and a column with no stage are not drawn.
function floorStage(card) {
  if (card.title.startsWith(PROPOSED)) return "suggested";
  return COLUMN_STAGES.get(card.column) ?? null;
}
const floorRef = (id) => (typeof id === "number" ? `#${id}` : id);
const floorTitle = (title) => (title.startsWith(PROPOSED) ? title.slice(PROPOSED.length) : title);
const isToday = (iso) => new Date(iso).toDateString() === localDate();

// The panel cannot load queue.mjs, which checks the board first, so the Floor and the Board check again each field they
// draw.
const isOptionalText = (value) => value === undefined || value === null || typeof value === "string";
const isOutcome = (outcome) => outcome === undefined || outcome === null
  || (typeof outcome === "object" && typeof outcome.unread === "string")
  || (typeof outcome === "object" && typeof outcome.text === "string" && typeof outcome.more === "boolean");
const isCardId = (id) => (Number.isSafeInteger(id) && id > 0) || (typeof id === "string" && id !== "");
// A card's Show me first marker as queue.mjs admits it: absent where its reader predates it, a boolean, or exactly
// `{ unread: <cause> }`.
const isMarker = (marker) => marker === undefined || typeof marker === "boolean"
  || (typeof marker === "object" && marker !== null && Object.keys(marker).join() === "unread" && typeof marker.unread === "string");
const isFloorCard = (card) => typeof card === "object" && card !== null && isCardId(card.card) && typeof card.title === "string"
  && (card.column === null || typeof card.column === "string")
  && Array.isArray(card.blockers) && card.blockers.every(isCardId)
  && (card.waitsOn === undefined || card.waitsOn === null || TIERS.includes(card.waitsOn))
  && (card.unread === undefined || typeof card.unread === "string")
  && isOutcome(card.outcome)
  && (card.claim === undefined || card.claim === null || (typeof card.claim === "object" && typeof card.claim.machine === "string"
    && (card.claim.runtime === undefined || typeof card.claim.runtime === "string")))
  && isOptionalText(card.worktree)
  && (card.version === undefined || (typeof card.version === "string" && CARD_VERSION.test(card.version)))
  && isMarker(card.showFirst);
const isProject = (board) => typeof board?.repository === "string";
const isMerge = (merge) => typeof merge?.sha === "string" && typeof merge.subject === "string" && typeof merge.at === "string"
  && !Number.isNaN(Date.parse(merge.at));

// A merge's report as `queue.mjs report` prints it, checked field by field before it is drawn: a field the reader could
// not read is `{ unread }`, and each outcome carries only its own fields. Anything else is a report the panel cannot read.
const isText = (value) => typeof value === "string";
const isUnreadField = (value) => typeof value === "object" && value !== null && isText(value.unread);
const isPlainField = (value) => typeof value === "object" && value !== null && isText(value.plain);
const isReadOr = (value, isRead) => isUnreadField(value) || isRead(value);
const isReportShot = (shot) => typeof shot === "object" && shot !== null && isText(shot.alt) && (isText(shot.path) || isText(shot.unread));
const OUTCOME_FIELDS = new Map([
  ["nothing", (report) => ["when-needed", "on-screen"].includes(report.level)],
  ["waited", (report) => isText(report.waiting)],
  ["disagrees", (report) => Array.isArray(report.holds) && report.holds.every(isText)],
  ["unread", (report) => isText(report.cause)],
]);
const isReport = (report) => typeof report === "object" && report !== null && report.format === 1
  && (report.direct === true || (
    typeof report.pull === "object" && report.pull !== null && isText(report.pull.title) && Number.isSafeInteger(report.pull.number)
    && isText(report.pull.url) && report.pull.url.startsWith("https://")
    && isReadOr(report.card, (card) => typeof card === "object" && card !== null && isText(card.title))
    && isReadOr(report.changed, (changed) => isText(changed) || isPlainField(changed))
    && isReadOr(report.checks, (checks) => Array.isArray(checks) && checks.every(isText))
    && typeof report.noScreen === "boolean"
    && OUTCOME_FIELDS.get(report.outcome)?.(report) === true
    && Array.isArray(report.screenshots) && report.screenshots.every(isReportShot)));

// What a run of `queue.mjs report` gives the sheet: the report it printed, or why the panel cannot read it.
function readReportOutput(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    report = undefined;
  }
  return isReport(report) ? { report } : { failure: "the queue printed a report this panel cannot read" };
}

// A merge sha the queue reads: the twin of the sha half of queue.mjs's `REPORT_KEY`, so a kept report's file name is only
// ever one the queue could have written.
const MERGE_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
// A kept report's file name: the merge sha and the 32-bit FNV-1a hash of the repository in eight hex characters, so the
// name stays short whatever the repository's path. queue.mjs computes the same name.
function keptReportName(repository, sha) {
  let hash = 0x811c9dc5;
  for (let at = 0; at < repository.length; at += 1) hash = Math.imul(hash ^ repository.charCodeAt(at), 0x01000193);
  return `${sha}-${(hash >>> 0).toString(16).padStart(8, "0")}.json`;
}
// What a report says of its merge: "direct" for a change with no pull request, else its outcome.
const reportOutcome = (report) => (report.direct ? "direct" : report.outcome);

// Herdr's terminal list and program table are checked whole too: a list holding one entry the view cannot read is
// refused, never filtered, so no card shows an agent read from it.
const isProgram = (program) => typeof program === "object" && program !== null && typeof program.name === "string"
  && (program.icon === null || typeof program.icon === "string") && typeof program.tint === "boolean";
const isTerminal = (terminal) => typeof terminal === "object" && terminal !== null && typeof terminal.address === "string"
  && isOptionalText(terminal.name) && isOptionalText(terminal.cwd)
  && (terminal.foreground === undefined || terminal.foreground === null
    || (typeof terminal.foreground === "object" && isOptionalText(terminal.foreground.cwd)))
  && (terminal.report === null || (typeof terminal.report === "object" && typeof terminal.report.state === "string"
    && AGENT_STATES.includes(terminal.report.state)))
  && isProgram(terminal.program) && typeof terminal.program.agent === "boolean";
const isTerminalList = (list) => Array.isArray(list) && list.every(isTerminal);
const isProgramList = (list) => Array.isArray(list) && list.every((program) => isProgram(program) && typeof program.key === "string");

// Whether a folder is a card's job worktree or inside it, after either platform's separator.
const inWorktree = (folder, worktree) => typeof folder === "string" && typeof worktree === "string"
  && (folder === worktree || folder.startsWith(`${worktree}/`) || folder.startsWith(`${worktree}\\`));
const urgency = (terminal) => AGENT_STATES.indexOf(terminal.report?.state ?? null);

// Each card's most urgent tied terminal, by `<repository>#<card>`, from readable boards and a checked terminal list. Only
// this computer's agents take part. A terminal ties to one card at most, by the first of two folder rules that holds,
// boards in cache order: its live folder in a card's job worktree; then its launch folder there.
function tieAgents(boards, list) {
  const ties = new Map();
  for (const terminal of list) {
    if (terminal.address.includes("/") || terminal.program.agent !== true) continue;
    const tied = (rule) => {
      for (const board of boards) {
        const card = rule(board);
        if (card !== undefined) return `${board.repository}#${card}`;
      }
      return undefined;
    };
    const key = tied((board) => board.cards.find((card) => inWorktree(terminal.foreground?.cwd, card.worktree))?.card)
      ?? tied((board) => board.cards.find((card) => inWorktree(terminal.cwd, card.worktree))?.card);
    if (key !== undefined && (!ties.has(key) || urgency(terminal) < urgency(ties.get(key)))) ties.set(key, terminal);
  }
  return ties;
}

// The program a card's claim names: Herdr's own from `programs` (null where Herdr's table was not read), else the
// runtime's name with no icon; null where the claim names no runtime. A program Herdr gives no name is named by the runtime.
function claimProgram(claim, programs) {
  if (typeof claim?.runtime !== "string" || claim.runtime.trim() === "") return null;
  const key = RUNTIME_PROGRAMS.get(claim.runtime);
  const program = programs?.find((entry) => entry.key === key);
  if (program === undefined) return { name: claim.runtime, icon: null };
  return typeof program.name === "string" && program.name.trim() !== "" ? program : { ...program, name: claim.runtime };
}

const UNKNOWN_AGENT = { name: "Agent unknown", icon: null };

// The program the newest claim of an item's card names, from the cache's boards; "Agent unknown" where the read gives none:
// the repository on more than one board, a board or card that cannot be read, or a claim naming no runtime.
function itemProgram(item, boards, programs) {
  const matches = boards.filter((entry) => isProject(entry) && entry.repository === item.repository);
  const card = matches.length === 1 && boardCause(matches[0]) === null ? matches[0].cards.find((entry) => String(entry.card) === String(item.card)) : undefined;
  return (card?.unread === undefined ? claimProgram(card?.claim, programs) : null) ?? UNKNOWN_AGENT;
}

// What lights a Floor card, as its kind line and role: its own lit kind, else its agent waiting on the owner; null where neither does. The tile and the row's count both read it, so a card
// counts once whatever lights it.
function floorLight(card, state) {
  if (LIT_KINDS.includes(card.waitsOn)) return { label: LABELS[card.waitsOn], role: KIND_ROLES[card.waitsOn] };
  return state === "blocked" ? { label: AGENT_WAITING, role: "blocked" } : null;
}

// A card's blockers as one line, or null where it has none.
const blockedNote = (card) => (card.blockers.length > 0 ? `Blocked: waits for ${card.blockers.join(", ")}` : null);

// A board card with its stage and the agent that holds it: a card in an agent's stage shows the agent a terminal ties to
// it, else the one its claim names, never a claim the read did not give. `ctx` holds the ties and programs.
function stagedCard(board, card, { ties, programs }) {
  const stage = floorStage(card);
  if (!AGENT_STAGES.includes(stage)) return { card, stage, agent: undefined, program: null, light: floorLight(card, null) };
  const agent = ties?.get(`${board.repository}#${card.card}`);
  const program = agent ? agent.program : card.unread === undefined ? claimProgram(card.claim, programs) : null;
  return { card, stage, agent, program, light: floorLight(card, agent?.report?.state) };
}

// Herdr's icon for a program at `size`: a one-colour glyph in `colour` or a picture.
const programIcon = (program, colour, size) => (program.tint ? svg(program.icon).size(size).text_color(colour) : image(program.icon).w(size).h(size)).flex_none();

// An agent's name as the 11 word in its line's colour.
const agentWord = (program, colour) => div().text_size(11).text_color(colour).child(program.name);

// An agent's mark on a tile: its icon at `size`, named for a screen reader; a program with no icon is its name as a word.
function agentMark(program, colour, size) {
  if (!program.icon) return agentWord(program, colour);
  return div().flex_none().accessibility_label(program.name).child(programIcon(program, colour, size));
}

// An agent's mark on a card: its icon at `size` with its name as a word after it; a program with no icon is the word alone.
function agentNamedMark(program, colour, size) {
  if (!program.icon) return agentWord(program, colour);
  return h_flex().items_center().gap(4).child(programIcon(program, colour, size)).child(agentWord(program, colour));
}

// Why a project's Floor row or Board cannot draw its cards, or null where it can.
function boardCause(board) {
  if (typeof board.unreadable === "string") return `Board unreadable: ${board.unreadable}`;
  const readable = board.unreadable === undefined && Array.isArray(board.cards) && board.cards.every(isFloorCard)
    && new Set(board.cards.map((card) => String(card.card))).size === board.cards.length
    && (board.orderUnread === undefined || typeof board.orderUnread === "string")
    && (board.waitsOnUnread === undefined || (Array.isArray(board.waitsOnUnread) && board.waitsOnUnread.every((part) => typeof part === "string")))
    && (board.merged === undefined || board.merged === null || Array.isArray(board.merged))
    && (board.moves === undefined || typeof board.moves === "boolean")
    && (board.places === undefined || typeof board.places === "boolean");
  return readable ? null : UNREADABLE_ENTRY;
}

// Why the Board's build order cannot be trusted, or null where it can: the cache's own word, else each column's cards,
// null column included, must carry 1, 2, 3 and on in the order the cache lists them.
function orderCause(board) {
  if (typeof board.orderUnread === "string") return board.orderUnread;
  const placed = new Map();
  for (const card of board.cards) {
    const place = (placed.get(card.column) ?? 0) + 1;
    if (card.order !== place) return ORDER_MALFORMED;
    placed.set(card.column, place);
  }
  return null;
}

// When the cache says its read began, as milliseconds, or null where it gives no such time or one later than now.
function readStart(cache) {
  const began = typeof cache.readStartedAt === "string" ? Date.parse(cache.readStartedAt) : NaN;
  return began <= Date.now() ? began : null;
}

// A row's count line: its lit tiles, each card once. Where a card's wait was not read the count is a floor, and a floor
// of none is no line, since that card may need the owner.
function countLine(t, lit, unsure) {
  if (unsure) return lit > 0 ? [div().child(`At least ${lit} need you`)] : [];
  return [lit > 0 ? div().child(`${lit} need you`) : mutedLine(t, "Nothing for you")];
}

// A tile, lit in `role` with a fill of it or plain on `raised`; its tooltip holds what its capped title can hide. Every
// tile is a button: a card's opens the card's side sheet and a merged tile its merge's, which Esc closes.
function floorTile(t, element, tooltip, role) {
  return element.tooltip(tooltip).flex_none().gap(4).px(9).py(7).rounded(8).border_1()
    .border_color(role ?? t.border).bg(role ? role + TILE_ALPHA : t.raised);
}

// Three 17 px lines at most: the kit has no line clamp, so the rest is cut with no ellipsis.
const tileTitle = (text) => div().text_size(12.5).line_height("17px").max_h(51).overflow_hidden().child(text);

// A card's tile: its kind line where it is lit, its agent's mark before its ref, its title, and the state line of its
// tied agent, none where the kind line already says the agent waits. While the sheet is open, `tiles.inert` keeps every
// tile from a press and from Tab; the opening tile keeps the handle focus goes back to.
function cardTile(t, repository, { card, stage, agent, program, light }, tiles) {
  const role = light ? t[light.role] : null;
  const ref = floorRef(card.card);
  const title = floorTitle(card.title);
  const blocked = blockedNote(card);
  const quiet = role ? t.foreground : t.muted;
  const state = agent?.report?.state ?? null;
  const tooltip = blocked ? `${ref} ${title}. ${blocked}` : `${ref} ${title}`;
  const returned = tiles.focus(repository, card.card);
  return floorTile(t, Button.new(`${FLOOR_ID}${repository}#${card.card}`).flex().flex_col(), tooltip, role)
    .accessibility_label(light ? `${light.label}, ${tooltip}` : tooltip).tab_stop(!tiles.inert)
    .when(!tiles.inert, (el) => el.cursor_pointer().on_click(tiles.open(repository, card.card)))
    .when(returned !== null, (el) => el.track_focus(returned))
    .focus((s) => s.border_color(t.foreground))
    .when(Boolean(light), (el) => el.child(div().text_size(11).font_semibold().child(light.label)))
    .child(h_flex().items_center().gap(4).when(Boolean(program), (el) => el.child(agentMark(program, quiet, 13)))
      .child(div().text_size(11).text_color(quiet).child(ref)))
    .child(tileTitle(title))
    .when(stage === "building" && card.column === "In review", (el) => el.child(div().text_size(11).text_color(quiet).child("Merging")))
    .when(Boolean(agent) && light?.label !== AGENT_WAITING, (el) => el.child(h_flex().items_center().gap(4).text_size(11).text_color(quiet)
      .when(state === "working", (line) => line.child(svg(SPINNER).size(12).flex_none().text_color(t.working).spin(900)))
      .child(AGENT_LINES.get(state))))
    .when(Boolean(blocked), (el) => el.child(div().text_size(11).text_color(quiet).border_l(2).border_color(t.idle).pl(6).child(blocked)));
}

// Why a board's merge list cannot be drawn, or null where it can.
function mergesCause(merged) {
  if (merged === undefined) return "Merges not in this read";
  if (merged === null) return "Merges not read";
  return merged.every(isMerge) ? null : "Merges unreadable: an entry is not one this view can read";
}

// A project's Merged today cell: its merges dated today, each a tile that opens its merge's sheet, or why it cannot say.
// A read from another day cannot.
function mergedToday(t, repository, merged, readToday, tiles) {
  const cause = mergesCause(merged) ?? (readToday ? null : "Not read today");
  if (cause !== null) return [problemLine(t, cause)];
  return merged.filter((merge) => isToday(merge.at)).map((merge) => {
    const time = clock(merge.at);
    const tooltip = `${time} ${merge.subject}`;
    const opener = tiles.opener(`${FLOOR_ID}${repository}@${merge.sha}`, { repository, sha: merge.sha, at: merge.at });
    return floorTile(t, opener.flex().flex_col(), tooltip, null).accessibility_label(tooltip)
      .focus((s) => s.border_color(t.foreground))
      .child(mergeRow(t, isUnseen(repository, merge.sha), div().text_size(11).text_color(t.muted).child(time)))
      .child(tileTitle(merge.subject));
  });
}

// A project's row. Its first cell holds the name, the Coordinator line where the Coordinator waits on the owner or its
// state was not read, the count line, then a line for each part of the board the read could not give; a board the view cannot read
// is one cell naming why, never an empty row. `ties` is null where Herdr's terminal list was not read, and `programs`
// where its program table was not; `tiles` is what a card's tile, a merged tile and the project's Open board control do
// while the sheet is open or shut.
function floorRow(t, board, index, readToday, { ties, programs, tiles }) {
  const rowId = `${FLOOR_ID}row-${index}`;
  const cell = (column) => TableCell.new(`${rowId}-${column}`, column);
  const stageCell = (column) => cell(column).flex_1().flex_basis(0).min_w(0).flex().flex_col().gap(6).px(6).py(10).text_size(12)
    .border_l(1).border_color(t.border);
  const name = folderName(board.repository);
  const coordinator = coordinatorStatus(board);
  const project = (lines) => cell(1).flex_none().w(PROJECT_WIDTH).min_w(0).flex().flex_col().gap(6).px(6).py(10).text_size(12)
    .child(div().min_w(0).truncate().text_size(14).font_semibold().tooltip(name).child(name))
    .when(Boolean(coordinator.unread || coordinator.blocked), (el) => el.child(coordinatorLine(t, coordinator)))
    .children(lines)
    .child(h_flex().child(controlButton(t, `${FLOOR_ID}open-${index}`, "Open board", tiles.openBoard(board.repository), tiles.inert)
      .accessibility_label(`Open the ${name} board`)));
  const row = TableRow.new(rowId, index + 2).flex().flex_row().w_full().border_b(1).border_color(t.border);
  const cause = boardCause(board);
  if (cause) return row.child(project([])).child(stageCell(2).child(problemLine(t, cause)));
  const { cards, orderUnread } = board;
  const waitsUnread = board.waitsOnUnread ?? [];
  const staged = cards.map((card) => stagedCard(board, card, { ties, programs }));
  const lit = staged.filter(({ stage, light }) => stage !== null && light !== null).length;
  const details = cards.filter((card) => card.unread !== undefined).map((card) => floorRef(card.card));
  const worktreeUnread = cards.some((card) => card.worktree === undefined);
  const agentsUnread = (ties === null || worktreeUnread) && staged.some(({ stage }) => AGENT_STAGES.includes(stage));
  return row
    .child(project([
      ...countLine(t, lit, details.length > 0 || waitsUnread.length > 0 || agentsUnread),
      ...(orderUnread === undefined ? [] : [problemLine(t, `Order not read: ${orderUnread}`)]),
      ...(waitsUnread.length === 0 ? [] : [problemLine(t, `What cards wait on not read: ${waitsUnread.join(", ")}`)]),
      ...(details.length === 0 ? [] : [problemLine(t, `Details not read: cards ${details.join(", ")}`)]),
      ...(worktreeUnread ? [problemLine(t, `Agents in job worktrees not matched to cards: ${waitsUnread.includes("worktrees")
        ? "the worktree list was not read" : "its queue reader's release predates worktree reading"}`)] : []),
      ...staged.filter(({ card, stage }) => stage === null && card.column !== null && card.column !== "Backlog")
        .map(({ card }) => problemLine(t, `Card ${floorRef(card.card)} is in ${card.column}, which has no stage here`)),
    ]))
    .children(STAGES.map(({ id }, position) => stageCell(position + 2).children(id === "merged"
      ? mergedToday(t, board.repository, board.merged, readToday, tiles)
      : staged.filter(({ stage }) => stage === id).map((entry) => cardTile(t, board.repository, entry, tiles)))));
}

// The grid: it fits the pane's width, since the kit has no sticky column, and only its body scrolls, under a fixed
// header naming each stage.
function floorTable(t, projects, readToday, agents) {
  const heads = STAGES.map(({ label, role }, position) => TableHead.new(`${FLOOR_ID}head-${position + 2}`, position + 2)
    .flex_1().flex_basis(0).min_w(0).flex().flex_row().items_center().gap(7).px(6).py(9).text_size(12.5).font_semibold()
    .border_b(2).border_color(t[role])
    .child(div().flex_none().size(7).rounded(4).bg(t[role]))
    .child(div().min_w(0).child(label)));
  return Table.new(`${FLOOR_ID}grid`).accessibility_label("Floor").row_count(projects.length + 1).column_count(STAGES.length + 1)
    .flex().flex_col().flex_1().min_h(0).w_full()
    .child(TableHeader.new(`${FLOOR_ID}header`).flex_none()
      .child(TableRow.new(`${FLOOR_ID}head`, 1).flex().flex_row().w_full()
        .child(TableHead.new(`${FLOOR_ID}head-1`, 1).flex_none().w(PROJECT_WIDTH).border_b(1).border_color(t.border).accessibility_label("Project"))
        .children(heads)))
    .child(v_flex().id(`${FLOOR_ID}list`).flex_1().min_h(0).overflow_y_scrollbar()
      .child(TableBody.new(`${FLOOR_ID}body`).flex().flex_col().w_full()
        .children(projects.map((board, index) => floorRow(t, board, index, readToday, agents)))));
}

// The Board column a card is drawn in, or null where it has none: a proposed card is in Backlog whatever its column, as
// is a card with no column.
const boardColumn = (card) => (card.title.startsWith(PROPOSED) ? "backlog" : BOARD_PLACES.get(card.column) ?? null);

// The lines above the Board's columns.
const boardNotes = (lines) => v_flex().flex_none().px(16).pt(12).gap(8).children(lines);

// The moves a Board card offers: Move to Ready on a Backlog card or one with no column, which the Board draws in Backlog,
// and on a Ready one Back to Backlog and, from rank 2, Move up. A proposal, a card whose details were not read, one with no version and any card on a board that takes no
// moves have none; a build order that is not read (`ordered` false, `rank` null) withholds Move to Ready and Move up.
function cardMoves(board, card, rank, ordered) {
  if (board.moves !== true || card.version === undefined || card.unread !== undefined || card.title.startsWith(PROPOSED)) return [];
  const number = card.card;
  if (card.column === "Backlog" || card.column === null) {
    return ordered ? [{ move: "ready", label: "Move to Ready", name: `Move card ${number} to Ready`, done: "Moved to Ready" }] : [];
  }
  if (card.column !== "Ready") return [];
  return [
    { move: "backlog", label: "Back to Backlog", name: `Move card ${number} back to Backlog`, done: "Moved back to Backlog" },
    ...(rank > 1 ? [{ move: "up", label: "Move up", name: `Move card ${number} up to place ${rank - 1}`, done: "Moved up" }] : []),
  ];
}

// The Board write a move runs, from its control or a drop: `queue.mjs move` with the card's key, the move, the version
// drawn and, for a place move, the place.
const moveWrite = (key, card, move) => ({
  args: ["move", key, move.move, card.version, ...(move.to === undefined ? [] : [String(move.to)])], label: move.label, done: move.done,
});

// Where a dragged card would land, or null where a release runs nothing: `{ column, before, move }`, `before` being the
// Ready to build place it would go before, `count + 1` for last, and absent on Backlog. The column is the one the pointer
// is inside; a Backlog card lands last in Ready to build and a Ready one in Backlog, each by its own control's move, and a
// Ready one within Ready to build, where `places` holds, before or after the card nearest the pointer, read within one
// list gap of that card's edges, else last. A drop at its own place lands nowhere.
function dragTarget({ from, rank, count, moves, places, pointer, over, near }) {
  if (over === null) return null;
  const { x, y, width, height } = over.bounds;
  if (pointer.x < x || pointer.x > x + width || pointer.y < y || pointer.y > y + height) return null;
  if (from === "backlog" && over.column === "ready") {
    const move = moves.find((each) => each.move === "ready");
    return move === undefined ? null : { column: "ready", before: count + 1, move };
  }
  if (from === "ready" && over.column === "backlog") {
    const move = moves.find((each) => each.move === "backlog");
    return move === undefined ? null : { column: "backlog", move };
  }
  if (from !== "ready" || over.column !== "ready" || !places) return null;
  const banded = near !== null && pointer.y >= near.bounds.y - BOARD_LIST_GAP && pointer.y <= near.bounds.y + near.bounds.height + BOARD_LIST_GAP;
  const before = !banded ? count + 1 : pointer.y < near.bounds.y + near.bounds.height / 2 ? near.rank : near.rank + 1;
  if (before === rank || before === rank + 1) return null;
  const to = before < rank ? before : before - 1;
  return { column: "ready", before, move: { move: "place", to, label: `Move to place ${to}`, done: `Moved to place ${to}` } };
}

// Whether a card offers Show me first: on a board that takes moves, a card the Board draws in Ready to build or In
// progress, a proposal never, whose read gives its marker. A marker not read is then a line in the switch's place.
const offersShowFirst = (board, card) => board.moves === true && card.showFirst !== undefined
  && /** @type {(string | null)[]} */ (["ready", "progress"]).includes(boardColumn(card));

// A Board column: its header, its note, its notice, then its entries, which scroll, or the line saying it has none.
// `count` is a number or its text, or null where the column cannot say how many it holds; `action` is a control that ends
// the header; the data's `empty` replaces the column's empty line, and null leaves it out. `drop`, on a column a card can
// be dragged to, is `{ marked, move, release }`: whether a dragged card would land in it, which draws its outline and its
// list's fill in `accent`, and the handlers that follow the pointer over it and take the release.
/**
 * @param {any} t
 * @param {{ id: string, label: string, role: string, note?: string, empty: string }} column
 * @param {any} entries
 * @param {{ marked: boolean, move: any, release: any } | null} [drop]
 */
function kanbanColumn(t, { id, label, role, note, empty: columnEmpty }, { count, list, notice, empty = columnEmpty, action = null }, drop = null) {
  return v_flex().id(`${BOARD_ID}column-${id}`).w(280).flex_none().min_h(0).rounded(10).bg(t.canvas).border_1().border_color(drop?.marked ? t.accent : t.border)
    .overflow_hidden()
    .when(drop !== null, (el) => el.on_mouse_move(drop?.move).on_mouse_up("left", drop?.release))
    .child(h_flex().flex_none().h(40).px(12).gap(8).items_center().border_b(2).border_color(t[role])
      .child(div().flex_none().size(8).rounded(4).bg(t[role]))
      .child(div().text_size(13.5).font_semibold().child(label))
      .when(count !== null, (el) => el.child(div().text_color(t.muted).child(String(count))))
      .when(action !== null, (el) => el.child(div().flex_1()).child(action)))
    .child(div().flex_none().h(8))
    .when(Boolean(note), (el) => el.child(mutedLine(t, note).flex_none().text_size(11.5).px(12).pb(8)))
    .when(Boolean(notice), (el) => el.child(notice.flex_none().text_size(11.5).px(12).pb(8)))
    .child(v_flex().id(`${BOARD_ID}list-${id}`).flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(8).gap(BOARD_LIST_GAP)
      .when(drop?.marked === true, (el) => el.bg(t.accent + DROP_ALPHA))
      .children(list.length === 0 && empty !== null ? [mutedLine(t, empty)] : list));
}

// A Ready card's place in the build order: rank 1 in `accent`, the others on `selected`.
const rankBadge = (t, rank) => div().flex_none().size(20).rounded(5).flex().items_center().justify_center().text_size(11.5).font_semibold()
  .bg(rank === 1 ? t.accent : t.selected).text_color(rank === 1 ? t.accent_foreground : t.foreground).child(String(rank));

// Opens `view` over the window in Herdr's one window overlay of this key, so a view opened while another shows takes its
// place there.
function openView(view, repository) {
  openOverlay({ mod: PANEL_MOD, props: { view, repository }, kind: "window", key: "fabraik-queue-view", width: 0.94, height: 0.9 });
}

/** @typedef {{ checking?: boolean, reading?: boolean, failure?: string, report?: any }} ReportState What a merge sheet's report read gave. */
/** @typedef {any} Handle A focus handle, task or other object Herdr's kit hands the panel, which ships no declarations. */
/** @typedef {{ key: string, board: any, card: any, from: string | null, rank: any, count: number, moves: any, places: boolean, at: any, pointer: any,
 *   over: { column: any, bounds: any } | null, near: { rank: any, bounds: any } | null, target: any }} Drag The Board card being dragged. */

export default class Queue extends View {
  init(_props, cx) {
    this.home = appHome();
    const view = props()?.view;
    this.view = view === "decisions" || view === "floor" || view === "board" ? view : "panel";
    // The project the Board draws, as its props name it; anything but text names none.
    this.repository = props()?.repository;
    // The overlay this copy is drawn in, or null for the panel in its place in the layout.
    this.overlay = props()?.overlay ?? null;
    /** @type {{ kind: string, cache?: any, error?: string }} */
    this.state = { kind: "loading" };
    this.refreshing = false;
    this.refreshAgain = false;
    this.clearing = false;
    this.refreshFailure = null;
    this.clearFailure = null;
    // Per item key: the button pressed while a command runs, and the line saying why the last press was refused.
    /** @type {Map<string, string>} */
    this.running = new Map();
    /** @type {Map<string, string>} */
    this.failures = new Map();
    /** @type {Map<string, { text: string, pending?: boolean, problem?: boolean }>} */
    this.coordinatorOpens = new Map();
    // `<key>@<version>` to the receipt of an item the owner handled, and whether only this panel knows it (so Undo).
    /** @type {Map<string, any>} */
    this.marks = new Map();
    // `<key>@<version>` to the local date the owner handled the item: the Decisions view's count of the day, kept after
    // the read confirms the item so the count never falls back.
    /** @type {Map<string, string>} */
    this.handled = new Map();
    // One InputState per merge answer box and answerable question, by `<key>@<version>`; the draft keys whose input
    // holds the keyboard; and the questions whose draft a changed version cleared.
    /** @type {Map<string, Handle>} */
    this.drafts = new Map();
    /** @type {Set<string>} */
    this.typing = new Set();
    /** @type {Set<string>} */
    this.replaced = new Set();
    // The labels picked for each question of a waiting menu that takes several, by draft key; and the asks whose answer this
    // panel sent, which read as sent at once, before the next read.
    /** @type {Map<string, Set<string>>} */
    this.chosen = new Map();
    /** @type {Set<string>} */
    this.sent = new Set();
    // `<key>#<proposal>` of each retro proposal this panel made a card and no read has yet shown as one.
    /** @type {Set<string>} */
    this.picks = new Set();
    this.focusHandle = cx.focus_handle();
    // Herdr gives an opened window no keyboard, so an overlay copy takes it, for Esc.
    if (this.overlay !== null) this.focusHandle.focus();
    // Herdr moves focus on Tab by a binding no key handler hears; these, in the sheet's own deeper context, run first. A
    // reload binds them again, which changes nothing.
    cx.bind_keys([
      { keystroke: "tab", action: SHEET_NEXT, context: SHEET_CONTEXT },
      { keystroke: "shift-tab", action: SHEET_PREV, context: SHEET_CONTEXT },
    ]);
    // The side sheet: whether it is open, the card or merge that opened it (kept after close), the handle focus moves to
    // inside it, the handles its Close and its end stop track, and the handle the opening tile, line or Board control
    // tracks, made by each opening, and when the opening was.
    this.sheetOpen = false;
    /** @type {number | null} */
    this.sheetOpenedAt = null;
    this.opener = null;
    this.sheetFocus = null;
    this.sheetReturn = null;
    this.returnDrawn = false;
    this.sheetClose = null;
    this.sheetEnd = null;
    this.sheetEntering = false;
    // The width a merge report's screenshots are drawn at, as their column's last layout measured it; null until then.
    this.shotWidth = null;
    // A merge sheet's report: the count of report runs, so a reply to any but the latest is dropped, and what the latest
    // gave: `{ checking: true }` while it looks for the report the queue kept, `{ reading: true }` while the queue runs,
    // then `{ failure }`, the line saying why it failed, or `{ report }`, the document the queue kept or printed.
    /** @type {number} */
    this.reportRuns = 0;
    /** @type {ReportState | null} */
    this.report = null;
    // The queue's report runs going, by `<repository>@<sha>`, each a promise of `{ failure }` or `{ report }` that every
    // read of that merge joins, removed once it settles; and the outcome each merge's kept or read report gave, "direct"
    // or its outcome, kept while a board of the latest read lists the merge.
    /** @type {Map<string, Promise<any>>} */
    this.reading = new Map();
    /** @type {Map<string, string>} */
    this.outcomes = new Map();
    // The Board's background read of its merges' reports: whether a pass runs, and the read's `refreshedAt` the last pass
    // began on, and the sha of the merge whose run failed in the last pass, which the next pass reads last.
    this.mergesReading = false;
    this.mergesReadOn = null;
    this.mergeFailed = null;
    // The Board's writes, a move or a Show me first state: the one running (its card key and control label), the line each
    // card keeps for a refused write, the write whose success line shows (its card key, line, the time it ended and, for
    // Show me first, the state written), and the card title that holds the keyboard after a Board press with the handle
    // made for it.
    this.boardMove = null;
    /** @type {Map<string, string>} */
    this.boardFailures = new Map();
    /** @type {{ key: string, line: string, at: number, showFirst?: any } | null} */
    this.boardMoved = null;
    /** @type {{ key: string, handle: Handle } | null} */
    this.boardReturn = null;
    // The Board card being dragged, or null: `{ key, board, card, from, rank, count, moves, places, at, pointer, over, near,
    // target }`, `from` its column, `count` the cards in Ready to build, `places` whether it may take a place there, `at`
    // the press and `pointer` the latest position, `over` the column (`{ column, bounds }`) and `near` the Ready card
    // (`{ rank, bounds }`) the pointer was last over, and `target` where a release would land it.
    /** @type {Drag | null} */
    this.drag = null;
    // Whether the Merged column shows every merge, and the handle that keeps the keyboard on its Show all control.
    this.mergedExpanded = false;
    this.mergedMore = null;
    // The inbox's waiting menus: what the latest `queue.mjs menus` read printed (null before one lands or where it failed),
    // why the latest read or a watch failed, the blocked sessions the latest read was given (null before the first), whether
    // a read runs and whether a change during it asks for one more; and the watches it keeps, which `close` cancels.
    /** @type {{ items: any[], problems: any[] } | null} */
    this.menus = null;
    /** @type {string | null} */
    this.menusFailure = null;
    /** @type {string | null} */
    this.watchFailure = null;
    /** @type {string | null} */
    this.menusBlocked = null;
    this.menusReading = false;
    this.menusAgain = false;
    /** @type {Set<Handle>} */
    this.watches = new Set();
    this.closed = false;
    // The panel only loads the saved queue it finds, for its deliver menus; a view reads the tracker once as it opens, and at
    // each press of Refresh.
    cx.spawn(async (cx) => {
      await this.load();
      cx.notify();
      if (this.view !== "panel") this.refresh(cx);
    });
    if (this.view === "panel") {
      this.watchAsks(cx);
      this.watchCache(cx);
    }
  }

  async close() {
    this.closed = true;
    for (const watch of this.watches) watch.cancel();
  }

  // Reads the waiting menus with `queue.mjs menus` and Herdr's terminal list, noting the blocked sessions it was given. A read
  // asked for while one runs runs once that one ends, since that one may have begun before the change.
  readAsks(cx) {
    if (this.menusReading) {
      this.menusAgain = true;
      return;
    }
    this.menusReading = true;
    this.menusBlocked = blockedKey(inboxAgents().blocked);
    cx.spawn(async (cx) => {
      const { failure, stdout } = await this.run("menus", terminalList());
      const read = failure === null ? readMenusOutput(stdout) : { failure };
      this.menusFailure = read.failure ?? null;
      this.menus = read.menus ?? null;
      this.syncItems(this.menus?.items ?? []);
      this.menusReading = false;
      if (this.menusAgain) {
        this.menusAgain = false;
        this.readAsks(cx);
      }
      cx.notify();
    });
  }

  // Starts each watch, then reads, so no change is lost between them: the waiting menus at start-up and at each batch of
  // changes under the ask folder, an empty batch included, as where Herdr took the watch back. Where that folder cannot be
  // watched, as before any job has asked, the panel watches the Herdr data folder until a batch names it.
  watchAsks(cx) {
    const data = `${this.home}/data`;
    const asks = `${data}/fabraik-asks`;
    cx.spawn(async (cx) => {
      let folder = asks;
      for (let read = true; !this.closed;) {
        const watch = this.watch(folder);
        if (read) this.readAsks(cx);
        let batch;
        try {
          batch = await watch;
        } catch (error) {
          if (folder === data) {
            this.watchFailure = oneLine(/** @type {{ message?: string } | null} */ (error)?.message ?? error);
            cx.notify();
            return;
          }
          folder = data;
          read = false;
          continue;
        } finally {
          this.watches.delete(watch);
        }
        read = folder === asks || batch.some((path) => path === data || path === asks || path.startsWith(`${asks}/`));
        if (read) folder = asks;
      }
    });
  }

  // Loads the saved queue again at each batch of changes under its folder, so a read a view makes in an overlay reaches the
  // inbox's deliver menus. The next watch starts before each load, so a write during that load starts another.
  watchCache(cx) {
    cx.spawn(async (cx) => {
      let watch = this.watch(`${this.home}/fabraik-queue`);
      while (!this.closed) {
        try {
          await watch;
        } catch (error) {
          this.watchFailure = oneLine(/** @type {{ message?: string } | null} */ (error)?.message ?? error);
          cx.notify();
          return;
        } finally {
          this.watches.delete(watch);
        }
        if (this.closed) return;
        watch = this.watch(`${this.home}/fabraik-queue`);
        await this.load();
        cx.notify();
      }
    });
  }

  watch(folder) {
    const watch = watchFolder(folder);
    this.watches.add(watch);
    return watch;
  }

  // Run one queue.mjs command. Keep the code so the runtime picker can distinguish a concurrent open from failure.
  async run(...args) {
    try {
      const result = await exec("node", [`${this.home}/mods/fabraik-queue/queue.mjs`, ...args, "--home", this.home], EXEC_OPTIONS);
      return { code: result.code, failure: result.code === 0 ? null : oneLine(result.stderr || result.stdout) || `exit ${result.code}`, stdout: result.stdout };
    } catch (error) {
      return { code: null, failure: oneLine(/** @type {{ message?: string } | null} */ (error)?.message ?? error), stdout: "" };
    }
  }

  async load() {
    const today = localDate();
    for (const [key, date] of this.handled) if (date !== today) this.handled.delete(key);
    // Herdr's agent programs, which the Floor, the Decisions cards and the side sheet show for a card's claim: `{ list }`,
    // or `{ unread }` naming why not.
    if (this.view !== "panel") {
      this.programs = await knownAgents().then(
        (list) => (isProgramList(list) ? { list } : { unread: "it is not a program list" }),
        (error) => ({ unread: oneLine(/** @type {{ message?: string } | null} */ (error)?.message ?? error) }),
      );
    }
    try {
      const text = await readTextFile(`${this.home}/fabraik-queue/queue.json`);
      if (text === null) { this.state = { kind: "absent" }; return; }
      const cache = JSON.parse(text);
      if (cache?.format !== CACHE_FORMAT || !Array.isArray(cache.problems) || !Array.isArray(cache.items)
        || !Array.isArray(cache.digestUnread) || !cache.digestUnread.every((path) => typeof path === "string")
        || Number.isNaN(Date.parse(cache.refreshedAt))
        || (cache.fetchedAt !== null && (typeof cache.fetchedAt !== "string" || Number.isNaN(Date.parse(cache.fetchedAt))))) {
        throw new Error(`it is not a format ${CACHE_FORMAT} queue cache`);
      }
      if (!cache.items.every((item) => CATEGORIES.includes(item?.category))) throw new Error("an entry has no known category");
      if (!cache.items.every((item) => !TIERS.includes(item.category) || typeof item.repository === "string")) {
        throw new Error("an entry is not one this view can read");
      }
      const before = this.state.kind === "read" ? this.state.cache.items : [];
      if (this.view !== "panel") this.syncItems(cache.items);
      const listed = new Set((Array.isArray(cache.boards) ? cache.boards : []).filter(isProject)
        .flatMap((board) => (Array.isArray(board.merged) ? board.merged.map((merge) => `${board.repository}@${merge?.sha}`) : [])));
      for (const key of this.outcomes.keys()) if (!listed.has(key)) this.outcomes.delete(key);
      this.state = { kind: "read", cache };
      // A Board write's line stays until a read begun at or after the write's end lands.
      const began = readStart(cache);
      if (this.boardMoved !== null && began !== null && began >= this.boardMoved.at) this.boardMoved = null;
      if (this.sheetOpen && this.opener.sha === undefined && !sameKeys(this.sheetKeys(before), this.sheetKeys(cache.items))) {
        this.takeKeyboardInSheet();
      }
    } catch (error) {
      this.state = { kind: "unreadable", error: oneLine(/** @type {{ message?: string } | null} */ (error)?.message ?? error) };
    }
  }

  // The items the view answers changed: the inbox's waiting menus, or another view's cache items. The read confirms a handled
  // item by dropping it or changing its version; the mark has done its work then.
  syncItems(items) {
    this.syncDrafts(items);
    const held = new Set(items.map(versioned));
    for (const key of this.marks.keys()) if (!held.has(key)) this.marks.delete(key);
  }

  // A draft whose key left the items is dropped; an answerable question that came back at another version starts a
  // new draft and says the old one was cleared. A made retro proposal the read shows as a card, or no longer shows, is
  // forgotten.
  syncDrafts(items) {
    const wanted = new Map(items.flatMap((item) => draftKeys(item).map((key, index) => [key, [item, index]])));
    const stale = [...this.drafts.keys()].filter((key) => !wanted.has(key));
    for (const [key, [item, index]] of wanted) {
      if (this.drafts.has(key)) continue;
      if (item.category === "question" && stale.some((old) => old.startsWith(`${item.key}@`))) this.replaced.add(item.key);
      this.drafts.set(key, this.newDraft(item, key, index));
    }
    for (const key of stale) {
      this.drafts.get(key).release();
      this.drafts.delete(key);
      this.chosen.delete(key);
      this.typing.delete(key);
    }
    for (const id of this.sent) if (!items.some((item) => item.askId === id)) this.sent.delete(id);
    for (const key of this.replaced) if (!items.some((item) => item.key === key)) this.replaced.delete(key);
    const unmade = new Set(items.flatMap((item) => (item.proposals ?? []).filter((draft) => draft.card === undefined).map((draft) => `${item.key}#${draft.n}`)));
    for (const pick of this.picks) if (!unmade.has(pick)) this.picks.delete(pick);
  }

  newDraft(item, key, index) {
    const menu = item.category === "menu";
    const placeholder = menu ? MENU_PLACEHOLDER : item.category === "merge" ? "Your answer: yes, what to change, or no" : `Your answer for ${folderName(item.repository)}`;
    const state = InputState.new({ placeholder });
    // Typing into a single-select question's box takes its picked choice back: it takes one choice or a text, never both.
    state.on("change", (_event, cx) => {
      this.replaced.delete(item.key);
      if (menu && !menuForm(item)[index].multiSelect && state.value().trim() !== "") this.chosen.delete(key);
      cx.notify();
    });
    state.on("submit", (_event, cx) => (menu ? this.sendMenu(item, this.menuEntries(item), isSimple(item) ? SEND_LABEL : MENU_SEND_ALL, cx) : this.send(item, cx)));
    state.on("focus", () => this.typing.add(key));
    state.on("blur", () => this.typing.delete(key));
    return state;
  }

  // A refresh that starts while one runs is skipped; a failed one keeps the queue last read beside its line. A sheet that
  // opens while a refresh runs asks for one more, since that one began before the opening. A failed one also takes down a
  // Board write's success line, since no later read is coming to confirm it.
  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      this.refreshFailure = (await this.run("refresh", terminalList())).failure;
      if (this.refreshFailure !== null) this.boardMoved = null;
      await this.load();
      this.readMerges(cx);
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.refresh(cx);
      }
      cx.notify();
    });
  }

  clear(cx) {
    if (this.clearing) return;
    this.clearing = true;
    cx.spawn(async (cx) => {
      this.clearFailure = (await this.run("clear-digest")).failure;
      await this.load();
      this.clearing = false;
      cx.notify();
    });
  }

  // Runs one queue.mjs command for an item: its pressed button reads "Working" and its other controls are off until
  // the command ends. A refusal leaves the item open with one line naming the button; a success leaves `receipt`
  // and starts no refresh, since the next read confirms it; a made retro proposal instead keeps its
  // item open, its control giving way to the line saying so, and starts the refresh that reads the card it became; a sent
  // waiting menu answer reads the waiting menus again in the inbox and refreshes in a view; a written put-aside, accept or reject keeps
  // the record the queue printed, which its Undo hands back, and an undo that succeeds takes the receipt away. The panel hands
  // queue.mjs the item's key and never a path.
  press(item, label, args, receipt, cx) {
    if (this.running.has(item.key)) return;
    const [command, , action] = args;
    this.running.set(item.key, label);
    this.failures.delete(item.key);
    this.keepFocusInSheet(item);
    cx.notify();
    cx.spawn(async (cx) => {
      const { failure, stdout } = await this.run(...args);
      this.running.delete(item.key);
      if (failure !== null) this.failures.set(item.key, `${label} failed: ${failure}`);
      else if (command === "undo") this.unmark(item, cx);
      else if (command === "answer-menu") {
        this.sent.add(item.askId);
        if (this.view === "panel") this.readAsks(cx);
        else if (this.refreshing) this.refreshAgain = true;
        else this.refresh(cx);
      } else if (action === "pick") {
        this.picks.add(`${item.key}#${args[4]}`);
        if (this.refreshing) this.refreshAgain = true;
        else this.refresh(cx);
      } else if (receipt) this.mark(item, receipt, false, cx, { action, record: UNDOABLE.includes(action) ? stdout.trim() : "" });
      cx.notify();
    });
  }

  // A written receipt also holds its action and the record that action's Undo hands back, "" where the queue printed none.
  mark(item, receipt, local, cx, written = {}) {
    this.marks.set(versioned(item), { receipt, local, ...written });
    this.handled.set(versioned(item), localDate());
    this.failures.delete(item.key);
    this.keepFocusInSheet(item);
    cx.notify();
  }

  unmark(item, cx) {
    this.marks.delete(versioned(item));
    this.handled.delete(versioned(item));
    this.keepFocusInSheet(item);
    cx.notify();
  }

  // Takes the keyboard to the Board title tracking `key`, which keeps it through the redraw that follows.
  holdBoardFocus(key, cx) {
    this.boardReturn?.handle.release();
    this.boardReturn = { key, handle: cx.focus_handle() };
    this.boardReturn.handle.focus();
  }

  // Runs one Board write for a card, the queue.mjs command `args`: a move at the version the panel drew, or a Show me first
  // state, which also carries `showFirst`, the state written. The pressed control reads "Working" and every Board move
  // control and switch is off until the write ends and, on success, until a read begun after it lands. A refusal leaves
  // one line naming the control on its card. The keyboard goes to the card's title, which keeps it through the refresh
  // that follows every press, or, for a press in the side sheet, stays in the sheet; a press while a refresh runs asks for
  // one more, since that one began before the write ended.
  /**
   * @param {any} board
   * @param {any} card
   * @param {{ args: any[], label: string, done: string, showFirst?: any }} write
   * @param {any} cx
   * @param {boolean} [fromSheet]
   */
  writeCard(board, card, { args, label, done, showFirst }, cx, fromSheet = false) {
    if (this.boardMove !== null || this.boardMoved !== null) return;
    const key = `${board.repository}#${card.card}`;
    this.boardMove = { key, label };
    this.boardFailures.delete(key);
    if (fromSheet) this.takeKeyboardInSheet();
    else this.holdBoardFocus(key, cx);
    cx.notify();
    cx.spawn(async (cx) => {
      const { failure } = await this.run(...args);
      this.boardMove = null;
      if (failure === null) this.boardMoved = { key, line: `${done}${MOVE_CONFIRMS}`, at: Date.now(), showFirst };
      else this.boardFailures.set(key, `${label} failed: ${failure}`);
      if (this.refreshing) this.refreshAgain = true;
      else this.refresh(cx);
      cx.notify();
    });
  }

  // Takes hold of a Board card at a press, and gives the keyboard to the Board, whose Esc then ends the drag. Each
  // handler below records only what it saw and the pointer, so the target after one pointer event is the same whatever
  // order the card's, the column's and the Board's handlers run in.
  holdCard(board, card, rank, moves, event, cx) {
    this.drag = {
      key: `${board.repository}#${card.card}`, board, card, from: boardColumn(card), rank,
      count: board.cards.filter((each) => boardColumn(each) === "ready").length, moves, places: rank !== null && board.places === true,
      at: event.position, pointer: event.position, over: null, near: null, target: null,
    };
    this.focusHandle.focus();
    cx.notify();
  }

  dragOver(column, event, cx) {
    if (this.drag === null) return;
    this.drag.over = { column, bounds: event.bounds };
    this.drag.pointer = event.position;
    this.showDrag(cx);
  }

  dragNear(rank, event, cx) {
    if (this.drag === null) return;
    this.drag.near = { rank, bounds: event.bounds };
    this.drag.pointer = event.position;
    this.showDrag(cx);
  }

  dragPointer(event, cx) {
    if (this.drag === null) return;
    this.drag.pointer = event.position;
    this.showDrag(cx);
  }

  // Redraws only when where the card would land has changed.
  showDrag(cx) {
    const drag = /** @type {Drag} */ (this.drag);
    const target = dragTarget(drag);
    if (target?.column === drag.target?.column && target?.before === drag.target?.before) return;
    drag.target = target;
    cx.notify();
  }

  // A release over `column` ends the drag and runs the move it would land by, where it lands in that column.
  dropCard(column, cx) {
    if (this.drag === null) return;
    const { key, board, card, target } = this.drag;
    this.endDrag(cx);
    if (target?.column === column) this.writeCard(board, card, moveWrite(key, card, target.move), cx);
  }

  endDrag(cx) {
    if (this.drag === null) return;
    this.drag = null;
    cx.notify();
  }

  // A press on a card's control is that control's and never a drag: it stops there and ends any drag in progress.
  controlPress(cx) {
    cx.stop_propagation();
    this.endDrag(cx);
  }

  // A press that reaches a view's root: an overlay stops it there, since Herdr drags the window by any press that reaches
  // it, and on the Board a press other than the one that began a drag ends that drag.
  rootPress(event, cx) {
    if (this.overlay !== null) cx.stop_propagation();
    if (this.drag !== null && (event.position.x !== this.drag.at.x || event.position.y !== this.drag.at.y)) this.endDrag(cx);
  }

  // Opens the side sheet of `opener`, a card (`{ repository, card }`) or a merge (`{ repository, sha, at }`), and moves
  // focus into it. A card's sheet reads every project again; a merge's reads only that merge's report. Each opening makes
  // its own handle for focus to go back to; `from` names the control that opened it, since a Board card has several.
  openSheet(opener, cx, from = null) {
    this.sheetFocus ??= cx.focus_handle();
    this.sheetClose ??= cx.focus_handle();
    this.sheetEnd ??= cx.focus_handle();
    this.sheetReturn?.release();
    this.sheetReturn = cx.focus_handle();
    this.returnDrawn = true;
    this.boardReturn?.handle.release();
    this.boardReturn = null;
    this.opener = { ...opener, from };
    this.sheetOpen = true;
    this.sheetEntering = true;
    this.sheetOpenedAt = Date.now();
    if (opener.sha !== undefined) this.readReport(cx);
    else if (this.refreshing) this.refreshAgain = true;
    else this.refresh(cx);
    this.sheetFocus.focus();
    cx.notify();
    const opening = this.sheetReturn;
    cx.spawn(async (cx) => {
      await cx.sleep(SLIDE_WAIT_MS);
      if (this.sheetReturn !== opening) return;
      this.sheetEntering = false;
      cx.notify();
    });
  }

  // The opening card's board and card in the latest read (card undefined where the board lists no open card of that
  // number), or the cause why the read cannot show it.
  openerCard() {
    const state = this.state;
    if (state.kind === "unreadable") return { cause: `Card not shown: the queue cache is unreadable: ${state.error}` };
    if (state.kind !== "read") return { cause: "Card not shown: no queue read yet" };
    const { boards } = state.cache;
    if (!Array.isArray(boards)) return { cause: "Card not shown: this read has no boards this view can read" };
    const { repository, card } = this.opener;
    const board = boards.find((found) => found?.repository === repository);
    if (board === undefined) return { cause: `Card not shown: this read has no board for ${folderName(repository)}` };
    const cause = boardCause(board);
    if (cause !== null) return { cause };
    return { board, card: board.cards.find((found) => found.card === card) };
  }

  // Closes the sheet at once and gives focus back to the control that opened it, or to the view where its card is no
  // longer drawn, the last render drew no merge control that opened it, or the Board no longer draws the control, a Needs
  // you entry that has become a receipt.
  closeSheet(cx) {
    this.sheetOpen = false;
    this.reportRuns += 1;
    let drawn = this.returnDrawn;
    if (this.opener.sha === undefined) {
      const { card } = this.openerCard();
      drawn = card !== undefined && (this.view === "board" ? boardColumn(card) !== null && this.returnDrawn : floorStage(card) !== null);
    }
    (drawn ? this.sheetReturn : this.focusHandle).focus();
    cx.notify();
  }

  // A control that opens the side sheet of `opener`, a card or a merge: inert while the sheet is open, and the one that
  // opened it keeps the handle focus goes back to, which the render records as drawn.
  sheetOpener(id, opener) {
    const inert = this.sheetOpen;
    const opened = this.opener?.from === id;
    if (opened) this.returnDrawn = true;
    return Button.new(id).tab_stop(!inert)
      .when(!inert, (el) => el.cursor_pointer().on_click((_event, cx) => this.openSheet(opener, cx, id)))
      .when(opened, (el) => el.track_focus(this.sheetReturn));
  }

  // The report the queue kept for the repository's merge `sha`, noting its outcome, or null where the sha is none the
  // queue reads, or the kept file is missing, unreadable or not that merge's report in a form this panel reads.
  async keptReport(repository, sha) {
    if (!MERGE_SHA.test(sha)) return null;
    let kept;
    try {
      const text = await readTextFile(`${this.home}/fabraik-queue/reports/${keptReportName(repository, sha)}`);
      if (text === null) return null;
      kept = JSON.parse(text);
    } catch {
      return null;
    }
    if (kept?.format !== 1 || kept.key !== `${repository}@${sha}` || !isReport(kept.report) || kept.report.sha !== sha) return null;
    this.outcomes.set(kept.key, reportOutcome(kept.report));
    return kept.report;
  }

  // Runs the queue's report of the repository's merge `sha`, or joins the run of it already going, and notes the
  // outcome of a report it reads unless that report is unread for a passing reason, which the queue keeps no file of and
  // a later read may change; resolves to `{ failure }` or `{ report }`.
  runReport(repository, sha) {
    const key = `${repository}@${sha}`;
    if (!this.reading.has(key)) {
      this.reading.set(key, this.run("report", key).then(({ failure, stdout }) => {
        this.reading.delete(key);
        const read = failure === null ? readReportOutput(stdout) : { failure };
        if (read.report !== undefined && !(read.report.outcome === "unread" && read.report.lasting !== true)) {
          this.outcomes.set(key, reportOutcome(read.report));
        }
        return read;
      }));
    }
    return this.reading.get(key);
  }

  // On the Board, reads the reports of the merges its project's board lists, one at a time, skipping a merge already
  // noted: the kept report, else the queue's run of it, which an opening joins. A pass starts on a read whose
  // `refreshedAt` the last pass did not begin on, while none runs. It walks the list from just after the merge whose run
  // failed in the last pass, wrapping round so that merge comes last, or in the list's order with none. It looks at every
  // kept report but starts no run once one has failed, so an exhausted allowance costs one refused run per pass and a
  // merge whose run always fails blocks no other. A pass without a failed run forgets the failed merge. It marks no
  // merge seen.
  readMerges(cx) {
    if (this.view !== "board" || this.state.kind !== "read" || this.mergesReading) return;
    const { cache } = this.state;
    if (cache.refreshedAt === this.mergesReadOn) return;
    this.mergesReadOn = cache.refreshedAt;
    const { board, cause } = this.shownBoard(cache);
    if (cause !== null || mergesCause(board.merged) !== null) return;
    this.mergesReading = true;
    const after = board.merged.findIndex(({ sha }) => sha === this.mergeFailed) + 1;
    const walk = [...board.merged.slice(after), ...board.merged.slice(0, after)];
    cx.spawn(async (cx) => {
      let failed = null;
      for (const { sha } of walk) {
        if (this.outcomes.has(`${this.repository}@${sha}`)) continue;
        if (await this.keptReport(this.repository, sha) === null) {
          if (failed !== null) continue;
          if ((await this.runReport(this.repository, sha)).report === undefined) {
            failed = sha;
            continue;
          }
        }
        cx.notify();
      }
      this.mergeFailed = failed;
      this.mergesReading = false;
    });
  }

  // Shows the open merge's report: the one the queue kept at once, else the queue's run of it, and marks the merge seen
  // once a report shows. Each opening and Try again is counted, and closing the sheet counts one, so a reply to an
  // earlier one, or one landing after the sheet closed, is dropped, whenever it lands.
  readReport(cx) {
    const run = (this.reportRuns += 1);
    const { repository, sha } = this.opener;
    this.report = { checking: true };
    cx.notify();
    cx.spawn(async (cx) => {
      const kept = await this.keptReport(repository, sha);
      if (run !== this.reportRuns) return;
      if (kept === null) {
        this.report = { reading: true };
        cx.notify();
        const read = await this.runReport(repository, sha);
        if (run !== this.reportRuns) return;
        this.report = read;
      } else {
        this.report = { report: kept };
      }
      if (this.report?.report !== undefined) markSeen(repository, [sha]);
      cx.notify();
    });
  }

  // Moves focus one step inside the sheet. The end stop after the body marks the place past its last control, whatever the
  // body draws, so a step onto it goes on to Close, and a step back from Close or the sheet itself starts from it; Herdr's
  // own order takes every other step.
  moveInSheet(backward) {
    if (backward) {
      if (this.sheetClose.is_focused() || this.sheetFocus.is_focused()) this.sheetEnd.focus();
      // @ts-expect-error Herdr's window global has focus_prev, which the DOM Window type lacks
      window.focus_prev();
      return;
    }
    // @ts-expect-error Herdr's window global has focus_next, which the DOM Window type lacks
    if (!this.sheetEnd.is_focused()) window.focus_next();
    if (this.sheetEnd.is_focused()) this.sheetClose.focus();
  }

  // A press that replaces the control holding the keyboard, an answer drawing its receipt or Undo, leaves Esc and Tab
  // reaching nothing in the sheet, so the sheet takes the keyboard, as when it opened, unless Close, which no press
  // replaces, holds it. A read that changes or removes the sheet card's answers replaces their controls as a press does.
  // A command's answer lands after its press, when the sheet may be closed or show another card. Its button drops the
  // keyboard as it disables, so its press calls this as it starts too.
  keepFocusInSheet(item) {
    if (!this.sheetOpen || item.repository !== this.opener.repository || item.card !== this.opener.card) return;
    this.takeKeyboardInSheet();
  }

  takeKeyboardInSheet() {
    if (!this.sheetClose.is_focused()) this.sheetFocus.focus();
  }

  // The versioned keys of the queue items of the card the sheet shows.
  sheetKeys(items) {
    const { repository, card } = this.opener;
    return new Set(items.filter((item) => item.repository === repository && item.card === card).map(versioned));
  }

  send(item, cx) {
    const reply = this.drafts.get(versioned(item)).value().trim();
    if (reply === "" || reply.length > MAX_ANSWER) {
      this.failures.set(item.key, `${SEND_LABEL} failed: ${reply === "" ? "the answer is empty" : `the answer is ${reply.length} characters, over the ${MAX_ANSWER} limit`}`);
      cx.notify();
      return;
    }
    this.press(item, SEND_LABEL, ["act", item.key, "answer", item.version, reply], item.category === "merge" ? RECEIPTS.relay : RECEIPTS.answer, cx);
  }

  // What the owner has picked and typed for each question of the waiting menu `item`.
  menuEntries(item) {
    return menuForm(item).map((q, index) => {
      const key = menuDraftKey(item, index);
      const picked = this.chosen.get(key) ?? new Set();
      const choices = q.options.map((option) => option.label).filter((label) => picked.has(label));
      const text = this.drafts.get(key).value().trim();
      return { ...(choices.length > 0 && { choices }), ...(text !== "" && { text }) };
    });
  }

  // Sends one answer covering every question of the waiting menu `item` through `queue.mjs answer-menu`, which checks it and
  // writes it for the job's hook; nothing is typed into the job's terminal.
  sendMenu(item, entries, label, cx) {
    if (entries.some((entry) => Object.keys(entry).length === 0)) {
      this.failures.set(item.key, `${label} failed: choose or type an answer for every question`);
      cx.notify();
      return;
    }
    this.press(item, label, ["answer-menu", item.terminal, item.askId, "--answer", JSON.stringify(menuAnswer(item, entries))], null, cx);
  }

  // Picks or drops `label` for question `q`: a single-select question keeps one pick and clears its typed text.
  choose(item, q, key, label, on, cx) {
    const picked = new Set(q.multiSelect ? this.chosen.get(key) : []);
    if (on) picked.add(label);
    else picked.delete(label);
    this.chosen.set(key, picked);
    if (on && !q.multiSelect) this.drafts.get(key).set_value("");
    cx.notify();
  }

  // Esc ends a drag, else closes the open sheet, else closes this copy's overlay. c clears the digest in the Decisions view,
  // except while an input holds the keyboard, where it is typed text, and while the sheet is open, which
  // keeps every key from the view beneath.
  keyDown({ key, modifiers }, cx) {
    if (key === "escape") {
      if (this.drag !== null) this.endDrag(cx);
      else if (this.sheetOpen) this.closeSheet(cx);
      else if (this.overlay !== null) closeOverlay(this.overlay);
      return;
    }
    if (this.view !== "decisions") return;
    if (this.sheetOpen || key !== "c" || modifiers.control || modifiers.alt || modifiers.platform || this.typing.size > 0) return;
    if (this.state.kind === "read" && digestOf(this.state.cache).length > 0) this.clear(cx);
  }

  // Whether the Decisions view's own controls lie beneath the open sheet, which holds none of them, so that each takes no
  // press and no Tab. The Floor and the Board draw their items' controls inside the sheet, and the inbox opens none.
  beneathSheet() {
    return this.sheetOpen && this.view === "decisions";
  }

  // The item's response button: the pressed one reads "Working", and every one is off while a command of the item runs.
  response(t, item, name, label, onClick, solid = false, off = false) {
    const running = this.running.get(item.key);
    const build = solid ? solidButton : controlButton;
    return build(t, `fabraik-queue-${name}-${item.key}`, running === label ? "Working" : label, this.beneathSheet() ? null : onClick,
      running !== undefined || off);
  }

  // The answer box with its square send control at the box's height: off while the box is empty or a command of the item
  // runs, and a spinner while the answer is sent.
  // A waiting menu's box is its draft `key`, and its send control sends the menu's answer.
  answerBox(t, item, label, key = versioned(item)) {
    const sending = this.running.get(item.key) === SEND_LABEL;
    const off = this.running.has(item.key) || this.drafts.get(key).value().trim() === "";
    const inert = this.beneathSheet();
    const icon = svg(sending ? SPINNER : SEND).size(14).flex_none().text_color(sending ? t.working : off ? t.dim : t.foreground);
    const send = item.category === "menu" ? (cx) => this.sendMenu(item, this.menuEntries(item), SEND_LABEL, cx) : (cx) => this.send(item, cx);
    return h_flex().w_full().items_stretch().gap(6)
      .child(this.answerInput(t, key, label))
      .child(pressedBy(Button.new(`fabraik-queue-answer-${item.key}`).accessibility_label(`Send answer for card ${item.card}`).w(28).flex_none()
        .flex().items_center().justify_center().rounded(6).border_1().border_color(t.border)
        .focus((s) => s.border_color(t.foreground)).disabled(off), inert ? null : (_event, cx) => send(cx))
        .when(!off && !inert, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .child(sending ? icon.spin(900) : icon));
  }

  answerInput(t, key, label) {
    return Input.new(this.drafts.get(key)).accessibility_label(label).flex_1().min_w(0).min_h(28).px(8).rounded(6).border_1()
      .border_color(t.input).bg(t.background).when(this.beneathSheet(), (el) => el.tab_stop(false).disabled(true));
  }

  // A waiting menu's open card: a deliver question shows the decision card and screenshots of the merge item of its own
  // repository and card, exactly as that item shows them, or why it shows none; a permission prompt its tool and command,
  // and where the call is not shown whole a line saying so; a plan as Markdown; a single question's text with its options'
  // descriptions (a menu with several questions draws them with its answers).
  menuDetail(item, t) {
    if (isDeliver(item)) {
      const none = `No decision card is shown here for card ${item.card}`;
      if (item.repository === undefined) return [mutedLine(t, `${none}: its project could not be read: ${item.repositoryUnread}`)];
      const merge = mergeOf(this.cachedItems(), item);
      return merge ? this.itemDetail(merge, t) : [mutedLine(t, none)];
    }
    if (item.kind === "permission") {
      return [mutedLine(t, oneLine(`${item.toolName}: ${item.input ?? ""}`)), ...(item.whole === true ? [] : [mutedLine(t, MENU_NOT_WHOLE)])];
    }
    if (item.kind === "plan") return [TextView.markdown(`queue-plan-${item.key}`, item.plan)];
    return isSimple(item) ? this.questionLines(t, item.questions[0]) : [];
  }

  questionLines(t, q) {
    return [div().child(q.question), ...q.options.filter((option) => option.description).map((option) => mutedLine(t, `${option.label}: ${option.description}`))];
  }

  itemDetail(item, t) {
    if (item.category === "menu") return this.menuDetail(item, t);
    if (item.category === "merge") {
      if (item.missing) return [problemLine(t, `Proof missing: ${item.missing.fact}. ${item.missing.next}`)];
      return [
        ...(item.reason ? [mutedLine(t, item.reason)] : []),
        ...(item.decisionCard ? [TextView.markdown(`queue-card-${item.key}`, item.decisionCard)] : []),
        ...(item.visual === "none"
          ? [mutedLine(t, "No visual change")]
          : item.screenshots.map((path) => image(path).w_full().max_h(SHOT_MAX_HEIGHT))),
      ];
    }
    if (item.category === "question") return [div().child(item.question)];
    return [
      ...(item.reason ? [mutedLine(t, item.reason)] : []),
      ...(isRetro(item) ? retroDetail(t, item) : item.scope ? [TextView.markdown(`queue-scope-${item.key}`, item.scope)] : []),
    ];
  }

  // The saved queue's items, none where the inbox found it absent or unreadable.
  cachedItems() {
    return this.state.kind === "read" ? this.state.cache.items : [];
  }

  // A waiting menu's controls. A deliver menu whose job did not ask about the version of the decision card it shows offers
  // no yes: one question offers its other choices and several offer no answer control, with the line saying why and, in
  // the inbox, the control that opens Decisions to read it. Otherwise one single-select question: each choice is a button,
  // the approving one solid, beside the answer box; several questions or a multi-select: a group of toggles and a box for
  // each question and one Send answers. Where it was sent or could not be delivered, the line saying so.
  menuResponses(item, t, local) {
    if (item.delivery === "undelivered") {
      const words = item.words === undefined ? "" : ` Your answer: ${item.words}.`;
      return { lines: [problemLine(t, `Not delivered: ${item.cause}.${words} Answer in the job's tab or send again.`)], buttons: [local("dismiss", "Dismiss", RECEIPTS.dismissed)] };
    }
    if (item.delivery === "sent" || this.sent.has(item.askId)) return { lines: [mutedLine(t, MENU_SENT)], buttons: [] };
    if (!item.answerable) return { lines: [], buttons: [] };
    const form = menuForm(item);
    const approving = (form[0].options.find((option) => APPROVING.includes(option.label)) ?? form[0].options[0]).label;
    const choice = ({ label }, index) => this.response(t, item, `choice-${index}`, label,
      (_event, cx) => this.sendMenu(item, [{ choices: [label] }], label, cx), label === approving).accessibility_label(`${label} for card ${item.card}`);
    if (isDeliver(item)) {
      const merge = mergeOf(this.cachedItems(), item);
      if (!askedAbout(merge, item)) {
        const why = item.versionUnread !== undefined ? `${MENU_VERSION_UNREAD}: ${item.versionUnread}` : merge ? MENU_OTHER_VERSION : undefined;
        return {
          lines: why === undefined ? [] : [mutedLine(t, why)],
          buttons: [
            ...(isSimple(item) ? form[0].options.flatMap((option, index) => (option.label === DELIVER_APPROVE ? [] : [choice(option, index)])) : []),
            ...(this.view === "panel" ? [controlButton(t, `fabraik-queue-read-${item.key}`, READ_IN_DECISIONS, () => openView("decisions"))] : []),
          ],
        };
      }
    }
    if (!isSimple(item)) {
      const complete = this.menuEntries(item).every((entry) => Object.keys(entry).length > 0);
      return {
        lines: form.map((q, index) => this.menuGroup(t, item, q, menuDraftKey(item, index))),
        buttons: [this.response(t, item, "send", MENU_SEND_ALL, (_event, cx) => this.sendMenu(item, this.menuEntries(item), MENU_SEND_ALL, cx), true, !complete)],
      };
    }
    const label = `Other answer for card ${item.card}`;
    return {
      lines: [div().child(label), this.answerBox(t, item, label, menuDraftKey(item, 0))],
      buttons: form[0].options.map(choice),
    };
  }

  // One question of a waiting menu that takes several or several picks: its text, its options' descriptions, a line saying
  // where it takes more than one pick, a toggle for each option and its own answer box under its visible name.
  menuGroup(t, item, q, key) {
    const off = this.beneathSheet() || this.running.has(item.key);
    const picked = this.chosen.get(key) ?? new Set();
    const toggle = ({ label }, index) => {
      const on = picked.has(label);
      return Toggle.new(`fabraik-queue-choice-${index}-${key}`).pressed(on).disabled(off).accessibility_label(`${label} for card ${item.card}`)
        .h(24).min_w(24).px(8).flex().items_center().rounded(6).border_1().border_color(on ? t.accent : t.muted)
        .focus((s) => s.border_color(t.foreground)).text_color(off ? t.dim : t.foreground)
        .when(on, (el) => el.bg(t.accent + CHIP_ALPHA))
        .when(!off, (el) => el.cursor_pointer())
        .when(!off && !on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_change((checked, cx) => this.choose(item, q, key, label, checked, cx))
        .child(label);
    };
    const label = `Other answer to ${q.header}`;
    return v_flex().gap(6).children(this.questionLines(t, q))
      .when(q.multiSelect, (el) => el.child(mutedLine(t, MENU_SEVERAL)))
      .child(h_flex().flex_wrap().gap(6).children(q.options.map(toggle)))
      .child(div().child(label))
      .child(this.answerInput(t, key, label));
  }

  // The lines and buttons that answer an item; the solid button is its main answer and comes first.
  responses(item, t) {
    const local = (name, label, receipt, solid = false) => this.response(t, item, name, label, (_event, cx) => this.mark(item, receipt, true, cx), solid);
    const written = (name, label, args, receipt, solid = false) => this.response(t, item, name, label, (_event, cx) => this.press(item, label, args, receipt, cx), solid);
    const act = (action) => ["act", item.key, action, item.version];
    if (item.category === "menu") return this.menuResponses(item, t, local);
    if (item.category === "merge" && hasMenu(this.state.cache.items, item)) return { lines: [mutedLine(t, MERGE_AT_MENU)], buttons: [] };
    if (item.category === "merge") {
      const lines = item.missing === undefined
        ? [this.answerBox(t, item, `Answer to card ${item.card}`), mutedLine(t, CARRY_LINE)]
        : [mutedLine(t, UNREAD_VERSION_LINE)];
      return { lines, buttons: [written("park", "Put aside", act("park"), RECEIPTS.park)] };
    }
    if (item.category === "question" && item.answerable) {
      return {
        lines: [...(this.replaced.has(item.key) ? [mutedLine(t, REPLACED_LINE)] : []), this.answerBox(t, item, `Answer to card ${item.card}`)],
        buttons: [],
      };
    }
    if (item.category === "question") return { lines: [mutedLine(t, heldLine(item.heldOn))], buttons: [] };
    if (isRetro(item)) {
      const making = ({ n }) => this.picks.has(`${item.key}#${n}`);
      const unmade = item.proposals.filter((draft) => draft.card === undefined);
      return {
        lines: [
          ...item.proposals.filter((draft) => draft.card !== undefined)
            .map(({ n, card }) => mutedLine(t, `Proposal ${n} is now ${folderName(card.repository)} card ${card.number}`)),
          ...unmade.filter(making).map(({ n }) => mutedLine(t, `Proposal ${n} is being made a card${NEXT_READ}`)),
        ],
        buttons: [
          ...unmade.filter((draft) => !making(draft)).map(({ n, title }) => written(`pick-${n}`, `Make proposal ${n} a card`, [...act("pick"), String(n)], null)
            .accessibility_label(`Make proposal ${n} a card: ${title}`)),
          written("drop", "Close retro", act("drop"), RECEIPTS.close),
        ],
      };
    }
    if (item.category === "suggested") {
      return {
        lines: item.scope ? [] : [mutedLine(t, NO_SCOPE_LINE)],
        buttons: [...(item.scope ? [written("keep", "Accept card", act("keep"), RECEIPTS.keep, true)] : []), written("drop", "Reject", act("drop"), RECEIPTS.drop)],
      };
    }
    if (item.category === "failure") {
      return {
        lines: [],
        buttons: [local("dismiss", "Dismiss", RECEIPTS.dismissed, true)],
      };
    }
    return { lines: [], buttons: [] };
  }

  footer(item, t) {
    const { lines, buttons } = this.responses(item, t);
    if (lines.length === 0 && buttons.length === 0) return [];
    const refused = this.failures.get(item.key);
    return [v_flex().px(16).pt(12).pb(14).gap(8).border_t(1).border_color(t.border).bg(t.popover)
      .children(lines)
      .when(Boolean(refused), (el) => el.child(problemLine(t, refused)))
      .when(buttons.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).children(buttons)))];
  }

  // An item drawn whole as a Decisions card. A card that cannot be drawn is one problem line in its place, so it fails
  // neither the cards beside it nor the view.
  fullCard(item, t) {
    try {
      return v_flex().w_full().rounded(10).bg(t.raised).border_1().border_color(t.border).overflow_hidden()
        .child(v_flex().px(16).pt(14).gap(8)
          .child(cardHeading(t, item))
          .child(h_flex().items_center().gap(8)
            .child(agentNamedMark(itemProgram(item, Array.isArray(this.state.cache.boards) ? this.state.cache.boards : [], this.programs?.list ?? null), t.muted, 18))
            .child(div().text_size(16).font_semibold().line_height(1.3).child(titleOf(item)))))
        .child(v_flex().px(16).py(12).gap(8).children(this.itemDetail(item, t)))
        .children(this.footer(item, t));
    } catch (error) {
      return problemLine(t, `${cardRef(item)} cannot be read: ${oneLine(/** @type {{ message?: string } | null} */ (error)?.message ?? error)}`);
    }
  }

  // A handled card: its chip and title, with Undo where the answer can be taken back (a local mark, or a written one
  // with a record), above what was done, which wraps inside the card; then the line saying why Undo failed, and where
  // the answer cannot be taken back the line saying why.
  receipt(item, mark, t) {
    const refused = this.failures.get(item.key);
    const undoable = mark.local || Boolean(mark.record);
    const why = item.category === "menu" ? NO_UNDO_MENU : mark.action !== "answer" ? `No Undo: ${folderName(item.repository)}'s queue reader predates it`
      : NO_UNDO_COORDINATOR;
    return v_flex().w_full().gap(4).px(12).py(10).rounded(10).border_1().border_color(t.border)
      .child(h_flex().w_full().items_center().gap(8)
        .child(kindChip(t, item, true))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${cardRef(item)}, ${titleOf(item)}`))
        .when(undoable, (el) => el.child(this.response(t, item, "undo", "Undo", (_event, cx) => (mark.local
          ? this.unmark(item, cx) : this.press(item, "Undo", ["undo", item.key, mark.action, mark.record], null, cx)))
          .accessibility_label(`Undo for card ${item.card}`))))
      .child(div().w_full().min_w(0).child(mark.receipt))
      .when(Boolean(refused), (el) => el.child(problemLine(t, refused).w_full().min_w(0)))
      .when(!undoable, (el) => el.child(mutedLine(t, why).w_full().min_w(0).text_size(12)));
  }

  // The mark of a handled item: the owner's own, or, for a waiting menu, the job's signal that it took the answer.
  handledMark(item) {
    return this.marks.get(versioned(item)) ?? (item.delivery === "delivered" ? { receipt: MENU_DELIVERED, local: false } : undefined);
  }

  // The digest box; each line is a button that opens its merge's sheet.
  digestSection(digest, digestUnread, fetchedAt, t) {
    const unread = digestUnread.map(folderName).join(", ");
    const fetched = fetchedAt === null ? "last fetch unknown" : stamp("Fetched", fetchedAt);
    const line = ({ repository, sha, at, subject }) => this.sheetOpener(`${DIGEST_ID}${repository}@${sha}`, { repository, sha, at })
      .w_full().min_h(24).px(6).flex().justify_start().items_center().gap(6).rounded(6).border_1().border_color(t.surface)
      .focus((s) => s.border_color(t.foreground)).hover((s) => s.bg(t.popover))
      .when(isUnseen(repository, sha), (el) => el.child(newChip(t)))
      .child(`${folderName(repository)}: ${subject}, ${clock(at)}`);
    return [v_flex().px(12).py(10).gap(8).rounded(10).border_1().border_color(t.border)
      .child(h_flex().justify_between().items_center()
        .child(h_flex().gap(8).items_center()
          .child(div().font_semibold().child("Merged in the last day"))
          .child(div().text_size(12).text_color(t.muted).child(fetched)))
        .when(digest.length > 0, (el) => el.child(controlButton(t, "fabraik-queue-clear", "Clear (c)",
          this.beneathSheet() ? null : (_event, cx) => this.clear(cx)))))
      .child(digest.length === 0
        ? (unread ? problemLine(t, `Merges not read for ${unread}`) : mutedLine(t, "Nothing new merged in the last day"))
        : v_flex().border_l(3).border_color(t.done).pl(8).gap(4).children(digest.map(line)))
      .when(digest.length > 0 && Boolean(unread), (el) => el.child(problemLine(t, `Not read: ${unread}`)))];
  }

  body(t) {
    const state = this.state;
    if (state.kind === "loading") return [mutedLine(t, "Reading the queue")];
    if (state.kind === "absent") return [div().child("No queue read yet")];
    if (state.kind === "unreadable") return [problemLine(t, `Queue cache unreadable: ${state.error}`)];
    try {
      if (this.view === "floor") return this.floorLines(state.cache, t);
      if (this.view === "board") return this.boardLines(state.cache, t);
      return this.decisionLines(state.cache, t);
    } catch (error) {
      return [problemLine(t, `Queue cache unreadable: ${oneLine(/** @type {{ message?: string } | null} */ (error)?.message ?? error)}`)];
    }
  }

  // A waiting item as a Decisions card: its receipt where it is marked handled, else the whole card.
  decisionCard(item, t) {
    const mark = this.handledMark(item);
    return mark ? this.receipt(item, mark, t) : this.fullCard(item, t);
  }

  openCoordinator(board, runtime, cx) {
    const { repository } = board;
    if (this.beneathSheet() || this.coordinatorOpens.get(repository)?.pending || coordinatorOpenBlock(board) !== null) return;
    this.coordinatorOpens.set(repository, { pending: true, text: "Opening…" });
    cx.notify();
    cx.spawn(async (cx) => {
      const { code, failure } = await this.run("open-coordinator", repository, runtime);
      const result = code === 0 ? { text: `Requested ${COORDINATOR_RUNTIMES.get(runtime)} for this session.` }
        : code === 5 ? { text: COORDINATOR_OPEN } : { text: `Coordinator could not open: ${failure}`, problem: true };
      this.coordinatorOpens.set(repository, result);
      cx.notify();
    });
  }

  coordinatorControls(t, board, line) {
    const choice = coordinatorChoice(board);
    if (!choice) return [];
    if (choice.unread) return [problemLine(t, choice.unread).text_size(12)];
    const { repository } = board;
    const { runtime, installed } = choice;
    const blocked = coordinatorOpenBlock(board);
    const opened = this.coordinatorOpens.get(repository);
    const choices = [...COORDINATOR_RUNTIMES].filter(([value]) => installed.includes(value));
    const controls = choices.map(([value, name]) => controlButton(t, `fabraik-queue-open-${value}-${repository}`, `Open ${name} once`,
      this.beneathSheet() ? null : (_event, cx) => this.openCoordinator(board, value, cx), blocked !== null || opened?.pending === true));
    return [
      mutedLine(t, `Saved default: ${COORDINATOR_RUNTIMES.get(runtime)}`).text_size(12),
      ...(!installed.includes(runtime) ? [mutedLine(t, "The saved default is unavailable because it is not installed.").text_size(12)] : []),
      div().child("Choose for this session"),
      h_flex().flex_wrap().gap(6).children(controls),
      ...(blocked && blocked !== line.text ? [mutedLine(t, blocked).text_size(12)] : []),
      ...(opened && opened.text !== blocked ? [(opened.problem ? problemLine : mutedLine)(t, opened.text).text_size(12)] : []),
    ];
  }

  // The Decisions view's blocks: a tile for each project, then one group per project, the boards' projects in their
  // order, then the other projects in item order; a project waiting on nothing has a tile and no group. A waiting menu
  // whose project could not be read is in a last group of its own. A handled card is its receipt in its own place.
  decisionLines(cache, t) {
    const { items, digestUnread, fetchedAt } = cache;
    const problems = problemTexts(cache);
    const tiered = items.filter((item) => WAITING.includes(item.category));
    const unmarked = (group) => group.filter((item) => this.handledMark(item) === undefined).length;
    const waiting = unmarked(tiered);
    const boards = Array.isArray(cache.boards) ? cache.boards : [];
    const boarded = boards.map((board) => board?.repository).filter((path) => typeof path === "string");
    const projects = [...new Set([...boarded, ...tiered.map((item) => item.repository).filter((path) => path !== undefined)])];
    const unplaced = tiered.filter((item) => item.repository === undefined);
    const handled = this.handled.size;
    return [
      ...problems.map((text) => problemLine(t, `Problem: ${text}`)),
      ...seenNotice(t),
      ...(waiting === 0 && problems.length === 0 ? [v_flex().px(18).py(16).gap(8).rounded(10).bg(t.raised)
        .child(div().text_size(18).font_semibold().child("Nothing waiting on you"))
        .when(handled > 0, (el) => el.child(mutedLine(t,
          `You handled ${plural(handled, "card")} today. Cards answered in chat leave when the queue next confirms them.`)))] : []),
      ...(projects.length === 0 ? [] : [h_flex().flex_wrap().gap(10).children(projects.map((repository) => {
        const board = boards.find((entry) => entry?.repository === repository);
        const line = coordinatorStatus(board);
        return projectTile(t, repository, unmarked(tiered.filter((item) => item.repository === repository)), line, this.coordinatorControls(t, board, line));
      }))]),
      ...[...projects.map((repository) => [folderName(repository), tiered.filter((item) => item.repository === repository)]),
        [PROJECT_UNREAD, unplaced]].flatMap(([heading, group]) => {
        if (group.length === 0) return [];
        const left = unmarked(group);
        return [v_flex().gap(10)
          .child(h_flex().items_center().gap(8)
            .child(div().font_semibold().child(heading))
            .child(mutedLine(t, left === 0 ? "all handled" : `${left} left`)))
          .children(group.map((item) => this.decisionCard(item, t)))];
      }),
      ...this.digestSection(digestOf(cache), digestUnread, fetchedAt, t),
    ];
  }

  // The agents the Floor reads for its projects: the tied terminals (ties is null where the terminal list was not read,
  // and terminalsUnread says why) and Herdr's program table (programs is null where it was not, programsUnread says why).
  floorAgents(projects) {
    /** @type {string | null} */
    let terminalsUnread = null;
    /** @type {Map<any, any> | null} */
    let ties = null;
    try {
      const list = terminals();
      if (isTerminalList(list)) ties = tieAgents(projects.filter((board) => boardCause(board) === null), list);
      else terminalsUnread = "the terminal list is not one this view can read";
    } catch (error) {
      terminalsUnread = oneLine(/** @type {{ message?: string } | null} */ (error)?.message ?? error);
    }
    const { list: programs = null, unread: programsUnread } = this.programs;
    return { ties, programs, terminalsUnread, programsUnread };
  }

  // The Floor's lines: problem lines, then the grid. A board entry naming no project is a problem line, never a row.
  // Herdr's terminal list is read at each render, which Herdr repeats as terminals change, so a card's agent is live;
  // a list it cannot read, or a program table, is a line above the grid and leaves each card to its claim.
  floorLines(cache, t) {
    const problems = problemTexts(cache).map((text) => problemLine(t, `Problem: ${text}`));
    const { boards } = cache;
    if (!Array.isArray(boards)) return [...problems, problemLine(t, "Problem: this read has no boards this view can read")];
    if (boards.length === 0) return [...problems, mutedLine(t, "No projects in this read")];
    const projects = boards.filter(isProject);
    const { ties, programs, terminalsUnread, programsUnread } = this.floorAgents(projects);
    const tiles = {
      inert: this.sheetOpen,
      open: (repository, card) => (_event, cx) => this.openSheet({ repository, card }, cx),
      opener: (id, merge) => this.sheetOpener(id, merge),
      openBoard: (repository) => () => openView("board", repository),
      focus: (repository, card) => (this.opener?.repository === repository && this.opener.card === card ? this.sheetReturn : null),
    };
    return [
      ...problems,
      ...seenNotice(t),
      ...boards.flatMap((board, index) => (isProject(board) ? [] : [problemLine(t, `Problem: board entry ${index + 1} is not one this view can read`)])),
      ...(terminalsUnread === null ? [] : [problemLine(t, `Agent state not read: ${terminalsUnread}`)]),
      ...(programsUnread === undefined ? [] : [problemLine(t, `Agent icons not read: ${programsUnread}`)]),
      ...(projects.length === 0 ? [] : [floorTable(t, projects, isToday(cache.refreshedAt), { ties, programs, tiles })]),
    ];
  }

  // The Board's project's entry in the read, with why it cannot be drawn (null where it can); no board where the tab
  // names no project or the read has none for it.
  shownBoard(cache) {
    if (typeof this.repository !== "string") return { cause: "Board not shown: this tab names no project" };
    const board = Array.isArray(cache.boards) ? cache.boards.find((found) => found?.repository === this.repository) : undefined;
    if (board === undefined) return { cause: NO_BOARD };
    return { board, cause: boardCause(board) };
  }

  // The Board's problem texts: its own board entry's lines, or with no entry its project's lines of the whole list without
  // their folder prefix, where a project with no queue reader has its cause; then its problem items, then every
  // machine-wide line, never another project's. An absent list is none; a present one that is not a list is a line saying so.
  boardProblems(cache, board) {
    const listed = (list) => (list === undefined ? [] : Array.isArray(list) ? list : [PROBLEMS_UNREADABLE]);
    const prefix = typeof this.repository === "string" ? `${folderName(this.repository)}: ` : null;
    const unboarded = () => (prefix === null ? [] : cache.problems
      .filter((text) => typeof text === "string" && text.startsWith(prefix)).map((text) => text.slice(prefix.length)));
    return [
      ...(board === undefined ? unboarded() : listed(board.problems)),
      ...cache.items.filter((item) => item.category === "problem" && item.repository === this.repository)
        .map((item) => `${folderName(item.repository)}: ${item.problem}`),
      ...listed(cache.machineProblems),
    ];
  }

  // The Board's header: the project's folder and its Coordinator's state, then its right end.
  boardHeader(t, cache, readAge) {
    const { board } = cache === null ? {} : this.shownBoard(cache);
    const coordinator = board === undefined ? null : coordinatorStatus(board);
    return h_flex().flex_none().px(16).py(12).gap(12).justify_between().items_center().border_b(1).border_color(t.border)
      .child(h_flex().min_w(0).items_center().gap(12)
        .when(typeof this.repository === "string", (el) => el.child(div().min_w(0).truncate().text_size(16).font_semibold()
          .child(folderName(this.repository))))
        .when(coordinator !== null, (el) => el.child(coordinatorLine(t, coordinator).text_size(12.5))))
      .child(this.headerEnd(t, cache, readAge));
  }

  // A view header's right end: the read's time once a read is loaded, Refresh, which is off while a refresh runs, then, in
  // an overlay, Close. Both are beneath the sheet, so inert, while one is open.
  headerEnd(t, cache, readAge) {
    return h_flex().flex_none().items_center().gap(8)
      .when(cache !== null, (el) => el.child(readAge().text_size(12)))
      .child(controlButton(t, VIEW_REFRESH_ID, "Refresh", this.sheetOpen ? null : (_event, cx) => this.refresh(cx), this.refreshing))
      .when(this.overlay !== null, (el) => el.child(controlButton(t, VIEW_CLOSE_ID, "Close",
        this.sheetOpen ? null : () => closeOverlay(this.overlay))));
  }

  // The strip under the header while other projects have items waiting on the owner: their count, a chip for each of the
  // first three, which opens its card's sheet here, and the rest in Decisions.
  boardStrip(t, cache) {
    const others = cache.items.filter((item) => TIERS.includes(item.category) && item.repository !== this.repository
      && !this.marks.has(versioned(item)));
    if (others.length === 0) return [];
    const more = others.length - STRIP_CHIPS;
    return [h_flex().flex_none().h(40).px(16).gap(8).items_center().overflow_hidden().whitespace_nowrap().bg(t.blocked + STRIP_ALPHA)
      .border_b(1).border_color(t.border)
      .child(div().flex_none().font_semibold().child(`Also waiting on you ${others.length}`))
      .children(others.slice(0, STRIP_CHIPS).map((item) => this.sheetOpener(`${BOARD_ID}strip-${item.key}`, { repository: item.repository, card: item.card })
        .tooltip(`${kindLabel(item)}, ${cardRef(item)}, ${item.title}`).flex_none().h(24).px(8).flex().items_center().rounded(6)
        .bg(t.raised).border_1().border_color(t.border).focus((s) => s.border_color(t.foreground))
        .child(`${folderName(item.repository)}: ${SHORT_KINDS[item.category]} card ${item.card}`)))
      .when(more > 0, (el) => el.child(controlButton(t, `${BOARD_ID}more`, `${more} more`, () => openView("decisions")).flex_none()))];
  }

  // An item of this project waiting on the owner, as a Needs you entry that opens its card's sheet; its receipt once
  // handled.
  needsEntry(t, item) {
    const mark = this.marks.get(versioned(item));
    if (mark) return this.receipt(item, mark, t);
    const text = summary(item);
    return this.sheetOpener(`${BOARD_ID}needs-${item.key}`, { repository: item.repository, card: item.card })
      .accessibility_label(`${kindLabel(item)}, card ${item.card}, ${item.title}`)
      .w_full().px(10).py(8).rounded(8).bg(t.raised).border_1().border_color(t.border).hover((s) => s.bg(t.popover))
      .focus((s) => s.border_color(t.foreground))
      .child(v_flex().w_full().min_w(0).gap(6)
        .child(h_flex().items_center().gap(8).child(kindChip(t, item, false))
          .child(div().text_size(11).text_color(t.muted).child(`card ${item.card}`)))
        .child(div().text_size(13.5).font_semibold().line_height("19px").child(item.title))
        .when(Boolean(text), (el) => el.child(div().w_full().truncate().text_size(12).text_color(t.muted).child(text))));
  }

  // A merge of this project's last day, as a Merged entry: its title, which opens its merge's sheet, and under it the line
  // holding the New chip while the merge is unseen, its time and, while unseen, Mark as seen, which marks it seen without
  // opening the sheet and keeps the keyboard on the title. Both controls are inert while the sheet is open.
  mergedEntry(t, merge) {
    const { repository } = this;
    const unseen = isUnseen(repository, merge.sha);
    const key = `${repository}@${merge.sha}`;
    const time = `merged at ${clock(merge.at)}`;
    return v_flex().id(`${BOARD_ID}merged-entry-${merge.sha}`).flex_none().gap(6).px(10).py(8).rounded(8).bg(t.raised).border_1().border_color(t.border)
      .child(this.sheetOpener(`${BOARD_ID}merged-${merge.sha}`, { repository, sha: merge.sha, at: merge.at })
        .accessibility_label(`${unseen ? "New, " : ""}${merge.subject}, ${time}`).tooltip(merge.subject)
        .w_full().min_w(0).flex().flex_col().items_start().rounded(4).border_1().border_color(t.raised)
        .focus((s) => s.border_color(t.foreground))
        .when(this.boardReturn?.key === key, (el) => el.track_focus(this.boardReturn?.handle))
        .child(div().text_size(13.5).font_semibold().text_color(t.muted).line_height("19px").max_h(57).overflow_hidden().child(merge.subject)))
      .child(h_flex().id(`${BOARD_ID}merged-line-${merge.sha}`).flex_wrap().items_center().gap(6)
        .when(unseen, (el) => el.child(newChip(t)))
        .child(div().text_size(12).text_color(t.muted).child(time))
        .when(unseen, (el) => el.child(div().flex_1()).child(controlButton(t, `${BOARD_ID}merged-seen-${merge.sha}`, "Mark as seen",
          this.sheetOpen ? null : (_event, cx) => this.markMergedSeen(key, [merge.sha], cx)).accessibility_label(`Mark ${merge.subject} as seen`))));
  }

  // Marks the repository's merges `shas` seen in one write and moves the keyboard to the title tracking `key`.
  markMergedSeen(key, shas, cx) {
    markSeen(this.repository, shas);
    this.holdBoardFocus(key, cx);
    cx.notify();
  }

  // The Merged column's data: the newest MERGED_SHOWN merges and every merge noted `disagrees` as entries, in the list's
  // order, or every merge once expanded; the control that shows all or fewer, drawn only where collapsing hides a merge;
  // while collapsed, the notice that a hidden merge is not noted or noted `unread`; the count of merges still New and,
  // while one is, Mark all seen, which marks every listed merge seen at once and moves the keyboard to the first title; or
  // the line naming the list it cannot read.
  mergedColumn(t, { merged }) {
    const cause = mergesCause(merged);
    if (cause !== null) return { count: null, list: [problemLine(t, cause)] };
    const unseen = merged.filter((merge) => isUnseen(this.repository, merge.sha));
    const outcomeOf = (merge) => this.outcomes.get(`${this.repository}@${merge.sha}`);
    const collapsed = merged.filter((merge, index) => index < MERGED_SHOWN || outcomeOf(merge) === "disagrees");
    const hidden = merged.filter((merge) => !collapsed.includes(merge));
    const shown = this.mergedExpanded ? merged : collapsed;
    return {
      count: `${unseen.length} new`,
      list: [...shown.map((merge) => this.mergedEntry(t, merge)), ...(hidden.length === 0 ? [] : [this.mergedMoreControl(t, merged.length)])],
      ...(this.mergedExpanded || !hidden.some((merge) => [undefined, "unread"].includes(outcomeOf(merge)))
        ? {} : { notice: problemLine(t, MERGED_UNCHECKED) }),
      action: unseen.length === 0 ? null : controlButton(t, `${BOARD_ID}merged-seen-all`, "Mark all seen",
        this.sheetOpen ? null : (_event, cx) => this.markMergedSeen(`${this.repository}@${merged[0].sha}`, unseen.map((merge) => merge.sha), cx)).flex_none(),
    };
  }

  // The Merged column's Show all control, or Show fewer once expanded, which keeps the keyboard through its press and is
  // inert while the sheet is open.
  mergedMoreControl(t, count) {
    const press = (_event, cx) => {
      this.mergedExpanded = !this.mergedExpanded;
      this.mergedMore ??= cx.focus_handle();
      this.mergedMore.focus();
      cx.notify();
    };
    const control = controlButton(t, `${BOARD_ID}merged-more`, this.mergedExpanded ? "Show fewer" : `Show all ${count} merges`,
      this.sheetOpen ? null : press);
    return h_flex().flex_none().child(this.mergedMore === null ? control : control.track_focus(this.mergedMore));
  }

  // A card's Show me first control, a kit Toggle (a button that stays down) whose focus and hover styles the kit honours,
  // unlike a Switch's; `id` its own: checked as its read gives the marker, or as the write whose success line shows wrote
  // it, and reading "Working" while its own write runs. Off is a `muted` outline, on an `accent` outline on a tint of it,
  // the state word carrying the state either way.
  showFirstSwitch(t, id, board, card, off, fromSheet) {
    const key = `${board.repository}#${card.card}`;
    const written = this.boardMoved?.key === key && typeof this.boardMoved.showFirst === "boolean";
    const on = written ? this.boardMoved?.showFirst : card.showFirst;
    const working = this.boardMove?.key === key && this.boardMove.label === SHOW_FIRST;
    return Toggle.new(id).pressed(on).disabled(off).accessibility_label(`${SHOW_FIRST} for card ${card.card}`)
      .h(24).min_w(24).px(8).flex().items_center().rounded(6).border_1().border_color(on ? t.accent : t.muted)
      .focus((s) => s.border_color(t.foreground)).text_color(off ? t.dim : t.foreground)
      .when(on, (el) => el.bg(t.accent + CHIP_ALPHA))
      .when(!off, (el) => el.cursor_pointer())
      .when(!off && !on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_change((checked, cx) => this.writeCard(board, card, {
        args: ["show-first", key, checked ? "on" : "off"],
        label: SHOW_FIRST,
        done: `${SHOW_FIRST} turned ${checked ? "on" : "off"}`,
        showFirst: checked,
      }, cx, fromSheet))
      .when(working, (el) => el.child("Working"))
      .when(!working, (el) => el.child(`${SHOW_FIRST}: `).child(div().font_semibold().child(on ? "on" : "off")));
  }

  // What a card that offers Show me first draws for it: its switch, or, where its marker was not read, the line saying so
  // in the switch's place; under an In review card's switch, the line saying a queued merge is not stopped.
  showFirstSlot(t, id, board, card, off, fromSheet) {
    if (!offersShowFirst(board, card)) return { toggle: null, lines: [] };
    if (typeof card.showFirst === "object") {
      return { toggle: null, lines: [problemLine(t, `${SHOW_FIRST} not read: ${card.showFirst.unread}`).text_size(12)] };
    }
    return {
      toggle: this.showFirstSwitch(t, id, board, card, off, fromSheet),
      lines: card.column === "In review" ? [mutedLine(t, SHOW_FIRST_QUEUED).text_size(12)] : [],
    };
  }

  // A Board card: a Ready card's rank, its title, which opens its sheet, its move controls and Show me first switch, the
  // line its column adds, the line of its last write and what blocks it. `rank` is null outside Ready and where the build
  // order is not read, which `ordered` says. It drags while it offers a move control that is on, and a ranked card tells a
  // drag the pointer is near it.
  boardCard(t, board, card, rank, ordered) {
    const ref = floorRef(card.card);
    const title = floorTitle(card.title);
    const blocked = blockedNote(card);
    const name = blocked ? `${ref} ${title}. ${blocked}` : `${ref} ${title}`;
    const line = card.title.startsWith(PROPOSED) ? SUGGESTED_LINE : CARD_LINES.get(card.column);
    const key = `${board.repository}#${card.card}`;
    const moves = cardMoves(board, card, rank, ordered);
    const off = this.boardMove !== null || this.boardMoved !== null || this.sheetOpen;
    const { toggle, lines } = this.showFirstSlot(t, `${BOARD_ID}show-first-${card.card}`, board, card, off, false);
    const failure = this.boardFailures.get(key);
    // The 2 high mark a drag draws where the card it holds would go in Ready to build: before this card, or after the last.
    const before = this.drag?.target?.before;
    const mark = rank === null || before === undefined ? null
      : before === rank ? "top" : before === (this.drag?.count ?? 0) + 1 && rank === this.drag?.count ? "bottom" : null;
    return v_flex().id(`${BOARD_ID}card-${card.card}`).flex_none().gap(6).px(10).py(8).rounded(8).bg(t.raised).border_1().border_color(t.border)
      .when(rank !== null, (el) => el.child(h_flex().items_center().gap(6)
        .child(rankBadge(t, rank))
        .child(div().text_size(11.5).font_semibold().text_color(rank === 1 ? t.foreground : t.muted)
          .child(rank === 1 ? `Next, card ${card.card}` : `Card ${card.card}`))
        .when(Boolean(blocked), (row) => row.child(div().text_size(11).px(5).rounded(4).border_1().border_color(t.input).child("Blocked")))))
      .child(this.sheetOpener(`${BOARD_ID}title-${card.card}`, { repository: board.repository, card: card.card }).accessibility_label(name).tooltip(name)
        .w_full().min_w(0).flex().flex_col().items_start().rounded(4).border_1().border_color(t.raised)
        .focus((s) => s.border_color(t.foreground))
        .when(this.boardReturn?.key === key, (el) => el.track_focus(this.boardReturn?.handle))
        .child(div().text_size(13.5).font_semibold().line_height("19px").max_h(57).overflow_hidden().child(title)))
      .when(moves.length > 0 || toggle !== null, (el) => el.child(h_flex().flex_wrap().gap(6)
        .children(moves.map((move) => controlButton(t, `${BOARD_ID}move-${card.card}-${move.move}`,
          this.boardMove?.key === key && this.boardMove.label === move.label ? "Working" : move.label,
          (_event, cx) => this.writeCard(board, card, moveWrite(key, card, move), cx),
          off).accessibility_label(move.name).on_mouse_down("left", (_event, cx) => this.controlPress(cx))))
        .when(toggle !== null, (row) => row.child(toggle.on_mouse_down("left", (_event, cx) => this.controlPress(cx))))))
      .children(lines)
      .when(failure !== undefined, (el) => el.child(problemLine(t, failure).text_size(12)))
      .when(this.boardMoved?.key === key, (el) => el.child(mutedLine(t, this.boardMoved?.line).text_size(12)))
      .when(line !== undefined, (el) => el.child(mutedLine(t, line).text_size(12)))
      .when(Boolean(blocked), (el) => el.child(this.blockerNote(t, board, card, rank === 1)))
      .when(moves.length > 0 && !off, (el) => el.cursor_grab().on_mouse_down("left", (event, cx) => this.holdCard(board, card, rank, moves, event, cx)))
      .when(rank !== null, (el) => el.on_mouse_move((event, cx) => this.dragNear(rank, event, cx)))
      .when(this.drag?.key === key && this.drag.target !== null, (el) => el.opacity(0.6))
      .when(mark !== null, (el) => el.relative().child(div().absolute().left(8).right(8).h(2).bg(t.accent)
        .when(mark === "top", (edge) => edge.top(0)).when(mark === "bottom", (edge) => edge.bottom(0))));
  }

  // What a card waits for, a line per blocker: one on this board is a link opening its own sheet, one off it is named
  // with why it does not open. The next card says it is skipped until the blockers merge.
  blockerNote(t, board, card, next) {
    return v_flex().gap(2).text_size(12.5).line_height(1.4).border_l(2).border_color(t.idle).pl(8)
      .children(card.blockers.map((blocker) => {
        const found = board.cards.find((other) => other.card === blocker);
        const what = found === undefined
          ? div().min_w(0).child(`card ${blocker}, not on this board, so the panel cannot open it`)
          : this.sheetOpener(`${BOARD_ID}blocker-${card.card}-${blocker}`, { repository: board.repository, card: blocker }).min_w(0).max_w_full().flex().flex_col().items_start()
            .rounded(4).border_1().border_color(t.raised).focus((s) => s.border_color(t.foreground)).text_color(t.foreground).underline()
            .child(div().line_height(1.4).child(`card ${blocker}, ${floorTitle(found.title)}`));
        return h_flex().flex_wrap().items_center().gap(4).child("Blocked: waits for").child(what).child("to merge first.");
      }))
      .when(next, (el) => el.child(mutedLine(t, "Skipped until these blockers merge.")));
  }

  // The Board's lines and columns: problem lines, a line for each card in a column the Board has no place for, then the
  // five columns. A board the view cannot draw is the line naming why, never empty columns.
  boardLines(cache, t) {
    const { board, cause } = this.shownBoard(cache);
    const problems = this.boardProblems(cache, board).map((text) => problemLine(t, `Problem: ${text}`));
    // With no entry for its project, the machine-wide lines that follow are what explain it.
    if (cause === NO_BOARD) return [boardNotes([problemLine(t, cause), ...problems])];
    if (cause !== null) return [boardNotes([...problems, problemLine(t, cause)])];
    const orderIssue = orderCause(board);
    const ordered = orderIssue === null;
    const places = { backlog: [], ready: [], progress: [] };
    const unplaced = [];
    for (const card of board.cards) {
      const place = boardColumn(card);
      if (place === null) unplaced.push(problemLine(t, `Card ${floorRef(card.card)} is in ${card.column}, which has no column here`));
      else places[place].push(card);
    }
    const needs = cache.items.filter((item) => TIERS.includes(item.category) && item.repository === this.repository);
    // Cards or sources not read may hide waiting items, so Needs you claims no count and no empty line then.
    const incomplete = problems.length > 0 || (board.waitsOnUnread ?? []).length > 0 || board.cards.some((card) => card.unread !== undefined);
    const columns = {
      needs: {
        count: incomplete ? null : needs.filter((item) => !this.marks.has(versioned(item))).length,
        list: needs.map((item) => this.needsEntry(t, item)),
        ...(incomplete ? { notice: problemLine(t, NEEDS_INCOMPLETE), empty: null } : {}),
      },
      backlog: { count: places.backlog.length, list: places.backlog.map((card) => this.boardCard(t, board, card, null, ordered)) },
      ready: { count: places.ready.length, list: places.ready.map((card, index) => this.boardCard(t, board, card, ordered ? index + 1 : null, ordered)),
        notice: ordered ? null : problemLine(t, `Order not read: ${orderIssue}`) },
      progress: { count: places.progress.length, list: places.progress.map((card) => this.boardCard(t, board, card, null, ordered)) },
      merged: this.mergedColumn(t, board),
    };
    const noMoves = board.moves === false ? MOVES_NOT_GITHUB : board.moves === undefined ? MOVES_OLD_READER : null;
    const oldMarkers = board.moves === true && board.cards.some((card) => card.showFirst === undefined);
    const notes = [...problems, ...seenNotice(t), ...unplaced, ...(noMoves === null ? [] : [mutedLine(t, noMoves)]),
      ...(board.moves === true && board.places !== true ? [mutedLine(t, PLACES_OLD_READER)] : []),
      ...(oldMarkers ? [mutedLine(t, SHOW_FIRST_OLD_READER)] : [])];
    // Backlog and Ready to build follow a dragged card and take its release.
    const drop = (id) => ({ marked: this.drag?.target?.column === id, move: (event, cx) => this.dragOver(id, event, cx),
      release: (_event, cx) => this.dropCard(id, cx) });
    return [
      ...(notes.length === 0 ? [] : [boardNotes(notes)]),
      h_flex().id(`${BOARD_ID}kanban`).flex_1().min_h(0).items_stretch().overflow_x_scrollbar().px(12).py(12).gap(10)
        .children(BOARD_COLUMNS.map((column) => kanbanColumn(t, column, columns[column.id], ["backlog", "ready"].includes(column.id) ? drop(column.id) : null))),
    ];
  }

  // The count of waiting and handled items, and its bar. Handled is the day's count of items handled in this panel,
  // those the read has confirmed included, so it never falls back until the date changes and Undo takes an item out of
  // it; an item arriving later adds to waiting. A problem line keeps the view from saying nothing is waiting, since it may
  // hide items.
  progress(cache, t) {
    const counted = cache.items.filter((item) => WAITING.includes(item.category));
    const quiet = problemTexts(cache).length === 0;
    const waiting = counted.filter((item) => this.handledMark(item) === undefined).length;
    const handled = this.handled.size;
    const total = waiting + handled;
    const percent = total === 0 ? 0 : Math.round((handled / total) * 100);
    return [
      div().child(waiting === 0 && quiet ? "Nothing left waiting on you" : `${waiting} waiting, ${handled} handled`),
      ...(total === 0 ? [] : [Progress.new("fabraik-queue-progress").value(percent).w_full()
        .child(ProgressTrack.new().w_full().h(4).rounded(2).bg(t.selected)
          .child(ProgressIndicator.new().h(4).rounded(2).bg(t.done).w(`${percent}%`).transition("width", 200)))]),
    ];
  }

  // The sheet's body, drawn from the latest read each time: the opening card's detail and the Decisions card of the
  // item that waits on it, or why the read cannot show it. A card's wait is only denied where every source of the answer
  // was read.
  sheetBody(t, cache) {
    return [...this.readLine(t, cache), ...this.sheetDetail(t, cache)];
  }

  // The line above the earlier read where the loaded read is not one begun at or after the opening: reading, failed, a
  // read begun before the opening that finished last, or a read time the panel cannot trust.
  readLine(t, cache) {
    const began = cache === null ? null : readStart(cache);
    if (began !== null && began >= /** @type {number} */ (this.sheetOpenedAt)) return [];
    if (this.refreshing || this.refreshAgain) {
      return [mutedLine(t, "Reading this card's current state. Until that read lands, this is the earlier read.")];
    }
    if (this.refreshFailure !== null) return [problemLine(t, `Current state not read: ${this.refreshFailure}. This is the earlier read.`)];
    if (cache === null) return [];
    return [problemLine(t, began === null
      ? "Current state not confirmed: this read gives no start time the panel can trust."
      : "Current state not read: a read begun before this sheet opened finished last. Reopen the sheet to read again; this is the earlier read.")];
  }

  sheetDetail(t, cache) {
    const { repository, card: number } = this.opener;
    const { board, card, cause } = this.openerCard();
    if (cause !== undefined) return [problemLine(t, cause)];
    if (card === undefined) {
      return [div().child(`Not on the board now: this read lists no open card ${floorRef(number)} in ${folderName(repository)}, so it has closed or left the board`)];
    }
    const { ties, programs, terminalsUnread } = this.floorAgents(cache.boards.filter(isProject));
    const { stage, agent, program, light } = stagedCard(board, card, { ties, programs });
    const detailsUnread = card.unread !== undefined;
    const waitsUnread = board.waitsOnUnread ?? [];
    const coordinator = coordinatorStatus(board);
    const blocked = blockedNote(card);
    const { outcome, claim } = card;
    /** @type {string | null} */
    let unmatched = null;
    if (!detailsUnread && AGENT_STAGES.includes(stage) && agent === undefined) {
      if (ties === null) unmatched = `Agent state not read: ${terminalsUnread}`;
      else if (card.worktree === undefined) {
        unmatched = waitsUnread.includes("worktrees") ? "Agent not matched: the worktree list was not read"
          : "Agent not matched: this project's queue reader predates worktree reading";
      }
    }
    const outcomeLines = detailsUnread ? [problemLine(t, `Details not read: ${card.unread}`)]
      : outcome === undefined ? [problemLine(t, "Outcome not read: this project's queue reader predates it")]
      : outcome === null ? [mutedLine(t, "No What to build section in the card text")]
      : typeof outcome.unread === "string" ? [problemLine(t, `Outcome not read: ${outcome.unread}`)]
      : [div().child(outcome.text), ...(outcome.more ? [mutedLine(t, "The card text goes on past this paragraph.").text_size(12)] : [])];
    const stageLine = this.view === "board" ? `Column: ${card.column ?? "none"}`
      : stage === null ? `Not on the Floor now: the card ${card.column === null ? "has no column" : `is in ${card.column}`}`
      : `Stage: ${/** @type {{ label: string }} */ (STAGES.find(({ id }) => id === stage)).label}${stage === "building" && card.column === "In review" ? ", merging" : ""}`;
    const agentLine = agent ? `${program.name}: ${AGENT_LINES.get(agent.report?.state ?? null)}`
      : claim ? `Claimed on ${claim.machine}${claim.runtime ? ` in ${claim.runtime}` : ""}` : "Not claimed";
    const item = cache.items.find((found) => found.repository === repository && found.card === number && TIERS.includes(found.category));
    return [
      div().text_size(16).font_semibold().line_height(1.3).child(floorTitle(card.title)),
      v_flex().gap(6).children(outcomeLines),
      v_flex().gap(6)
        .child(div().child(stageLine))
        .children(this.view === "board" ? this.sheetShowFirst(t, board, card) : [])
        .child(blocked ? div().border_l(2).border_color(t.idle).pl(6).child(blocked) : mutedLine(t, "No open blockers"))
        .child(coordinatorLine(t, coordinator))
        .children(detailsUnread ? [] : [
          mutedLine(t, agentLine),
          ...(unmatched === null ? [] : [problemLine(t, unmatched)]),
          ...(light ? [div().font_semibold().border_l(2).border_color(t[light.role]).pl(6).child(light.label)] : []),
          ...(waitsUnread.length === 0 ? [] : [problemLine(t, `What cards wait on not read: ${waitsUnread.join(", ")}`)]),
          ...(light || waitsUnread.length > 0 || unmatched !== null ? [] : [mutedLine(t, "Nothing here waits on you")]),
        ]),
      ...(item === undefined ? [] : [this.decisionCard(item, t)]),
    ];
  }

  // A Board card sheet's Show me first, under its stage line: the card's switch, or the line in its place, then the card's
  // refused or written line. The switch is off while a Board write runs or its line shows, never for the open sheet.
  sheetShowFirst(t, board, card) {
    const key = `${board.repository}#${card.card}`;
    const { toggle, lines } = this.showFirstSlot(t, SHEET_SHOW_FIRST_ID, board, card, this.boardMove !== null || this.boardMoved !== null, true);
    const failure = this.boardFailures.get(key);
    return [
      ...(toggle === null ? [] : [h_flex().child(toggle)]),
      ...lines,
      ...(failure === undefined ? [] : [problemLine(t, failure).text_size(12)]),
      ...(this.boardMoved?.key === key ? [mutedLine(t, this.boardMoved.line).text_size(12)] : []),
    ];
  }

  // The merge sheet's Mark as seen control, or the muted word once the merge is seen.
  seenControl(t) {
    const { repository, sha } = this.opener;
    return isUnseen(repository, sha)
      ? controlButton(t, SHEET_SEEN_ID, "Mark as seen", (_event, cx) => { this.takeKeyboardInSheet(); markSeen(repository, [sha]); cx.notify(); })
      : mutedLine(t, "Seen").h(24).flex().items_center().px(8);
  }

  // A merge sheet's footer, a row below its scrolling body so its controls stay in view: Try again and the seen control
  // where the report was not read, the seen control alone for a direct change, the seen control and the pull request's
  // link for a report; null while the report is being looked for or read.
  reportFooter(t) {
    const { checking, reading, failure, report } = /** @type {ReportState} */ (this.report);
    if (checking || reading) return null;
    const row = h_flex().flex_none().flex_wrap().gap(6).px(16).py(12).border_t(1).border_color(t.border);
    if (failure !== undefined) {
      return row
        .child(controlButton(t, SHEET_TRY_ID, "Try again", (_event, cx) => { this.takeKeyboardInSheet(); this.readReport(cx); }))
        .child(this.seenControl(t));
    }
    if (report.direct) return row.child(this.seenControl(t));
    const { pull } = report;
    return row.child(this.seenControl(t))
      .child(controlButton(t, SHEET_PULL_ID, `Open pull request #${pull.number}`, (_event, cx) => cx.open_url(pull.url)));
  }

  // A merge sheet's body: nothing while the kept report is looked for, the line saying its report is being read, or why
  // it was not; or the report, a group at a time in the owner's order, a field the reader could not read named in its
  // group's place.
  reportBody(t) {
    const { checking, reading, failure, report } = /** @type {ReportState} */ (this.report);
    if (checking) return [];
    if (reading) return [mutedLine(t, "Reading this merge's report")];
    if (failure !== undefined) return [problemLine(t, `Report not read: ${failure}`)];
    if (report.direct) return [mutedLine(t, "No report: this change went to main without a pull request.")];
    const { pull, card, changed, checks, noScreen, outcome, screenshots } = report;
    const group = (...children) => v_flex().gap(6).children(children);
    const heading = (text) => div().text_size(13).font_semibold().child(text);
    const notRead = (name, unread) => problemLine(t, `${name} not read: ${unread}`);
    const reasons = {
      nothing: () => [report.level === "on-screen" ? REPORT_ON_SCREEN : REPORT_WHEN_NEEDED,
        noScreen ? "It says it has no visual change." : "It shows its screenshots.", ...REPORT_NOTHING_NEEDED],
      waited: () => [report.waiting],
      disagrees: () => [`Not known: its write-up holds ${report.holds.join("; ")} and its card has no Waiting for you comment.`],
    };
    const zoomSetting = settings().zoom;
    const zoom = Number.isFinite(zoomSetting) && zoomSetting > 0 ? zoomSetting : 1;
    const shot = (entry, at) => {
      const name = `Screenshot ${/^screenshot-(\d+)/.exec(entry.alt)?.[1] ?? at + 1}`;
      return entry.unread === undefined ? group(div().child(name), (this.shotWidth === null ? image(entry.path).w_full() : image(entry.path).w(this.shotWidth / zoom)).max_h(SHOT_MAX_HEIGHT)) : notRead(name, entry.unread);
    };
    return [
      ...(outcome === "unread" ? [] : [h_flex().child(roleChip(t, t[outcome === "disagrees" ? "blocked" : "done"], REPORT_CHIPS[outcome]))]),
      div().text_size(16).font_semibold().line_height(1.3).child(isUnreadField(card) ? pull.title : card.title),
      isUnreadField(changed) ? notRead("What changed", changed.unread)
        : isPlainField(changed) ? group(heading("What changed"), mutedLine(t, PLAIN_NOTE),
          ...changed.plain.split("\n").map((line) => div().child(line)))
        : group(heading("What changed"), TextView.markdown(`queue-report-changed-${report.sha}`, changed).on_link_click((url, cx) => cx.open_url(url))),
      outcome === "unread" ? notRead("Why it did not wait", report.cause)
        : group(heading(outcome === "waited" ? "Why it waited" : "Why it did not wait"), ...reasons[outcome]().map((line) => div().child(line))),
      ...(noScreen
        ? [group(mutedLine(t, "No visual change"), ...(isUnreadField(checks) ? [notRead("Test results", checks.unread)]
          : [heading("Test results"), ...checks.map((line) => div().child(line))]))]
        : screenshots.length === 0 ? [notRead("Screenshots", "it shows no screenshot, and its Evidence section has no line saying no visual change")] : [v_flex().id(SHEET_SHOTS_ID).gap(8).on_size_change(({ width }, cx) => { if (width !== this.shotWidth) { this.shotWidth = width; cx.notify(); } }).children(screenshots.map(shot))]),
    ];
  }

  // The side sheet of a card or a merge over a shade on the rest of the view. A press outside it closes it, and the
  // controls beneath that open a sheet are inert while it is open, so a press on the shade opens nothing.
  sheet(t, cache, readAge) {
    const { repository, card, sha, at } = this.opener;
    const merge = sha !== undefined;
    const footer = merge ? this.reportFooter(t) : null;
    const heading = merge ? `${folderName(repository)} merge ${sha.slice(0, 7)}` : `${folderName(repository)} card ${floorRef(card)}`;
    return [
      div().absolute().inset_0().bg(t.chrome + SHADE_ALPHA),
      v_flex().id(SHEET_ID).absolute().top(0).right(0).bottom(0).w(SHEET_WIDTH).max_w(SHEET_MAX_WIDTH)
        .overflow_hidden().role("dialog").accessibility_label(heading)
        .track_focus(this.sheetFocus)
        .key_context(SHEET_CONTEXT)
        .on_action(SHEET_NEXT, (_event, cx) => { this.moveInSheet(false); cx.stop_propagation(); })
        .on_action(SHEET_PREV, (_event, cx) => { this.moveInSheet(true); cx.stop_propagation(); })
        // Esc here closes the sheet alone: it stops before the view's root, which would close the overlay beneath.
        .on_key_down((event, cx) => {
          if (event.key !== "escape") return;
          this.closeSheet(cx);
          cx.stop_propagation();
        })
        .on_mouse_down_out((_event, cx) => this.closeSheet(cx))
        // A first appearance is not a transition's later change, so the sheet is drawn off the edge first and moved
        // after the wait, and only the opening that started a wait may end it.
        .child(v_flex().id(SHEET_PANEL_ID).relative().size_full().bg(t.surface).border_l(1).border_color(t.border)
          .left(this.sheetEntering ? SHEET_WIDTH : 0).transition("left", { duration: SLIDE_MS, easing: "ease-out" })
          .child(h_flex().flex_none().px(16).py(12).gap(8).justify_between().items_start().border_b(1).border_color(t.border)
            .child(v_flex().min_w(0).gap(2)
              .child(div().text_size(14).font_semibold().truncate().child(heading))
              .when(merge, (el) => el.child(mutedLine(t, `merged at ${clock(at)}`).text_size(12)))
              .when(!merge && Boolean(cache), (el) => el.child(readAge().text_size(12))))
            .child(controlButton(t, SHEET_CLOSE_ID, "Close", (_event, cx) => this.closeSheet(cx)).track_focus(this.sheetClose)))
          .child(v_flex().id(SHEET_BODY_ID).flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(12).text_size(13)
            .line_height(1.45).children(merge ? this.reportBody(t) : this.sheetBody(t, cache)))
          .when(footer !== null, (el) => el.child(footer))
          .child(div().id(SHEET_END_ID).track_focus(this.sheetEnd).tab_stop(true))),
    ];
  }

  // Selects the space, tab and pane of the session `agent`.
  goTo(agent) {
    run("space.select", { id: agent.space });
    run("tab.select", { id: agent.tab });
    run("pane.focus", { terminal: agent.address });
  }

  goControl(t, agent) {
    return controlButton(t, `fabraik-queue-go-${agent.address}`, "Open", () => this.goTo(agent))
      .accessibility_label(`Open ${agent.program.name} in ${agent.space_name}, ${agent.tab_name}`);
  }

  // The latest waiting menu the session at `address` asked, if any.
  askOf(address) {
    return (this.menus?.items ?? []).filter((item) => item.terminal === address)
      .reduce((latest, item) => (latest === undefined || item.askedAt > latest.askedAt ? item : latest), undefined);
  }

  // What a Needs you card draws under its name: the receipt of its handled ask, else its ask's detail above its answers,
  // else the line sending the owner to its tab. An ask that cannot be drawn is one problem line in its place.
  askLines(t, ask) {
    if (ask === undefined) return [mutedLine(t, "Answer in its tab")];
    try {
      const mark = this.handledMark(ask);
      if (mark) return [this.receipt(ask, mark, t)];
      const { lines, buttons } = this.responses(ask, t);
      const refused = this.failures.get(ask.key);
      return [
        ...this.menuDetail(ask, t),
        ...lines,
        ...(refused ? [problemLine(t, refused)] : []),
        ...(buttons.length > 0 ? [h_flex().flex_wrap().gap(6).children(buttons)] : []),
      ];
    } catch (error) {
      return [problemLine(t, `${cardRef(ask)} cannot be read: ${oneLine(/** @type {{ message?: string } | null} */ (error)?.message ?? error)}`)];
    }
  }

  // A blocked session's card: the blocked marker bar, its program, its project and tab, Open, and what answers it.
  needsCard(t, agent) {
    return h_flex().w_full().items_stretch().rounded(10).bg(t.raised).border_1().border_color(t.border).overflow_hidden()
      .child(div().flex_none().w(3).bg(t.blocked))
      .child(v_flex().flex_1().min_w(0).px(12).py(10).gap(6)
        .child(h_flex().w_full().justify_between().items_start().gap(8)
          .child(v_flex().min_w(0)
            .child(div().text_size(13.5).child(agent.program.name))
            .child(div().text_size(12).text_color(t.muted).child(`${agent.space_name}, ${agent.tab_name}`)))
          .child(this.goControl(t, agent)))
        .children(this.askLines(t, this.askOf(agent.address))));
  }

  runningLine(t, agent) {
    return h_flex().w_full().items_center().gap(8)
      .child(div().flex_none().size(6).rounded(3).bg(t.working))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${agent.program.name}, ${agent.space_name}, ${agent.tab_name}`))
      .child(this.goControl(t, agent));
  }

  // The inbox's lines: why waiting menus or sessions could not be read, then Needs you and Running. Needs you is not drawn
  // empty while a session is unreadable, since that session may need the owner. A change in the blocked
  // sessions since the last read of the waiting menus reads them again, since an ask is answerable only once its session is
  // blocked; Herdr's next and previous agent follow the drawn order.
  inboxLines(t, { blocked, running, unreadable }, cx) {
    if (this.menusBlocked !== null && blockedKey(blocked) !== this.menusBlocked) this.readAsks(cx);
    setAgentOrder([...blocked, ...running].map((agent) => agent.address));
    const heading = (text) => div().font_semibold().child(text);
    return [
      ...(this.menusFailure ? [problemLine(t, `Waiting menus unread: ${this.menusFailure}`)] : []),
      ...(this.watchFailure ? [problemLine(t, `Waiting menus unread: ${this.watchFailure}`)] : []),
      ...(this.menus?.problems ?? []).map((text) => problemLine(t, text)),
      ...(this.state.kind === "unreadable" ? [problemLine(t, `Queue cache unreadable: ${this.state.error}`)] : []),
      ...(unreadable > 0 ? [problemLine(t, `Herdr reported ${plural(unreadable, "session")} this panel cannot read`)] : []),
      ...(blocked.length === 0 && unreadable > 0 ? [] : [v_flex().gap(8).child(heading("Needs you"))
        .children(blocked.length === 0 ? [mutedLine(t, `Nobody needs you. ${running.length} running.`)] : blocked.map((agent) => this.needsCard(t, agent)))]),
      ...(running.length === 0 ? [] : [v_flex().gap(8).child(heading("Running")).children(running.map((agent) => this.runningLine(t, agent)))]),
    ];
  }

  render(cx) {
    const t = theme();
    const cache = this.state.kind === "read" ? this.state.cache : null;
    const readAge = () => div().text_color(t.muted).child(stamp("Read", cache.refreshedAt));
    const failures = [
      ...(this.refreshFailure ? [problemLine(t, `Refresh failed: ${this.refreshFailure}`)] : []),
      ...(this.clearFailure ? [problemLine(t, `Clear failed: ${this.clearFailure}`)] : []),
    ];
    // Every view's root takes the keys keyDown handles and the presses rootPress does.
    const page = v_flex().id("fabraik-queue").size_full().min_h(0).bg(t.surface).text_color(t.foreground).relative()
      .track_focus(this.focusHandle).on_key_down((event, cx) => this.keyDown(event, cx))
      .on_mouse_down("left", (event, cx) => this.rootPress(event, cx));
    // An overlay view keeps its header, and so its Close, before any read loads.
    const headed = cache !== null || this.overlay !== null;
    // The controls that open the sheet record whether the one that opened it is drawn, for focus to go back to.
    this.returnDrawn = false;
    // The Floor's controls are its card and merged tiles, which open the side sheet, its Open board controls, an overlay's
    // Close and the sheet's own; its keys are Esc and Tab and Shift+Tab, which the sheet keeps inside itself. c clears
    // the digest, which the Floor does not draw.
    if (this.view === "floor") {
      return page
        .when(headed, (el) => el.child(h_flex().flex_none().px(20).py(12).gap(20).justify_between().items_center()
          .border_b(1).border_color(t.border)
          .child(div().min_w(0).text_size(13).text_color(t.muted).child("Coloured cards need you."))
          .child(this.headerEnd(t, cache, readAge))))
        .child(v_flex().flex_1().min_h(0).px(20).pt(12).gap(8).text_size(13).line_height(1.35)
          .children(failures).children(this.body(t)))
        .when(this.sheetOpen, (el) => el.children(this.sheet(t, cache, readAge)));
    }
    // The Board's controls open the side sheet, as the Floor's tiles do, and its strip's last control opens Decisions;
    // it has the Floor's keys.
    if (this.view === "board") {
      const lines = cache ? [] : this.body(t);
      return page
        .when(headed, (el) => el.child(this.boardHeader(t, cache, readAge)))
        .when(Boolean(cache), (el) => el.children(this.boardStrip(t, cache)))
        // The Board follows the pointer through a drag. A release over Backlog or Ready to build reaches that column first,
        // which ends the drag; any other release, Esc, a press other than the one that began it, as after a release the
        // Board never saw, and a press outside the Board end it with no move.
        .on_mouse_move((event, cx) => this.dragPointer(event, cx))
        .on_mouse_up("left", (_event, cx) => this.endDrag(cx))
        .on_mouse_down_out((_event, cx) => this.endDrag(cx))
        .child(v_flex().flex_1().min_h(0).text_size(13).line_height(1.35)
          .when(failures.length + lines.length > 0, (el) => el.child(boardNotes([...failures, ...lines])))
          .children(cache ? this.body(t) : []))
        .when(this.sheetOpen, (el) => el.children(this.sheet(t, cache, readAge)));
    }
    // The Decisions view draws the sheet of a merge over its own controls, which it leaves inert.
    if (this.view === "decisions") {
      const progress = cache ? this.progress(cache, t) : [];
      return page
        .when(headed, (el) => el.child(h_flex().flex_none().px(20).py(12).gap(20).justify_between().items_start()
          .border_b(1).border_color(t.border)
          .child(v_flex().flex_1().min_w(0).max_w(420).gap(6).text_size(13).children(progress))
          .child(this.headerEnd(t, cache, readAge))))
        .child(v_flex().id("fabraik-queue-list").flex_1().min_h(0).overflow_y_scrollbar()
          .child(v_flex().w_full().max_w(760).mx_auto().pt(16).px(20).pb(32).gap(24).text_size(13).line_height(1.45)
            .children(failures).children(this.body(t))))
        .when(this.sheetOpen, (el) => el.children(this.sheet(t, cache, readAge)));
    }
    const viewControl = (view, label) => controlButton(t, `fabraik-queue-open-${view}`, label, () => openView(view));
    const inbox = inboxAgents();
    return page
      .child(h_flex().flex_none().px(12).py(10).gap(8).justify_between().items_center()
        .child(h_flex().min_w(0).items_center().gap(8)
          .child(div().text_size(13.5).font_semibold().child("Inbox"))
          // No zero count while a session is unreadable, since that session may need the owner.
          .when(inbox.blocked.length > 0 || inbox.unreadable === 0, (el) => el.child(mutedLine(t, `${inbox.blocked.length} need you`))))
        .child(h_flex().items_center().gap(8)
          .child(viewControl("decisions", "Decisions"))
          .child(viewControl("floor", "Floor"))))
      .child(v_flex().id("fabraik-queue-list").flex_1().min_h(0).overflow_y_scrollbar().px(10).pb(12).gap(16)
        .children(this.inboxLines(t, inbox, cx)));
  }
}
