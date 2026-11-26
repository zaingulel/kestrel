// owner-menu.mjs: the owner-menu hook's logic, which .claude/hooks/owner-menu.mjs runs on Claude Code's PermissionRequest and,
// for AskUserQuestion and ExitPlanMode, PostToolUse events. It acts only in a job a Herdr coordinator started, marked by
// FABRAIK_COORDINATED_JOB=1 with PRE_APPROVED_RUN_CARD and HC_TERMINAL_ID set; anywhere else it does nothing.
//
// PermissionRequest records the ask as `ask.json` in its own folder `<Herdr home>/data/fabraik-asks/<terminal>/<askId>/` and
// waits for `answer.json`, which the queue panel or the coordinator writes there. Every ask records the job's main checkout
// as `repository`, or why it could not be read as `repositoryUnread`. A permission ask records `whole`, true only where its
// `input` is the uncut command of a Bash call or url of a WebFetch call and its one-line display is that text exactly, with
// no newline, tab or doubled space, and records a call whose uncut text holds a
// credential-looking token, cut or not, as words saying so instead. A valid answer for this ask becomes the decision Claude Code receives, after
// `taken.json` records the take; an invalid one, an allow of a permission call the panel did not show whole included, is set aside as `rejected.json`
// and the wait goes on. The wait ends with no decision, so the menu stays the tab's, when PostToolUse wrote `end.json`, a
// newer ask of the terminal supersedes it, the terminal is no longer blocked or the time is up. A question or plan hook never
// writes "delivered": only PostToolUse, which sees what Claude received, writes that end. A permission, which no PostToolUse
// follows, gets its delivered end from its own hook just before it prints its decision.
//
// PostToolUse ends the newest open ask whose questions or plan this call carries by writing its `end.json`. No answer it
// sees is recorded as approval: a Herdr job's merge waits only on its card's show-me-first marker.
//
// Seams: `env` (the marks and HERDR_APP_HOME), `git(args)` (git in the job worktree, returning stdout), `hc(args)` (resolving
// `{ code, stdout, stderr }`), `now()` (milliseconds) and `sleep(ms)`.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { REPLY_MAX, redact, savedIdentity } from './merge-evidence.mjs';

export const APPROVE_LABEL = 'Yes, deliver';

// The choices of a permission prompt and of a plan, approving choice first.
const PERMISSION_LABELS = ['Allow once', 'Deny'];
const PLAN_LABELS = ['Approve plan', 'Keep planning'];
const DENIED = 'The owner denied this from the queue panel.';
const KEEP_PLANNING = 'The owner asked to keep planning.';
// The queue panel's credential refusal, owner-queue.mjs's CREDENTIAL_REPLY, which it does not export.
const CREDENTIAL = 'it looks like it holds a credential';
const NOT_WHOLE = 'the panel did not show this call whole, so it cannot allow it';
const DELIVERED = { reason: 'delivered', via: 'panel' };
// The hook's own wait limit, the `timeout` .claude/settings.json gives it.
const WAIT_LIMIT_MS = 86_400_000;
const LOOK_MS = 1000;
const STATUS_MS = 5000;
const ASK_MAX = 1024 * 1024;
const ANSWER_MAX = 64 * 1024;
const TERMINAL_NAME = /^[A-Za-z0-9_-]+$/;
const CARD_NUMBER = /^[1-9]\d*$/;

// The object the hook prints, or undefined where it prints nothing. It is Claude Code's hook output document, typed as any
// because its shape is Claude Code's, which a caller reads by its event's fields.
/** @returns {Promise<any>} */
export async function ownerMenu(input, { env, git, hc, now, sleep }) {
  const card = env.PRE_APPROVED_RUN_CARD;
  const terminal = env.HC_TERMINAL_ID;
  if (env.FABRAIK_COORDINATED_JOB !== '1' || !CARD_NUMBER.test(card ?? '') || !TERMINAL_NAME.test(terminal ?? '')) return undefined;
  if (!input || typeof input !== 'object' || typeof input.cwd !== 'string' || !input.tool_input || typeof input.tool_input !== 'object') return undefined;
  const store = join(resolve(env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app')), 'data', 'fabraik-asks', terminal);
  const context = { card, terminal, store, git, hc, now, sleep };
  if (input.hook_event_name === 'PermissionRequest') return awaitAnswer(input, context);
  if (input.hook_event_name === 'PostToolUse' && ['AskUserQuestion', 'ExitPlanMode'].includes(input.tool_name)) return endAsk(input, context);
  return undefined;
}

// --- The ask -------------------------------------------------------------------------------------------------------

const kindOf = (toolName) => (toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'permission');

// Whether `questions` is AskUserQuestion's list: each with question text, a header, a multiSelect flag and labelled options.
const wellFormed = (questions) => Array.isArray(questions) && questions.length > 0 && questions.every((q) => q && typeof q.question === 'string'
  && typeof q.header === 'string' && typeof q.multiSelect === 'boolean' && Array.isArray(q.options) && q.options.length > 0
  && q.options.every((option) => option && typeof option.label === 'string'))
  && new Set(questions.map((q) => q.question)).size === questions.length;

// The deliver question of `questions`: undefined where none offers APPROVE_LABEL (an ordinary menu), `{ question }` for the one
// single-choice question that does with no repeated choice, or `{ cause }` saying why the menu is no deliver question whose
// version the hook can capture.
function deliverQuestion(questions) {
  const offering = questions.filter((q) => q.options.some((option) => option.label === APPROVE_LABEL));
  if (offering.length === 0) return undefined;
  if (offering.length === 1 && !offering[0].multiSelect) {
    const labels = offering[0].options.map((option) => option.label);
    if (new Set(labels).size < labels.length) return { cause: 'the deliver question must not repeat a choice' };
    return { question: offering[0] };
  }
  return { cause: `the menu must hold exactly one single-choice question offering "${APPROVE_LABEL}"` };
}

// The version the job shows the owner now: its HEAD and the identity of its saved card there.
function currentVersion({ card, git }, cwd) {
  const head = git(['rev-parse', '--verify', 'HEAD']).trim();
  return { head, identity: savedIdentity(card, cwd, head, git) };
}

// The job's main checkout, the parent folder of its common git folder, or why it could not be read.
function repositoryOf(git) {
  try {
    return { repository: dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) };
  } catch (error) {
    return { repositoryUnread: /** @type {Error} */ (error).message.slice(0, REPLY_MAX) };
  }
}

// What an ask records of the tool call `toolName` made with `toolInput`, by kind.
function askContent(kind, toolName, toolInput) {
  if (kind === 'question') return { questions: toolInput.questions };
  if (kind === 'plan') return { plan: toolInput.plan };
  const shown = toolName === 'Bash' ? toolInput.command : toolName === 'WebFetch' ? toolInput.url : undefined;
  const summary = String(toolInput.command ?? toolInput.file_path ?? toolInput.url ?? JSON.stringify(toolInput));
  const input = summary.slice(0, REPLY_MAX);
  if (redact(summary) !== summary || redact(input) !== input) return { input: `Not shown here: ${CREDENTIAL}`, whole: false };
  return { input, whole: typeof shown === 'string' && shown === input && input === input.replace(/\s+/g, ' ').trim() };
}

async function awaitAnswer(input, context) {
  const { terminal, store, now, sleep } = context;
  const kind = kindOf(input.tool_name);
  const toolInput = input.tool_input;
  if (kind === 'question' && !wellFormed(toolInput.questions)) return undefined;
  if (kind === 'plan' && typeof toolInput.plan !== 'string') return undefined;
  let version;
  const deliver = kind === 'question' ? deliverQuestion(toolInput.questions) : undefined;
  if (deliver?.cause) version = { versionUnread: deliver.cause };
  else if (deliver) {
    try {
      version = { version: currentVersion(context, input.cwd) };
    } catch (error) {
      version = { versionUnread: /** @type {Error} */ (error).message.slice(0, REPLY_MAX) };
    }
  }
  const id = randomBytes(16).toString('hex');
  const folder = join(store, id);
  mkdirSync(folder, { recursive: true });
  const askedAt = now();
  const ask = { format: 1, id, terminal, pid: process.pid, worktree: input.cwd, card: context.card, kind, toolName: input.tool_name,
    ...askContent(kind, input.tool_name, toolInput), ...version, ...repositoryOf(context.git), askedAt };
  writeAtomic(join(folder, 'ask.json'), `${JSON.stringify(ask)}\n`);

  const started = now();
  let statusAt = started;
  for (;;) {
    await sleep(LOOK_MS);
    if (existsSync(join(folder, 'end.json')) || supersededBy(store, id, askedAt)) return undefined;
    if (now() - statusAt >= STATUS_MS) {
      statusAt = now();
      if (!(await blocked(context))) return undefined;
    }
    if (now() - started >= WAIT_LIMIT_MS) return undefined;
    const answerFile = join(folder, 'answer.json');
    if (!existsSync(answerFile)) continue;
    let decision;
    try {
      decision = decide(ask, toolInput, readCapped(answerFile, ANSWER_MAX));
    } catch (error) {
      writeAtomic(join(folder, 'rejected.json'), `${JSON.stringify({ format: 1, reason: /** @type {Error} */ (error).message })}\n`);
      unlinkSync(answerFile);
      continue;
    }
    writeAtomic(join(folder, 'taken.json'), `${JSON.stringify({ takenAt: now() })}\n`);
    if (kind === 'permission') writeAtomic(join(folder, 'end.json'), `${JSON.stringify(DELIVERED)}\n`);
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
}

// Whether another ask of the terminal was asked after this one; an unreadable one supersedes nothing.
const supersededBy = (store, id, askedAt) => readdirSync(store).some((other) => other !== id && (readAsk(store, other)?.askedAt ?? -Infinity) > askedAt);

// Whether Herdr shows the terminal blocked on the owner; an unreadable status counts as not blocked, which ends the wait.
async function blocked({ hc, terminal }) {
  const reply = await hc(['get', terminal, '--json']);
  try {
    return reply.code === 0 && JSON.parse(reply.stdout).status?.state === 'blocked';
  } catch {
    return false;
  }
}

// --- Answers -------------------------------------------------------------------------------------------------------

// The owner's words as one line, refused as the queue panel refuses a reply.
function replyWords(text) {
  const words = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (words === '' || [...words].length > REPLY_MAX) throw new Error(`an answer's text needs 1 to ${REPLY_MAX} characters`);
  if (redact(words) !== words) throw new Error(CREDENTIAL);
  return words;
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function onlyKeys(record, allowed, what) {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${what} holds keys it may not: ${extra.join(', ')}`.slice(0, REPLY_MAX));
}

// The value Claude receives for question `q` from its answer entry: the chosen labels in option order, then the text.
function joinedAnswer(q, entry) {
  if (!isRecord(entry)) throw new Error(`the answer to "${q.header}" is not a record`);
  onlyKeys(entry, ['choices', 'text'], `the answer to "${q.header}"`);
  const labels = q.options.map((option) => option.label);
  const choices = entry.choices ?? [];
  if (!Array.isArray(choices) || ('choices' in entry && choices.length === 0)) throw new Error(`the choices for "${q.header}" are not a list of labels`);
  if (choices.some((choice) => !labels.includes(choice)) || new Set(choices).size !== choices.length) {
    throw new Error(`the choices for "${q.header}" are not distinct labels it offers`);
  }
  const text = 'text' in entry ? [replyWords(entry.text)] : [];
  if (choices.length + text.length === 0) throw new Error(`"${q.header}" has no choice and no text`);
  if (!q.multiSelect && choices.length + text.length !== 1) throw new Error(`"${q.header}" takes one choice or a text`);
  return [...labels.filter((label) => choices.includes(label)), ...text].join(', ');
}

// The answers Claude receives for a question ask from answer record `record`, keyed by question text.
function questionAnswers(questions, record) {
  if (!isRecord(record.answers)) throw new Error('the answer holds no answers record');
  const texts = questions.map((q) => q.question);
  onlyKeys(record.answers, texts, 'the answers record');
  const missing = texts.filter((text) => !Object.hasOwn(record.answers, text));
  if (missing.length > 0) throw new Error(`the answers record misses ${missing.length} question(s)`);
  return Object.fromEntries(questions.map((q) => [q.question, joinedAnswer(q, record.answers[q.question])]));
}

// The decision answer text `text` gives ask `ask`, whose tool call carried `toolInput`, or throws why it is refused.
function decide(ask, toolInput, text) {
  const record = JSON.parse(text);
  if (!isRecord(record) || record.format !== 1) throw new Error('the answer is not a format 1 record');
  if (record.askId !== ask.id) throw new Error('the answer names another ask');
  if (record.by !== 'panel' && record.by !== 'coordinator') throw new Error('the answer names no panel or coordinator');
  if (ask.kind === 'question') {
    onlyKeys(record, ['format', 'askId', 'by', 'answers'], 'the answer');
    return { behavior: 'allow', updatedInput: { questions: toolInput.questions, answers: questionAnswers(toolInput.questions, record) } };
  }
  onlyKeys(record, ['format', 'askId', 'by', 'choice', 'text'], 'the answer');
  if (('choice' in record) === ('text' in record)) throw new Error('the answer needs exactly one of a choice and a text');
  const [approve, decline] = ask.kind === 'plan' ? PLAN_LABELS : PERMISSION_LABELS;
  if ('text' in record) return { behavior: 'deny', message: replyWords(record.text) };
  if (record.choice === approve) {
    if (ask.kind === 'plan') return { behavior: 'allow', updatedInput: toolInput };
    if (ask.whole !== true) throw new Error(NOT_WHOLE);
    return { behavior: 'allow' };
  }
  if (record.choice === decline) return { behavior: 'deny', message: ask.kind === 'plan' ? KEEP_PLANNING : DENIED };
  throw new Error('the answer\'s choice is not one this menu offers');
}

// --- After the tool ------------------------------------------------------------------------------------------------

async function endAsk(input, context) {
  const { store } = context;
  const toolInput = input.tool_input;
  const { answers, ...asked } = toolInput;
  const matches = (ask) => (input.tool_name === 'AskUserQuestion'
    ? ask.kind === 'question' && isDeepStrictEqual(ask.questions, asked.questions)
    : ask.kind === 'plan' && ask.plan === asked.plan);
  const open = (existsSync(store) ? readdirSync(store) : [])
    .filter((id) => !existsSync(join(store, id, 'end.json')))
    .map((id) => readAsk(store, id))
    .filter((ask) => ask && matches(ask))
    .sort((a, b) => b.askedAt - a.askedAt);
  const ask = open[0];
  if (ask) {
    const folder = join(store, ask.id);
    writeAtomic(join(folder, 'end.json'), `${JSON.stringify(sentByPanel(ask, folder, toolInput, answers) ? DELIVERED : { reason: 'answered in the job\'s tab' })}\n`);
  }
}

// Whether the answer Claude received is the one this ask's hook took from the panel or the coordinator.
function sentByPanel(ask, folder, toolInput, answers) {
  if (!existsSync(join(folder, 'taken.json'))) return false;
  try {
    const sent = decide(ask, toolInput, readCapped(join(folder, 'answer.json'), ANSWER_MAX));
    return ask.kind === 'plan' ? sent.behavior === 'allow' : isDeepStrictEqual(sent.updatedInput?.answers, answers);
  } catch {
    return false;
  }
}

// --- Files ---------------------------------------------------------------------------------------------------------

// The ask record in folder `id` of `store`, or undefined where it is missing, oversized or not an ask.
function readAsk(store, id) {
  try {
    const ask = JSON.parse(readCapped(join(store, id, 'ask.json'), ASK_MAX));
    return isRecord(ask) && ask.format === 1 && ask.id === id && Number.isFinite(ask.askedAt) ? ask : undefined;
  } catch {
    return undefined;
  }
}

function readCapped(path, max) {
  if (statSync(path).size > max) throw new Error(`${path} is over ${max} bytes`);
  return readFileSync(path, 'utf8');
}

// Writes `text` to `path` through a rename, so no reader sees part of it.
function writeAtomic(path, text) {
  const staged = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(staged, text);
  renameSync(staged, path);
}
