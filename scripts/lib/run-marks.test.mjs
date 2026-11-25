// Tests for the run marks a desktop app card session carries as lines of its first message.
// A sidebar card session's mark is a whole line of its first message, the first user entry of its saved conversation
// that is not meta. The entries follow the shape an app session was observed to write: queue operations first, and a
// first message that opens with the app's reminder and ends with text the app appends after the start prompt.
// Recurring cost: pure calls, no subprocess. Remove if the sidebar run route is retired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionRunMarks, transcriptRunMarks } from './run-marks.mjs';

const transcriptLines = (...entries) => entries.map((entry) => `${typeof entry === 'string' ? entry : JSON.stringify(entry)}\n`).join('');
const userEntry = (content, extra = {}) => ({ type: 'user', ...extra, message: { role: 'user', content } });
const START = '2026-11-04T12:00:00Z';
const MARK_LINE = `PRE_APPROVED_RUN_SESSION=${START}`;
const QUEUED_MARK = { type: 'queue-operation', operation: 'enqueue', content: `Continue the run.\n${MARK_LINE}` };
const MARKED = { preApprovedStart: START };
const NO_RUN_MARK = { preApprovedStart: undefined };
const readWhole = (text) => transcriptRunMarks(text, { complete: true });

test('ANTI-REGRESSION: a run mark is read only from a whole line of the first message of the session', () => {
  const otherStart = '2026-11-05T09:30:00Z';
  // The meta entry is not the first message, whichever of the two holds the mark.
  assert.deepEqual(readWhole(transcriptLines(QUEUED_MARK, userEntry('Caveat.', { isMeta: true }), userEntry(`Continue the run.\n${MARK_LINE}`))), MARKED);
  assert.deepEqual(readWhole(transcriptLines(QUEUED_MARK, userEntry(MARK_LINE, { isMeta: true }), userEntry('Continue the run.'))), NO_RUN_MARK);
  // The app's reminder opens the message and its own text follows the prompt, so the mark is neither first nor last.
  const appMessage = (prompt) => `<system-reminder>\nThis session was started from the desktop app.\n</system-reminder>\nYou were started by another session to work one card.\n\n${prompt}\n\nSide-session notes folder: /home/owner/notes/local_0001`;
  assert.deepEqual(readWhole(transcriptLines(userEntry(appMessage(`Continue this exact pre-approved sidebar job.\n${MARK_LINE}`)))), MARKED);
  // Text blocks join with a newline, so a mark block is a whole line, and a list with no text block holds no mark.
  assert.deepEqual(readWhole(transcriptLines(userEntry([{ type: 'text', text: 'Continue the run.' }, { type: 'image', source: {} }, { type: 'text', text: MARK_LINE }]))), MARKED);
  assert.deepEqual(readWhole(transcriptLines(userEntry([{ type: 'image', source: {} }]))), NO_RUN_MARK);
  // A mark the owner types later, in the second message, is not the session's mark.
  assert.deepEqual(readWhole(transcriptLines(userEntry('Continue the run.'), userEntry(MARK_LINE))), NO_RUN_MARK);
  // A quoted launch line and a mention are not the mark line, and the retired product manager mark is no mark.
  for (const mention of [
    `${MARK_LINE} claude -p --permission-mode auto "Continue the pre-approved run."`,
    `The run marks a session with ${MARK_LINE} in its prompt.`,
    `\`${MARK_LINE}\``,
    'PRODUCT_MANAGER_RUN_SESSION=1',
  ]) {
    assert.deepEqual(readWhole(transcriptLines(userEntry(`Continue the run.\n${mention}`))), NO_RUN_MARK, mention);
  }
  // Two different starts join into one value, which is no run start publishCheck admits.
  const twoStarts = readWhole(transcriptLines(userEntry(`${MARK_LINE}\nPRE_APPROVED_RUN_SESSION=${otherStart}`)));
  assert.deepEqual(twoStarts, { preApprovedStart: `${START} ${otherStart}` });
});

test('ANTI-REGRESSION: a transcript whose first message cannot be read is named unreadable, never read as unmarked', () => {
  const NOT_AN_OBJECT = { unreadable: 'its transcript holds a line that is not a JSON object before its first message' };
  const NEITHER = { unreadable: 'its first message is neither text nor a list of blocks' };
  // Before the end of the file a missing first message, or a first line still being written, is pending.
  const queuedOnly = transcriptLines(QUEUED_MARK);
  assert.deepEqual(transcriptRunMarks(queuedOnly, { complete: false }), { pending: true });
  assert.deepEqual(transcriptRunMarks(queuedOnly, { complete: true }), { unreadable: 'its transcript holds no first message' });
  const partFirst = `${queuedOnly}${JSON.stringify(userEntry(`Continue the run.\n${MARK_LINE}`)).slice(0, 40)}`;
  assert.deepEqual(transcriptRunMarks(partFirst, { complete: false }), { pending: true });
  assert.deepEqual(transcriptRunMarks(partFirst, { complete: true }), NOT_AN_OBJECT);
  // A line before the first message that is not a JSON object hides what it held.
  assert.deepEqual(readWhole(transcriptLines('{"type":"user","message":', userEntry('Continue the run.'))), NOT_AN_OBJECT);
  assert.deepEqual(readWhole(transcriptLines('null', userEntry('Continue the run.'))), NOT_AN_OBJECT);
  // A first message whose content is neither text nor a list of blocks.
  assert.deepEqual(readWhole(transcriptLines(userEntry({ text: MARK_LINE }))), NEITHER);
  assert.deepEqual(readWhole(transcriptLines({ type: 'user' })), NEITHER);
});

test('ANTI-REGRESSION: a session whose conversation is saved in several project folders is a run session where any copy carries a run mark, and unreadable where none does and one cannot be read', (t) => {
  const config = mkdtempSync(join(tmpdir(), 'run-marks-'));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  const id = '0d5c1a3e-session';
  const save = (folder, text) => {
    mkdirSync(join(config, 'projects', folder), { recursive: true });
    writeFileSync(join(config, 'projects', folder, `${id}.jsonl`), text);
  };
  const read = () => sessionRunMarks({ CLAUDE_CODE_SESSION_ID: id, CLAUDE_CONFIG_DIR: config });
  const marked = transcriptLines(userEntry(`Continue this exact pre-approved sidebar job.\n${MARK_LINE}`));
  // The unmarked copy sorts first, so a reader that stops at the first copy found misses the mark.
  save('a-copy', transcriptLines(userEntry('Continue the run.')));
  assert.deepEqual(read(), NO_RUN_MARK);
  save('z-active', marked);
  assert.deepEqual(read(), MARKED);
  // The same start in two copies is one start; an unreadable copy beside a marked one leaves the mark standing.
  save('b-copy', marked);
  save('c-broken', 'null\n');
  assert.deepEqual(read(), MARKED);
  // With no marked copy, a copy that cannot be read is never read as unmarked.
  rmSync(join(config, 'projects', 'z-active'), { recursive: true });
  rmSync(join(config, 'projects', 'b-copy'), { recursive: true });
  assert.deepEqual(read(), { unreadable: 'its transcript holds a line that is not a JSON object before its first message' });
});
