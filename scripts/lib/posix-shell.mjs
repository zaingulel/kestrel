// posix-shell.mjs — locates a POSIX `sh` to launch shell scripts through, on every platform, and
// the git other hook code spawns.
//
// Off Windows `sh` is always on PATH. On Windows it is only reachable when an MSYS or Git-for-Windows
// `usr/bin` sits on PATH, which a plain Git install does not guarantee, so the fallback is the `sh.exe`
// Git for Windows ships three levels above its exec path (`mingw64/libexec/git-core`). sh.exe and
// git.exe are looked up through PATH's absolute entries only, because Windows' default executable
// search and a relative PATH entry both reach the working directory, where a repository could plant
// either. Returns null when neither shell exists, so the caller can refuse loudly instead of spawning
// a missing shell.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function findOnPath(name, env, exists) {
  return (env.PATH ?? '')
    .split(';')
    .filter((dir) => path.win32.isAbsolute(dir))
    .map((dir) => path.win32.join(dir, name))
    .find((candidate) => exists(candidate));
}

// Off Windows `git` from PATH; on Windows the first git.exe in an absolute PATH entry, or null.
export function gitExecutable({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') return 'git';
  return findOnPath('git.exe', env, exists) ?? null;
}

function gitExecPathFromGit(env, exists) {
  const git = gitExecutable({ platform: 'win32', env, exists });
  if (!git) return '';
  try {
    return execFileSync(git, ['--exec-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Every input is injectable so the Windows branch is exercised deterministically on any host; the Git
// exec path is only asked of git when PATH has no sh.exe.
export function posixShell({
  platform = process.platform,
  env = process.env,
  gitExecPath,
  exists = existsSync,
} = {}) {
  if (platform !== 'win32') return 'sh';
  const onPath = findOnPath('sh.exe', env, exists);
  if (onPath) return onPath;
  const execPath = gitExecPath ?? gitExecPathFromGit(env, exists);
  // An empty or relative exec path would resolve against the working directory, never beside Git.
  if (!execPath || !path.win32.isAbsolute(execPath)) return null;
  const besideGit = path.win32.resolve(execPath, '..', '..', '..', 'usr', 'bin', 'sh.exe');
  return exists(besideGit) ? besideGit : null;
}

// The located POSIX shell, null when there is none. On Windows it can be Git's bin\sh.exe, a launcher
// that puts Git's own tool directories, real git included, ahead of the PATH it is given, which would
// shadow the fixture's fake git; there the fixture runs the MSYS sh.exe behind it, which keeps PATH as given.
export function fixtureShell() {
  const shell = posixShell();
  if (process.platform !== 'win32' || !shell) return shell;
  return spawnSync(shell, ['-c', 'cygpath -w /usr/bin/sh.exe'], { encoding: 'utf8' }).stdout.trim();
}
