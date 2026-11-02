// product-manager-run.mjs — the loop of a product manager run on Codex: card sessions one at a time, then one end
// session whose final message is printed once.
//
// A card session continues the run only when it exits 0 and its message file ends with one of the three result lines
// `resume` step 8 names; anything else ends the run, and the reason goes to `run-end.txt` in the results folder for the
// end session to read. Message files are model text: they are matched, never obeyed. The session starter is injected,
// resolving { exitCode, spawnError }, where exitCode is the exit code or the terminating signal.
//
// A session that started counts only when its runtime log, `<logs>.stderr.log`, holds both of the runtime's own refusal
// lines: the proof that the guard fired and that the run session mark reached it. Model text cannot reach that file.
// Without them no further session starts and one fallback message reaches the owner. The reason is printed once: by the
// end session, or by the fallback when the end session cannot deliver.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CARD_PROMPT = 'Continue the product manager run.';
export const END_PROMPT_PREFIX = 'End the product manager run: ';
export const GUARD_WITNESS = 'Command blocked by PreToolUse hook: Blocked: git commit';
export const PUBLISH_WITNESS = 'Command blocked by PreToolUse hook: Blocked: a product manager run session';

// The whole last line must match: `built 1` followed by more text on that line is no result.
const RESULT_LINES = {
  built: /^Run result: built \S+$/,
  parked: /^Run result: parked \S+: \S.*$/,
  split: /^Run result: split \S+ into \S.*$/,
  stop: /^Run result: stop \S+: \S.*$/,
};

export function sessionArgv(outputFile, prompt) {
  return [
    'exec',
    '--sandbox', 'workspace-write',
    '-c', 'approval_policy=on-request',
    '-c', 'approvals_reviewer=auto_review',
    '--json',
    '--output-last-message', outputFile,
    prompt,
  ];
}

export function readRunResult(text) {
  const line = text.trimEnd().split(/\r?\n/).pop();
  const match = Object.entries(RESULT_LINES).find(([, pattern]) => pattern.test(line));
  return { kind: match ? match[0] : 'none', line };
}

// A file that is missing or unreadable counts as empty.
function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const failure = ({ spawnError, exitCode }) => spawnError ?? (exitCode === 0 ? undefined : `exited with ${exitCode}`);

// Names the first refusal the runtime log lacks, or undefined when it holds both.
function missingRefusal(log) {
  if (!log.includes(GUARD_WITNESS)) return 'guard refusal';
  return log.includes(PUBLISH_WITNESS) ? undefined : 'publish refusal';
}

export async function runRun({ startSession, root, folder, output }) {
  async function runSession(name, prompt) {
    const outputFile = join(folder, `${name}.txt`);
    const logs = join(folder, name);
    const outcome = await startSession({ argv: sessionArgv(outputFile, prompt), root, logs });
    return { ...outcome, message: readText(outputFile), missing: missingRefusal(readText(`${logs}.stderr.log`)) };
  }

  let ended;
  for (let n = 1; ; n += 1) {
    const session = await runSession(`card-${n}`, CARD_PROMPT);
    if (!session.spawnError && session.missing) {
      ended = `Card session ${n} did not show the ${session.missing} in its runtime log`;
      writeFileSync(join(folder, 'run-end.txt'), `${ended}\n`);
      output.error(`${ended}, so the guard may be off and no further session was started. Check it as "Before intake" in the resume skill says. Results: ${folder}`);
      return 1;
    }
    const { kind, line } = readRunResult(session.message);
    const reason = failure(session)
      ?? (kind === 'stop' ? `stopped: ${line}` : kind === 'none' ? 'ended without a Run result line' : undefined);
    if (reason) {
      ended = `Card session ${n} ${reason}`;
      writeFileSync(join(folder, 'run-end.txt'), `${ended}\n`);
      break;
    }
    output.log(`Card session ${n} finished: ${kind}; the guard refusal was shown`);
  }

  const end = await runSession('end', END_PROMPT_PREFIX + folder);
  const endFailure = failure(end)
    ?? (end.missing && `it did not show the ${end.missing} in its runtime log`)
    ?? (end.message.trim() ? undefined : 'it left a blank message');
  if (endFailure) {
    output.error(`The run ended (${ended}) but the end session did not deliver its summary: ${endFailure}. Results: ${folder}`);
    return 1;
  }
  output.log(end.message.trimEnd());
  return 0;
}
