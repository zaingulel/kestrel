#!/usr/bin/env node
// board-claim.mjs — claim a picked card on the GitHub Projects tracker, or only check that it is still free.
//
//   node scripts/board-claim.mjs <issue#> --intake <file> --runtime "<Claude Code|Codex|Claude Code cloud>"
//   node scripts/board-claim.mjs <issue#> --intake <file> --check
//   node scripts/board-claim.mjs --help
//
// The logic and its exit codes live in lib/board-claim.mjs.

import { main } from './lib/board-claim.mjs';

process.exitCode = main();
