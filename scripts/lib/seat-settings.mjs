// seat-settings.mjs — the seat settings file and the substitution of a seat's setting values.
//
// Pure: no file system, no git. The imports are the agent check, whose bound an override must keep, and runtimes.mjs,
// which owns the file's top-level rules so every reader of the file applies them. Reading, verifying and writing the
// files is for the sync, which imports this module; the settings file is read only by runtimes.mjs.
//
// SETTINGS FILE: SETTINGS_PATH (runtimes.mjs), version 1. Each runtime's own setting names are used:
//   { "version": 1, "runtimes": ["claude", "codex"], "seats": { "claude": { "builder": { "model": "opus", "effort": "high", "maxTurns": 120 } },
//                              "codex": { "reviewer": { "model_reasoning_effort": "high" } } } }
//
// Every rule below is a refusal that names the file, the place in it and the offending value (printed through
// JSON.stringify), raised before any file is written. Where a rule says "with the recovery", the refusal ends with
// this sentence, because the cause may be a file written for a newer copy of the workflow than the one installed:
//   if a newer copy of the shared workflow admits this, undo the edit, run the sync that installs that copy, then make the edit again
//
//  1. The file is a regular file reached through no symlinked directory, read without following a symlink,
//     holding one JSON object with the keys `version` and `seats` and, optionally, `runtimes`, `planApproval`, `greptile`, `docSweep` and `crossFamilyReview`.
//     `version` is exactly 1; any other version is refused as unsupported by this copy, with the recovery. Another
//     key is refused with the recovery.
//  2. `seats` is an object whose only keys are `claude` and `codex`, each an object from seat name to an object of
//     settings. Own keys only. An empty object means no override. Another runtime key is refused with the recovery.
//  3. A seat name matches ^[\w-]+$ and must be a seat file the manifest lists for that runtime. A name is only ever
//     compared with manifest paths; no path on disk is built from it.
//  4. Setting names are `model`, `effort` and `maxTurns` under claude, and `model` and `model_reasoning_effort`
//     under codex. A Codex seat file has no turn-limit slot, so no turn-limit name exists under codex. Anything
//     else is refused with the recovery.
//  5. `model`, `effort` and `model_reasoning_effort` are strings matching ^[A-Za-z0-9][\w.-]*$, the value grammar
//     admitted on a seat line. `maxTurns` is a JSON integer from 1 to Number.MAX_SAFE_INTEGER. In the settings
//     file a Claude `model` of `inherit` is refused, because it leaves the seat's model to the session, so the seat
//     policy could not be checked. A seatDefaults record may hold `inherit`: it records what the canonical shipped.
//  6. The seat file must carry that setting exactly once inside its settings block, in the plain form
//     (`model: value`, `maxTurns: 90`, `model = "value"`). An override changes a value; it cannot add a setting.
//  7. An override may not introduce a problem. The agent check and the seat policy are run on the shared bytes and
//     on the rendered bytes, and any problem reported for the rendered bytes and not for the shared bytes is a
//     refusal that quotes it and ends with this sentence:
//       a value only a newer copy of the shared workflow admits can be named after the sync that installs it
//  8. A manifest never lists the settings path. The comparison is the folded one the manifest already uses for its
//     own entries. A seatDefaults record obeys rules 2 to 5 and names only seat files the same manifest lists.
//  9. `runtimes`, when present, is a non-empty array naming `claude`, `codex` or both, each once; with no key both
//     runtimes are present. Anything else is refused. A seat named under a runtime the list leaves out is refused.
// 10. `planApproval`, when present, is `true` or `false`; with no key, as with `false`, the owner's plan approval
//     is off. Anything else is refused. No script acts on the value: the session reads it, as the `resume` skill
//     says under "4. Plan".
// 11. `greptile`, when present, is `true` or `false`; with no key, as with `false`, the Greptile add-on is off.
//     Anything else is refused. The sync and the manifest check act on the value: runtimes.mjs names the add-on's
//     paths, which a tree installs only where the value is `true`.
// 12. `docSweep`, when present, is `true` or `false`; with no key, as with `true`, the documentation sweep is on.
//     Anything else is refused. The sync and the manifest check act on the value.
// 13. `crossFamilyReview`, when present, is `true`, and only where both runtimes are present; with no key no
//     cross-family review is authorized. Anything else is refused. No sync or check acts on the value. `fabraik init`
//     writes it only on a yes to its disclosure, and the session reads it, as the `resume` skill says under
//     "6. Verify and review".
//
// The JSON half of rule 1, the list half of rule 9 and rules 10, 11, 12 and 13 are readSettingsHeader (runtimes.mjs), which
// parseSettings calls; rules 2, 4, 5 and the seat half of rule 9 are parseSettings and seatsByPath; 6 is
// substituteSeatSettings; 7 is overrideProblems. The file half of rule 1, rule 3 and rule 8 belong to the sync.

import { checkAgentSource, checkCodexAgentSource, checkSeatPolicy } from './check-agents.mjs';
import { isRecord, readSettingsHeader, refusal, RUNTIMES } from './runtimes.mjs';

// claude before codex, and the setting names in the order seatsRecord writes them.
const SETTING_NAMES = {
  claude: ['model', 'effort', 'maxTurns'],
  codex: ['model', 'model_reasoning_effort'],
};
const SEAT_PATHS = {
  claude: { pattern: /^\.claude\/agents\/([\w-]+)\.md$/, of: (seat) => `.claude/agents/${seat}.md` },
  codex: { pattern: /^\.codex\/agents\/([\w-]+)\.toml$/, of: (seat) => `.codex/agents/${seat}.toml` },
};
const SEAT_NAME = /^[\w-]+$/;
const TOKEN = '[A-Za-z0-9][\\w.-]*';
const VALUE = new RegExp(`^${TOKEN}$`);

function seatOf(path) {
  for (const [runtime, { pattern }] of Object.entries(SEAT_PATHS)) {
    const match = pattern.exec(path);
    if (match) return { runtime, seat: match[1] };
  }
  return null;
}

// A key is named in the refusal's `found`, never in its place, so a hostile key cannot reach a terminal raw.
function readSeats(seats, label, fromFile, runtimes) {
  if (!isRecord(seats)) throw refusal(label, 'seats', 'must be an object from runtime to seats', seats);
  const byPath = new Map();
  for (const [runtime, runtimeSeats] of Object.entries(seats)) {
    if (!Object.hasOwn(SETTING_NAMES, runtime)) throw refusal(label, 'seats', 'is not a known runtime (claude or codex)', runtime, fromFile);
    if (!isRecord(runtimeSeats)) throw refusal(label, `seats.${runtime}`, 'must be an object from seat name to settings', runtimeSeats);
    for (const [seat, settings] of Object.entries(runtimeSeats)) {
      if (!runtimes.includes(runtime)) throw refusal(label, `seats.${runtime}`, `names a seat although runtimes leaves ${runtime} out`, seat);
      if (!SEAT_NAME.test(seat)) throw refusal(label, `seats.${runtime}`, `a seat name must match ${SEAT_NAME.source}`, seat);
      const place = `seats.${runtime}.${seat}`;
      if (!isRecord(settings)) throw refusal(label, place, 'must be an object of settings', settings);
      for (const [name, value] of Object.entries(settings)) {
        if (!SETTING_NAMES[runtime].includes(name)) {
          throw refusal(label, place, `is not a setting of the ${runtime} runtime (known: ${SETTING_NAMES[runtime].join(', ')})`, name, fromFile);
        }
        const at = `${place}.${name}`;
        if (name === 'maxTurns') {
          if (!Number.isSafeInteger(value) || value < 1) throw refusal(label, at, `must be a whole number from 1 to ${Number.MAX_SAFE_INTEGER}`, value);
        } else if (typeof value !== 'string' || !VALUE.test(value)) {
          throw refusal(label, at, `must be a string matching ${VALUE.source}`, value);
        } else if (fromFile && runtime === 'claude' && name === 'model' && value === 'inherit') {
          throw refusal(label, at, 'inherit leaves the seat model to the session, so the seat policy could not be checked', value);
        }
      }
      if (Object.keys(settings).length > 0) byPath.set(SEAT_PATHS[runtime].of(seat), { ...settings });
    }
  }
  return byPath;
}

/** Parse the settings file's text, or undefined for a tree with no settings file, into the runtimes present, whether the Greptile add-on is on, whether the documentation sweep is on, and a Map from seat path to that seat's values. Throws a refusal naming `label`. */
export function parseSettings(text, label) {
  const { settings, runtimes, greptile, docSweep } = readSettingsHeader(text, label);
  return { runtimes, greptile, docSweep, seats: readSeats(settings.seats, label, true, runtimes) };
}

/** The same Map for the nested { claude, codex } form alone, as the manifest's seatDefaults holds it. */
export function seatsByPath(seats, label) {
  return readSeats(seats, label, false, RUNTIMES);
}

/** The inverse of seatsByPath, in a fixed order so the manifest bytes are deterministic. */
export function seatsRecord(byPath) {
  const entries = [...byPath].map(([path, values]) => ({ ...seatOf(path), values }));
  const record = {};
  for (const runtime of Object.keys(SETTING_NAMES)) {
    const ofRuntime = entries.filter((entry) => entry.runtime === runtime).sort((a, b) => (a.seat < b.seat ? -1 : 1));
    if (ofRuntime.length === 0) continue;
    record[runtime] = Object.fromEntries(ofRuntime.map(({ seat, values }) => [
      seat,
      Object.fromEntries(SETTING_NAMES[runtime].filter((name) => Object.hasOwn(values, name)).map((name) => [name, values[name]])),
    ]));
  }
  return record;
}

// The lines of the settings block: a Claude seat's frontmatter, a Codex seat's preamble before its charter.
function settingsBlock(runtime, lines) {
  if (runtime === 'claude') {
    const closing = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
    return closing === -1 ? null : [1, closing];
  }
  const charter = lines.findIndex((line) => line.startsWith('developer_instructions'));
  return charter === -1 ? null : [0, charter];
}

// How one setting is addressed in a seat file: the lines that mention it, the plain form with the old value
// captured, and the line that puts a value there. maxTurns captures only a canonical safe integer, so a value
// put back is the same bytes.
function lineForm(runtime, name) {
  if (!SETTING_NAMES[runtime].includes(name)) return null;
  const value = name === 'maxTurns' ? '[1-9]\\d*' : TOKEN;
  return runtime === 'claude'
    ? { mention: new RegExp(`^${name}:`), plain: new RegExp(`^${name}: (${value})$`), render: (v) => `${name}: ${v}` }
    : { mention: new RegExp(`^${name}\\s*=`), plain: new RegExp(`^${name} = "(${value})"$`), render: (v) => `${name} = "${v}"` };
}

/**
 * Replace the named setting values of one seat file, touching no other byte. Returns the new bytes and the
 * values that were there. Throws when the path is no seat path, the settings block is missing, or a setting is
 * not carried exactly once in its plain form.
 */
export function substituteSeatSettings(path, data, values) {
  const target = seatOf(path);
  if (!target) throw new Error(`${path}: is not a seat path`);
  // One byte per character, so bytes that are not valid UTF-8 survive the round trip.
  const lines = data.toString('latin1').split('\n');
  const block = settingsBlock(target.runtime, lines);
  if (!block) throw new Error(`${path}: no settings block found`);
  const replaced = {};
  for (const [name, value] of Object.entries(values)) {
    const form = lineForm(target.runtime, name);
    const mentions = [];
    if (form) {
      for (let i = block[0]; i < block[1]; i++) if (form.mention.test(lines[i])) mentions.push(i);
    }
    const old = mentions.length === 1 ? form.plain.exec(lines[mentions[0]]) : null;
    if (!old || (name === 'maxTurns' && !Number.isSafeInteger(Number(old[1])))) {
      throw new Error(`${path}: setting ${name} is not carried exactly once in the plain form inside the settings block`);
    }
    replaced[name] = name === 'maxTurns' ? Number(old[1]) : old[1];
    lines[mentions[0]] = form.render(value);
  }
  return { data: Buffer.from(lines.join('\n'), 'latin1'), replaced };
}

/**
 * The problems the rendered bytes of a seat have that the shared bytes do not: the agent check and the seat
 * policy, each given the base name, compared as whole strings. [] when the override introduces nothing.
 */
export function overrideProblems(path, shared, rendered) {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const check = path.endsWith('.toml') ? checkCodexAgentSource : checkAgentSource;
  const problemsOf = (data) => {
    const source = data.toString('utf8');
    return [...check(file, source), ...checkSeatPolicy(file, source)];
  };
  const already = new Set(problemsOf(shared));
  return problemsOf(rendered).filter((problem) => !already.has(problem));
}
