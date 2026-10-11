// checkout-context.test.mjs — git's own answer to "is this the root checkout?", on a throwaway
// repository with one linked worktree, so the resolver the hook injects is proven against real git
// rather than against a path convention. Mutation: compare gitDir to itself and the worktree reads
// as the root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkoutContext } from './checkout-context.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

test('checkoutContext tells the main working tree from a linked worktree, and says when it cannot read the directory', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'checkout-context-'));
  try {
    const root = join(scratch, 'repo');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
    const job = join(root, '.claude', 'worktrees', '1170');
    git(root, 'worktree', 'add', '-q', job, '-b', 'worktree-1170');
    mkdirSync(join(root, 'src'));

    const fromRoot = checkoutContext(root).checkout;
    assert.equal(fromRoot.cwd, root);
    assert.equal(fromRoot.platform, process.platform);
    assert.equal(fromRoot.isRootCheckout(root), true);
    assert.equal(fromRoot.isRootCheckout(join(root, 'src')), true, 'a subdirectory of the root is still the root checkout');
    assert.equal(fromRoot.isRootCheckout(job), false);

    const fromJob = checkoutContext(job).checkout;
    assert.equal(fromJob.isRootCheckout(job), false);
    assert.equal(fromJob.isRootCheckout(root), true);
    assert.equal(fromJob.isRootCheckout(join(scratch, 'missing')), false, 'a directory git cannot read is not the root');

    const outside = checkoutContext(scratch);
    assert.equal(outside.checkout, undefined);
    assert.match(outside.unresolved, /cannot resolve the working directory/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Windows' default executable search tries the working directory before PATH, so the guard run in a
// repository holding a git.exe would run it. The planted git.exe is a copy of node, which rejects
// -C, so a checkout read through it would come back unresolved.
// Recurring cost: one copy of the node binary, one node start and one git start, on Windows only.
// Removal condition: remove when checkoutContext no longer spawns git.
test('win32 checkoutContext ignores a git.exe in the working directory', {
  skip: process.platform !== 'win32' && 'the working-directory executable search exists only on Windows',
}, (t) => {
  const nodeDir = dirname(process.execPath);
  if (existsSync(join(nodeDir, 'git.exe'))) {
    t.skip('node shares a directory with git.exe, so no PATH can hold node without it');
    return;
  }
  const gitDir = (process.env.PATH ?? '').split(';').filter(Boolean)
    .find((dir) => existsSync(join(dir, 'git.exe')));
  assert.ok(gitDir, 'no PATH directory holds git.exe');
  const repository = fileURLToPath(new URL('../..', import.meta.url));

  const planted = mkdtempSync(join(tmpdir(), 'checkout-context-'));
  try {
    copyFileSync(process.execPath, join(planted, 'git.exe'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
    const moduleUrl = pathToFileURL(fileURLToPath(new URL('./checkout-context.mjs', import.meta.url))).href;
    const r = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { checkoutContext } from ${JSON.stringify(moduleUrl)}; console.log('checkout' in checkoutContext(${JSON.stringify(repository)}));`,
    ], { cwd: planted, env: { ...env, PATH: [gitDir, nodeDir].join(';') }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'true');
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }
});
