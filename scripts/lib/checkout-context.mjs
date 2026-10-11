// checkout-context.mjs — the one impure input the git guard's root-checkout rule needs (#1170):
// whether a directory is the root checkout (the main working tree) or a linked worktree. git
// decides, never a path convention: in the main working tree `--git-dir` and `--git-common-dir`
// name the same .git, while a linked worktree's git dir is .git/worktrees/<name> under the shared
// common dir. Resolved here, in the hook shell's world, so blockReason stays a pure rule that unit
// tests drive with an injected resolver.
import { execFileSync } from 'node:child_process';
import { gitExecutable } from './posix-shell.mjs';

const isMainWorkingTree = (dir) => {
  // By path on Windows, whose bare-name search reaches the working directory first.
  const git = gitExecutable();
  if (!git) throw new Error('no git.exe in an absolute PATH entry');
  const [gitDir, commonDir] = execFileSync(
    git,
    ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim().split('\n');
  return gitDir === commonDir;
};

// Returns { checkout } for blockReason, carrying the platform whose path rules the walk resolves
// with, or { unresolved } naming why the hook's working directory could not be read (git missing,
// not a repository, a directory that does not exist). The hook then applies every other rule and
// says on stderr that this one was not applied: the guard is an accident-catcher, and wedging
// every Bash call on an unreadable directory is the wrong failure.
export function checkoutContext(cwd) {
  try {
    isMainWorkingTree(cwd);
  } catch {
    return { unresolved: `git cannot resolve the working directory ${cwd}` };
  }
  const isRootCheckout = (dir) => {
    // A directory git cannot read (a typo, a removed worktree, a path outside any repository) is
    // not the root checkout. That is the honest answer for the directory named; whether the shell
    // actually got there is the walk's business, and it names the `;`-chained failed cd as its
    // fail-open residual.
    try {
      return isMainWorkingTree(dir);
    } catch {
      return false;
    }
  };
  return { checkout: { cwd, isRootCheckout, platform: process.platform } };
}
