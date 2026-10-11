// ignore-rules.test.mjs — the ignore rules that keep local runtime assets and credentials out of Git.
//
// A job worktree reaches the preserved voice environment through a `.runtime` symlink
// (docs/TESTING-STRATEGY.md section 6). A directory-only pattern, `.runtime/`, does not match a
// symlink, so the rule is judged here against a real link in a scratch repository carrying the
// committed .gitignore.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GITIGNORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.gitignore');

test('a .runtime symlink and local environment files are ignored', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'kestrel-ignore-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet', repo]).status, 0);
  copyFileSync(GITIGNORE, join(repo, '.gitignore'));
  symlinkSync(tmpdir(), join(repo, '.runtime'));
  writeFileSync(join(repo, '.env'), '');
  writeFileSync(join(repo, '.env.local'), '');
  writeFileSync(join(repo, 'bot.py'), '');
  for (const path of ['.runtime', '.env', '.env.local']) {
    assert.equal(spawnSync('git', ['-C', repo, 'check-ignore', '--quiet', path]).status, 0, `${path} must be ignored`);
  }
  assert.equal(spawnSync('git', ['-C', repo, 'check-ignore', '--quiet', 'bot.py']).status, 1, 'a tracked source file must not be ignored');
});
