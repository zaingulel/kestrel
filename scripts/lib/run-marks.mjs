// The run marks of a Claude Code session: the environment's, and for a session the desktop app started, the ones
// its first message carries as whole lines. A sidebar card session cannot be given an environment, so the run writes
// the mark into the start prompt and every reader of the marks reads it back from the saved conversation.

import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TRANSCRIPT_CHUNK = 1024 * 1024;
export const NO_FIRST_MESSAGE = 'its transcript holds no first message';

// Reads the marks from conversation text, one JSON entry a line. `complete` says the text reaches the end of the
// file; before the end a first message not yet seen is `{ pending: true }`. A first message that cannot be read is
// `{ unreadable: <cause> }`, never unmarked.
export function transcriptRunMarks(text, { complete }) {
  const lines = text.split('\n');
  if (!complete) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Judged with every other line that is no JSON object, just below.
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { unreadable: 'its transcript holds a line that is not a JSON object before its first message' };
    }
    if (entry.type !== 'user' || entry.isMeta === true) continue;
    const content = entry.message?.content;
    const message = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
        : null;
    if (message === null) return { unreadable: 'its first message is neither text nor a list of blocks' };
    const messageLines = message.split('\n').map((messageLine) => messageLine.trimEnd());
    const starts = messageLines.map((messageLine) => /^PRE_APPROVED_RUN_SESSION=(\S+)$/.exec(messageLine)?.[1]).filter(Boolean);
    return { preApprovedStart: starts.length > 0 ? starts.join(' ') : undefined };
  }
  return complete ? { unreadable: NO_FIRST_MESSAGE } : { pending: true };
}

// Reads the marks of the conversation file at `path`, a chunk at a time, stopping at its first message.
export function fileRunMarks(path) {
  let file;
  try {
    file = openSync(path, 'r');
    const chunk = Buffer.alloc(TRANSCRIPT_CHUNK);
    const parts = [];
    for (;;) {
      const read = readSync(file, chunk, 0, TRANSCRIPT_CHUNK, null);
      parts.push(Buffer.from(chunk.subarray(0, read)));
      const marks = transcriptRunMarks(Buffer.concat(parts).toString('utf8'), { complete: read === 0 });
      if (!marks.pending) return marks;
    }
  } catch (err) {
    return { unreadable: `its transcript could not be read (${/** @type {NodeJS.ErrnoException} */ (err).code})` };
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

// Reads the marks of the session `env` names, for a command no hook payload reaches: its conversation is the file
// named by its session id in the project folders under Claude Code's configuration folder. Folder order names no
// copy as the live one, so a mark in any copy stands, and with none a copy that cannot be read is unreadable.
export function sessionRunMarks(env) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!id || /[\\/]/.test(id)) return { unreadable: 'the session names no conversation' };
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  let folders;
  try {
    folders = readdirSync(projects);
  } catch (err) {
    return { unreadable: `its transcript could not be found (${/** @type {NodeJS.ErrnoException} */ (err).code})` };
  }
  const found = folders
    .map((folder) => fileRunMarks(join(projects, folder, `${id}.jsonl`)))
    .filter((marks) => !/\(ENO(?:ENT|TDIR)\)$/.test(marks.unreadable ?? ''));
  const starts = [...new Set(found.map((marks) => marks.preApprovedStart).filter(Boolean))];
  if (starts.length > 0) return { preApprovedStart: starts.join(' ') };
  return found.find((marks) => marks.unreadable) ?? found[0] ?? { unreadable: 'its transcript could not be found (ENOENT)' };
}
