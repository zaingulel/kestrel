// Shared fake `gh` scaffold for the gh-calling CLI tests.
//
// Reached through `BOARD_TOOLKIT_GH`, never the search path: on Windows `execFile("gh")` resolves
// only `gh.exe` through CreateProcess, so an extensionless stand-in dropped on the search path is
// never run and the test silently reaches LIVE GitHub instead. The override carries an argv prefix,
// so the stand-in runs as `<node> <shim>` and needs no shell, no executable bit and no search-path
// edit.
//
// Owns only the plumbing: a temporary directory, the shim file, per-run calls files, and the
// environment carrying the override. Each test file supplies its own `gh` script source, so reply
// behaviour and call-log format stay with the test that asserts on them. The source runs as
// CommonJS, so it may `require`; a leading shebang is ignored, as it is for any Node entry point.
//
// Keys in `env(extra)` override the helper's defaults, `BOARD_TOOLKIT_GH` included. The second
// argument is a list of key names, `env(extra, ['GH_TOKEN'])`, deleted after that composition, so a
// credential-absence test can state the key is absent instead of omitting it and inheriting
// whatever the ambient environment exports.
//
// Recurring cost: negligible — one mkdtemp and one file write per importing test file.
// Removal condition: retire when the gh-calling CLI tests stop faking `gh`.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function installFakeGh(prefix, ghScript) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  // .cjs so the script source may `require`, whatever the nearest package.json declares.
  const shim = join(root, 'gh.cjs');
  writeFileSync(shim, ghScript);
  // What a caller must hold in the environment for a `gh` call to reach this shim.
  const override = JSON.stringify([process.execPath, shim]);

  let runCount = 0;
  return {
    // A fresh calls path per run, never reused, so one run's log cannot satisfy another run's
    // "no external call happened" assertion.
    newCallsFile: () => join(root, `gh-calls-${runCount++}`),
    env: (extra = {}, removeKeys = []) => {
      // `extra` is a plain object of overrides. Spreading anything else silently removes nothing:
      // an array or a string adds junk index keys and leaves the named key in place, and a Set or a
      // Map contributes nothing at all.
      if (
        extra === null ||
        typeof extra !== 'object' ||
        Object.getPrototypeOf(extra) !== Object.prototype
      ) {
        throw new Error(
          `extra must be a plain object of overrides; pass the removal list as the second argument, env({}, [...]), got: ${extra === null ? 'null' : typeof extra}`,
        );
      }
      // Array-only, because the other iterable shapes fail quietly: a string deletes its characters
      // and a Map deletes a stringified pair, so the test still passes while removing no key.
      if (!Array.isArray(removeKeys)) {
        throw new Error(
          `removeKeys must be an array of key names, got: ${removeKeys === null ? 'null' : typeof removeKeys}`,
        );
      }
      const composed = { ...process.env, BOARD_TOOLKIT_GH: override, ...extra };
      for (const key of removeKeys) delete composed[key];
      return composed;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
