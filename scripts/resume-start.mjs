#!/usr/bin/env node
// resume-start.mjs — resume's fixed opening steps as one command, run from the main checkout.
//
//   node scripts/resume-start.mjs <folder> > <folder>/resume-start.txt
//   node scripts/resume-start.mjs --help
//
// The logic and its exit codes live in lib/resume-start.mjs.

import { main } from './lib/resume-start.mjs';

process.exitCode = await main();
