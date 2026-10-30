// prepush.test.mjs — real-shell proof for the shared pre-push gate.
//
// The fixture executes the tracked hook from a nested directory with isolated Git, npm, Node, and
// local-ESLint capabilities. It observes calls and scrubbed environment at the executable boundary;
// no push or hook activation occurs.
//
// The tests of a push to main and of Git LFS use run the hook over a real git and a real repository,
// because what they prove is which commit's files the hook hands to the product gate and what the pushed
// commits and this machine's attributes files say: the first commit is what the remote's main holds, the
// second is the pushed commit and stays checked out. Every other test keeps the fake git, which fails
// any call the hook should not make.
//
// Recurring cost: about 3.8 seconds for the file, measured on Linux with Node 26: 13 to 38
// milliseconds for each test over the fake git and 68 to 183 for each case over a real repository.
// Removal condition: remove with the pre-push hook, or replace when Git supplies equivalent native
// lint, nested-test, environment-scrub, optional-full-test, and Git LFS upload enforcement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureShell } from './posix-shell.mjs';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../../.githooks/pre-push');
const NO_SHELL = 'a POSIX shell is required: install Git for Windows';

const SHELL = fixtureShell();
const HAS_GIT_LFS = Boolean(SHELL) && spawnSync(SHELL, ['-c', 'command -v git-lfs']).status === 0;

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function commandPath(name) {
  assert.ok(SHELL, NO_SHELL);
  const result = spawnSync(SHELL, ['-c', `command -v ${name}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, `fixture requires ${name}`);
  return result.stdout.trim();
}

// `dir` as the shell names it once it has changed into it: the path itself off Windows, where MSYS
// instead names it in its own POSIX form.
function shellForm(dir) {
  return process.platform === 'win32'
    ? spawnSync(SHELL, ['-c', 'cd "$DIR" && printf %s "$PWD"'], { encoding: 'utf8', env: { DIR: dir } }).stdout
    : dir;
}

// What `git lfs track '*.bin'` writes.
const TRACKING = { path: '.gitattributes', content: '*.bin filter=lfs diff=lfs merge=lfs -text\n' };
const PLAIN = '*.txt text\n';
const ZERO = '0'.repeat(40);

const GATE_PATH = 'scripts/gates/pre-push-main';
const DEFINITION_PATH = 'scripts/gates/definition';

// A stub product gate. It loads its definition by relative path and asks git for the checked-out tree
// and the top level, so its one recorded line shows whose files it loaded and which repository it reached.
const stubGate = (status) => `#!/bin/sh
read -r definition < ${DEFINITION_PATH}
printf 'gate\\t%s\\t%s\\t%s\\t%s\\n' "$*" "$definition" "$(git rev-parse 'HEAD^{tree}')" "$(git rev-parse --show-toplevel)" >> "$CALLS"
exit ${status}
`;
// A gate reaches a commit through the index, which holds the executable mode a Windows disk cannot.
const GATES = {
  admit: { mode: '100755', content: stubGate(0) },
  refuse: { mode: '100755', content: stubGate(1) },
  // No shebang: Git for Windows judges `-x` by shebang or extension, not by mode.
  'not-executable': { mode: '100644', content: `printf 'gate\\t%s\\n' "$*" >> "$CALLS"\n` },
};

/**
 * Turns `repo` into a real repository of two commits, the remote's main and then the pushed commit,
 * which stays checked out. With `options.replaced` each of the two also gets a local replacement
 * reference to a third commit, whose gate admits and whose definition reads `replaced`. Returns the ids
 * as git named them before any replacement reference existed.
 *
 * `options.mainFiles` and `options.pushedFiles` add `{ path, content }` files to those two commits.
 * `options.merge` replaces the pushed commit with a merge: `'side'` merges a side branch that added and
 * then dropped LFS tracking, `'dropping'` a merge that itself drops the tracking main holds.
 * `options.remote` adds a bare `remote.git` as `origin`, and `options.onRemote` (`'main'` or `'pushed'`)
 * makes that commit the one `origin` holds. `options.config` sets `[key, value]` pairs locally;
 * `options.infoAttributes`, `options.userAttributes` and `options.attributesFile` write this repository's
 * attributes file, the user's default one and a `core.attributesFile`.
 */
function realRepository(repo, isolation, options, scratch) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_.*|NODE_TEST_CONTEXT)$/i.test(key)));
  Object.assign(env, isolation, {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.dev',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.dev',
  });
  const git = (args, input) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env, input });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (definition, gate, files = []) => {
    const entries = [{ path: DEFINITION_PATH, mode: '100644', content: `${definition}\n` }];
    if (gate) entries.push({ path: GATE_PATH, ...gate });
    for (const file of files) entries.push({ mode: '100644', ...file });
    for (const { path, mode, content } of entries) {
      const oid = git(['hash-object', '-w', '--stdin'], content);
      git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`]);
    }
    git(['commit', '-q', '-m', definition]);
    return git(['rev-parse', 'HEAD']);
  };

  git(['init', '-q', '-b', 'main', '.']);
  const mainSha = commit('main', GATES[options.main], options.mainFiles);
  let pushedSha = commit('pushed', GATES[options.pushed], options.pushedFiles);
  if (options.merge === 'side') {
    git(['reset', '-q', mainSha]);
    commit('side adds', undefined, [TRACKING]);
    git(['rm', '-q', '--cached', '.gitattributes']);
    git(['commit', '-q', '-m', 'side drops']);
    const side = git(['rev-parse', 'HEAD']);
    pushedSha = git(['commit-tree', `${pushedSha}^{tree}`, '-p', pushedSha, '-p', side, '-m', 'merge']);
  }
  if (options.merge === 'dropping') {
    git(['reset', '-q', pushedSha]);
    git(['rm', '-q', '--cached', '.gitattributes']);
    const tree = git(['write-tree']);
    const side = git(['commit-tree', `${mainSha}^{tree}`, '-p', mainSha, '-m', 'side']);
    pushedSha = git(['commit-tree', tree, '-p', pushedSha, '-p', side, '-m', 'merge']);
  }
  const pushedTree = git(['rev-parse', `${pushedSha}^{tree}`]);
  const standIn = options.replaced && commit('replaced', GATES.admit);
  // The entries reached the index only; this writes the pushed commit's files to the working tree.
  git(['reset', '-q', '--hard', pushedSha]);
  const toplevel = git(['rev-parse', '--show-toplevel']);
  if (standIn) for (const real of [mainSha, pushedSha]) git(['replace', real, standIn]);

  let remote;
  let remoteUrl;
  if (options.remote) {
    remote = join(scratch, 'remote.git');
    remoteUrl = pathToFileURL(remote).href;
    git(['init', '-q', '--bare', remote]);
    git(['remote', 'add', 'origin', remoteUrl]);
  }
  if (options.onRemote) git(['update-ref', `refs/remotes/origin/${options.onRemote}`, { main: mainSha, pushed: pushedSha }[options.onRemote]]);
  for (const [key, value] of options.config ?? []) git(['config', key, value]);
  const attributes = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  if (options.infoAttributes) attributes(join(repo, '.git', 'info', 'attributes'), options.infoAttributes);
  if (options.userAttributes) attributes(join(scratch, 'xdg', 'git', 'attributes'), options.userAttributes);
  if (options.attributesFile) {
    const file = join(scratch, 'custom-attributes');
    attributes(file, options.attributesFile);
    git(['config', 'core.attributesFile', file]);
  }
  return { mainSha, pushedSha, pushedTree, remote, remoteUrl, toplevel };
}

/**
 * Replaces the fixture's `git` with one that answers `git lfs ...` itself and fails, with status 128, any
 * call whose arguments match `$FAILING_GIT`. `'installed'` records each `git lfs` call with its arguments and
 * the stdin lines it read, then exits with `$LFS_STATUS`; `'absent'` answers as git does for an unknown
 * command. It also writes a `grep` that fails while `$FAILING_GREP` is set and a text converter that records
 * its run.
 */
function lfsWrappers(bin, state) {
  const lfs = state === 'installed'
    ? `  shift
  [ "$1" = version ] && exit 0
  lines=
  while IFS= read -r line; do lines="$lines$line;"; done
  printf 'lfs\\t%s\\t%s\\n' "$*" "$lines" >> "$CALLS"
  exit "\${LFS_STATUS:-0}"`
    : `  echo "git: 'lfs' is not a git command. See 'git --help'." >&2
  exit 1`;
  executable(join(bin, 'git'), `#!/bin/sh
case "$*" in $FAILING_GIT) exit 128 ;; esac
if [ "$1" = lfs ]; then
${lfs}
fi
exec "${commandPath('git')}" "$@"
`);
  executable(join(bin, 'grep'), `#!/bin/sh
[ -z "$FAILING_GREP" ] || exit 2
exec "${commandPath('grep')}" "$@"
`);
  executable(join(bin, 'textconv-recorder'), `#!/bin/sh\nprintf 'textconv\\n' >> "$CALLS"\n`);
}

/**
 * `options.main` (`'admit'`, `'refuse'`, `'not-executable'` or `'absent'`) is the product gate the
 * remote's main holds and `options.pushed` (`'admit'` or `'refuse'`) the one the pushed commit holds.
 * Naming `options.main` swaps the fake git for the real one over a real repository, and `options.tar === false`
 * leaves `tar` off the hook's PATH. `options.lfs` puts `grep` on the PATH and says what the hook finds of
 * Git LFS: `'installed'` or `'absent'` through the `git` of `lfsWrappers`, `'real'` the installed `git-lfs`.
 */
function withFixture(options, fn) {
  const scratch = mkdtempSync(join(tmpdir(), 'workflow-prepush-'));
  try {
    const repo = join(scratch, 'repo lane');
    const cwd = join(repo, 'nested');
    const bin = join(scratch, 'bin');
    const calls = join(scratch, 'calls');
    const temporary = join(scratch, 'tmp');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(bin);
    mkdirSync(temporary);
    writeFileSync(calls, '');

    // Wrapper stubs rather than symlinks, because a symlink needs privilege on Windows; `sh` is on the
    // hook's PATH because a bare `sh` launcher resolves through it.
    const tools = ['dirname', 'sh'];
    // A machine's own git config, its line-ending setting among them, must not shape the repository.
    const isolation = {
      HOME: scratch,
      XDG_CONFIG_HOME: join(scratch, 'xdg'),
      GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    };
    let repository = {};
    if (options.main) {
      tools.push('git', 'mktemp', 'mkdir', 'rm');
      if (options.tar !== false) tools.push('tar');
      if (options.lfs) tools.push('grep');
      if (options.lfs === 'real') tools.push('git-lfs');
      repository = realRepository(repo, isolation, options, scratch);
    } else {
      executable(join(bin, 'git'), `#!/bin/sh
case "$*" in
  "rev-parse --local-env-vars") printf '%s\n' GIT_DIR GIT_WORK_TREE ;;
  "rev-parse --show-toplevel") printf '%s\n' "$REPO_ROOT" ;;
  *) exit 90 ;;
esac
`);
    }
    for (const name of tools) executable(join(bin, name), `#!/bin/sh\nexec "${commandPath(name)}" "$@"\n`);
    if (options.lfs === 'installed' || options.lfs === 'absent') lfsWrappers(bin, options.lfs);

    if (options.node !== false) {
      executable(join(bin, 'node'), `#!/bin/sh
printf 'node\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$*" "$PWD" "$GIT_DIR" "$GIT_WORK_TREE" "$GIT_NAMESPACE" "$NODE_TEST_CONTEXT" "$GIT_TRACE_PACKET$GIT_TRACE2_EVENT" >> "$CALLS"
case "$*" in
  "--test --test-concurrency=2 scripts/lib/*.test.mjs") exit "\${SCRIPT_STATUS:-0}" ;;
  *) exit 91 ;;
esac
`);
    }

    if (options.npm !== false) {
      executable(join(bin, 'npm'), `#!/bin/sh
printf 'npm\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$*" "$PWD" "$GIT_DIR" "$GIT_WORK_TREE" "$GIT_NAMESPACE" "$NODE_TEST_CONTEXT" "$GIT_TRACE_PACKET$GIT_TRACE2_EVENT" >> "$CALLS"
case "$*" in
  "run lint --silent") exit "\${LINT_STATUS:-0}" ;;
  "test") exit "\${FULL_TEST_STATUS:-0}" ;;
  *) exit 92 ;;
esac
`);
    }

    if (options.eslint !== false) {
      const eslint = join(options.eslint === 'ancestor' ? scratch : repo, 'node_modules', '.bin', 'eslint');
      mkdirSync(dirname(eslint), { recursive: true });
      executable(eslint, '#!/bin/sh\nexit 0\n');
    }

    // `input` is the ref lines Git writes to the hook's stdin, one per pushed ref, and `args` the remote's
    // name and URL Git passes as the hook's arguments.
    const run = (extra = {}, input = '', args = []) => spawnSync(SHELL, [HOOK, ...args], {
      cwd,
      encoding: 'utf8',
      input,
      env: {
        PATH: bin,
        REPO_ROOT: repo,
        CALLS: calls,
        TMPDIR: shellForm(temporary),
        ...isolation,
        GIT_DIR: '/wrong/repository',
        GIT_WORK_TREE: '/wrong/worktree',
        GIT_NAMESPACE: 'wrong-namespace',
        NODE_TEST_CONTEXT: 'nested-test',
        GIT_TRACE_PACKET: 'trace-packet',
        GIT_TRACE2_EVENT: 'trace-event',
        ...extra,
      },
    });
    const recorded = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean);
    // What the hook left behind in its temporary directory.
    const leftovers = () => readdirSync(temporary);
    fn({ ...repository, leftovers, recorded, nativeRoot: repo, root: shellForm(repo), run });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function output(result) {
  return `${result.stdout}${result.stderr}`;
}

test('pre-push invokes installed lint exactly once, then the script suite, from the resolved root', () => {
  withFixture({}, ({ recorded, root, run }) => {
    const result = run();
    assert.equal(result.status, 0, output(result));
    const calls = recorded().map((line) => line.split('\t'));
    assert.deepEqual(calls.map(([tool, args]) => `${tool} ${args}`), [
      'npm run lint --silent',
      'node --test --test-concurrency=2 scripts/lib/*.test.mjs',
    ]);
    assert.deepEqual(calls.map(([, , cwd]) => cwd), [root, root]);
  });
});

test('pre-push accepts ancestor-installed ESLint before the script suite', () => {
  withFixture({ eslint: 'ancestor' }, ({ recorded, root, run }) => {
    const result = run();
    assert.equal(result.status, 0, output(result));
    const calls = recorded().map((line) => line.split('\t'));
    assert.deepEqual(calls.map(([tool, args]) => `${tool} ${args}`), [
      'npm run lint --silent',
      'node --test --test-concurrency=2 scripts/lib/*.test.mjs',
    ]);
    assert.deepEqual(calls.map(([, , cwd]) => cwd), [root, root]);
  });
});

test('pre-push refuses a completed red lint before the script suite', () => {
  withFixture({}, ({ recorded, run }) => {
    const result = run({ LINT_STATUS: '1' });
    assert.notEqual(result.status, 0);
    assert.deepEqual(recorded().map((line) => line.split('\t')[0]), ['npm']);
  });
});

test('pre-push refuses a nonzero script suite after lint passes', () => {
  withFixture({}, ({ recorded, run }) => {
    const result = run({ SCRIPT_STATUS: '1' });
    assert.notEqual(result.status, 0);
    assert.deepEqual(recorded().map((line) => line.split('\t')[0]), ['npm', 'node']);
  });
});

test('pre-push skips lint without npm but still runs the script suite', () => {
  withFixture({ npm: false }, ({ recorded, run }) => {
    const result = run();
    assert.equal(result.status, 0, output(result));
    assert.match(result.stderr, /npm not found.*skipping lint gate/);
    assert.deepEqual(recorded().map((line) => line.split('\t')[0]), ['node']);
  });
});

test('ANTI-REGRESSION: pre-push names a missing install before running tests', async (t) => {
  for (const npm of [true, false]) {
    await t.test(npm ? 'npm available' : 'npm absent', () => {
      withFixture({ eslint: false, npm }, ({ nativeRoot, recorded, run }) => {
        const result = run({ RUN_TESTS: '1' });
        assert.equal(result.status, 1, output(result));
        assert.equal(result.stderr, `pre-push: eslint is not installed for ${nativeRoot}; run npm install there for a first install without a lockfile, or npm ci with an existing lockfile, before pushing.\n`);
        assert.equal(result.stdout, '');
        assert.deepEqual(recorded(), []);
      });
    });
  }
});

test('pre-push scrubs Git, nested-test, and open-ended trace variables before every gate', () => {
  withFixture({}, ({ recorded, run }) => {
    const result = run();
    assert.equal(result.status, 0, output(result));
    for (const line of recorded()) {
      const fields = line.split('\t');
      assert.deepEqual(fields.slice(3), ['', '', '', '', ''], line);
    }
  });
});

test('pre-push fails closed when Node is unavailable', () => {
  withFixture({ node: false }, ({ recorded, run }) => {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /node: (?:command )?not found/);
    assert.deepEqual(recorded().map((line) => line.split('\t')[0]), ['npm']);
  });
});

test('pre-push RUN_TESTS=1 retains the optional full-test invocation', () => {
  withFixture({}, ({ recorded, run }) => {
    const result = run({ RUN_TESTS: '1' });
    assert.equal(result.status, 0, output(result));
    assert.deepEqual(recorded().map((line) => {
      const [tool, args] = line.split('\t');
      return `${tool} ${args}`;
    }), [
      'npm run lint --silent',
      'node --test --test-concurrency=2 scripts/lib/*.test.mjs',
      'npm test',
    ]);
  });
});

const LOCAL_SHA = '1111111111111111111111111111111111111111';
const REMOTE_SHA = '2222222222222222222222222222222222222222';
// Git's documented pre-push stdin line: <local ref> SP <local sha> SP <remote ref> SP <remote sha> LF.
const refLine = (remoteRef, remoteSha = REMOTE_SHA, localSha = LOCAL_SHA) => `refs/heads/topic ${localSha} ${remoteRef} ${remoteSha}\n`;

test('pre-push judges a push to main by the gate and its files as the remote main has them, however the pushed checkout rewrites them', () => {
  withFixture({ main: 'refuse', pushed: 'admit' }, ({ mainSha, pushedSha, pushedTree, recorded, run, toplevel }) => {
    const result = run({}, refLine('refs/heads/main', mainSha, pushedSha));
    assert.notEqual(result.status, 0, 'the gate on the remote main refuses, whatever the pushed gate says');
    assert.ok(result.stderr.includes(`pre-push: the gate as it stands on the remote's main (${mainSha}) refused this push or could not be run; this checkout's copy of scripts/gates/pre-push-main was not consulted.`), result.stderr);
    assert.deepEqual(recorded(), [`gate\t${mainSha} ${pushedSha}\tmain\t${pushedTree}\t${toplevel}`]);
  });
});

test('pre-push refuses a push to main when the remote main has no product gate, whatever the pushed checkout carries', () => {
  withFixture({ main: 'absent', pushed: 'admit' }, ({ mainSha, pushedSha, recorded, run }) => {
    const result = run({}, refLine('refs/heads/main', mainSha, pushedSha));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scripts\/gates\/pre-push-main/);
    assert.match(result.stderr, /missing or not executable on the remote's main/);
    assert.match(result.stderr, /pull request/);
    assert.deepEqual(recorded(), []);
  });
});

test('pre-push proceeds when the product gate on the remote main admits a push to main', () => {
  withFixture({ main: 'admit', pushed: 'refuse' }, ({ leftovers, mainSha, pushedSha, pushedTree, recorded, run, toplevel }) => {
    const result = run({}, refLine('refs/heads/main', mainSha, pushedSha));
    assert.equal(result.status, 0, output(result));
    const [gate, ...later] = recorded().map((line) => line.split('\t'));
    assert.deepEqual(gate, ['gate', `${mainSha} ${pushedSha}`, 'main', pushedTree, toplevel]);
    assert.deepEqual(later.map(([tool, args]) => `${tool} ${args}`), [
      'npm run lint --silent',
      'node --test --test-concurrency=2 scripts/lib/*.test.mjs',
    ]);
    // The gate alone is handed the repository's two directories: lint and the suite must see neither.
    for (const [tool, , , gitDir, workTree] of later) assert.deepEqual([gitDir, workTree], ['', ''], tool);
    assert.deepEqual(leftovers(), []);
  });
});

test('pre-push never consults the product gate for other branches', () => {
  withFixture({}, ({ recorded, run }) => {
    const result = run({}, refLine('refs/heads/job/1'));
    assert.equal(result.status, 0, output(result));
    assert.deepEqual(recorded().map((line) => line.split('\t')[0]), ['npm', 'node']);
  });
});

test('pre-push consults the product gate for a main ref on any stdin line', () => {
  withFixture({ main: 'refuse', pushed: 'admit' }, ({ mainSha, pushedSha, pushedTree, recorded, run, toplevel }) => {
    const result = run({}, `${refLine('refs/heads/job/1')}${refLine('refs/heads/main', mainSha, pushedSha)}`);
    assert.notEqual(result.status, 0);
    assert.deepEqual(recorded(), [`gate\t${mainSha} ${pushedSha}\tmain\t${pushedTree}\t${toplevel}`]);
  });
});

test('pre-push refuses a push to main when the product gate on the remote main is not executable', () => {
  withFixture({ main: 'not-executable', pushed: 'admit' }, ({ mainSha, pushedSha, recorded, run }) => {
    const result = run({}, refLine('refs/heads/main', mainSha, pushedSha));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scripts\/gates\/pre-push-main/);
    assert.match(result.stderr, /missing or not executable on the remote's main/);
    assert.deepEqual(recorded(), []);
  });
});

test('pre-push judges a push to main by the real commits when the pushing repository holds replacement refs', () => {
  withFixture({ main: 'refuse', pushed: 'admit', replaced: true }, ({ mainSha, pushedSha, pushedTree, recorded, run, toplevel }) => {
    const result = run({}, refLine('refs/heads/main', mainSha, pushedSha));
    assert.notEqual(result.status, 0, 'the stand-in gate admits; the real gate on the remote main refuses');
    assert.deepEqual(recorded(), [`gate\t${mainSha} ${pushedSha}\tmain\t${pushedTree}\t${toplevel}`]);
  });
});

test('pre-push refuses a push that creates main, since no gate on main can judge it', () => {
  withFixture({}, ({ recorded, run }) => {
    const result = run({}, refLine('refs/heads/main', '0'.repeat(40)));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /the remote has no main/);
    assert.deepEqual(recorded(), []);
  });
});

test('pre-push refuses a push to main when the remote main commit is not in the local repository', () => {
  withFixture({ main: 'admit', pushed: 'admit' }, ({ leftovers, pushedSha, recorded, run }) => {
    const result = run({}, refLine('refs/heads/main', REMOTE_SHA, pushedSha));
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(REMOTE_SHA), result.stderr);
    assert.match(result.stderr, /fetch/);
    assert.deepEqual(recorded(), []);
    assert.deepEqual(leftovers(), []);
  });
});

test('pre-push refuses a push to main when the copy of the remote main cannot be unpacked', () => {
  withFixture({ main: 'admit', pushed: 'admit', tar: false }, ({ leftovers, mainSha, pushedSha, recorded, run }) => {
    const result = run({}, refLine('refs/heads/main', mainSha, pushedSha));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot unpack/);
    assert.doesNotMatch(result.stderr, /missing or not executable/);
    assert.deepEqual(recorded(), []);
    assert.deepEqual(leftovers(), []);
  });
});

const ARGS = ['origin', 'file:///example'];
const LFS_MISSING = "pre-push: this push uses Git LFS (its .gitattributes files or this machine's attributes files set filter=lfs) but git-lfs is not installed on this machine, so its files cannot be uploaded; install Git LFS, run `git lfs install --skip-repo` rather than a plain `git lfs install`, which conflicts with this hook, and push again.\n";
const LFS_FAILED = "pre-push: git lfs pre-push failed, so this push's Git LFS objects did not all reach the remote and the push is refused; fix the cause above and push again.";
const lfsUnreadable = (sha) => `pre-push: cannot read the attributes files for the pushed commit ${sha}, so whether this push uses Git LFS is unknown; repair them and push again.`;

// Maps `sha` in the repository at `root` to a new commit holding `tree`, an empty one when none is named,
// as a local `git replace` does: the commit a push names then shows other files than the pushed ones.
function replaceCommit(root, sha, tree) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_.*|NODE_TEST_CONTEXT)$/i.test(key)));
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.dev',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.dev',
  });
  const git = (args, input) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env, input });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(['replace', sha, git(['commit-tree', tree ?? git(['mktree'], ''), '-m', 'replacement'])]);
}

// The tools of each recorded line, in order.
const toolNames = (lines) => lines.map((line) => line.split('\t')[0]);

// A real repository of two admitted commits and a git whose LFS state the test names.
const withLfs = (options, fn) => withFixture({ main: 'admit', pushed: 'admit', lfs: 'installed', ...options }, fn);

test('ANTI-REGRESSION: pre-push uploads the LFS objects of a push after every gate', () => {
  withLfs({ pushedFiles: [TRACKING] }, ({ mainSha, pushedSha, recorded, run }) => {
    const result = run({}, refLine('refs/heads/main', mainSha, pushedSha), ARGS);
    assert.equal(result.status, 0, output(result));
    const calls = recorded().map((line) => line.split('\t'));
    assert.deepEqual(calls.map(([tool]) => tool), ['gate', 'npm', 'node', 'lfs']);
    assert.deepEqual(calls.at(-1), ['lfs', 'pre-push origin file:///example', `refs/heads/topic ${pushedSha} refs/heads/main ${mainSha};`]);
  });
});

test('pre-push finds LFS use wherever attributes are read and in a range whose tip dropped it', async (t) => {
  const uploaded = ['npm', 'node', 'lfs'];
  const cases = [
    ['a: a nested .gitattributes at the pushed tip', { pushedFiles: [{ path: 'assets/.gitattributes', content: TRACKING.content }] }],
    ['c: a side branch that added and dropped tracking, merged with no net change', { merge: 'side' }],
    ['e: the repository\'s own info/attributes', { infoAttributes: TRACKING.content }],
    ['f: a core.attributesFile', { attributesFile: TRACKING.content }],
    ['g: the per-user attributes file', { userAttributes: TRACKING.content }],
  ];
  for (const [title, options] of cases) {
    await t.test(title, () => {
      withLfs(options, ({ mainSha, pushedSha, recorded, run }) => {
        const result = run({}, refLine('refs/heads/job/1', mainSha, pushedSha));
        assert.equal(result.status, 0, output(result));
        assert.deepEqual(toolNames(recorded()), uploaded);
      });
    });
  }

  await t.test('b: a tip whose own attributes hide the tracking line from a diff, and run no text converter', () => {
    withLfs({
      mainFiles: [TRACKING],
      pushedFiles: [{ path: '.gitattributes', content: '*.txt text\n.gitattributes -diff\n' }],
      config: [['diff.conv.textconv', 'textconv-recorder']],
    }, ({ mainSha, nativeRoot, pushedSha, recorded, run }) => {
      const input = refLine('refs/heads/job/1', mainSha, pushedSha);
      for (const attributes of ['*.txt text\n.gitattributes -diff\n', '*.txt text\n.gitattributes diff=conv\n']) {
        writeFileSync(join(nativeRoot, '.gitattributes'), attributes);
        const result = run({}, input);
        assert.equal(result.status, 0, output(result));
      }
      assert.deepEqual(toolNames(recorded()), [...uploaded, ...uploaded]);
    });
  });

  await t.test('d: a merge that itself drops the tracking, with a remote that holds main', () => {
    withLfs({ mainFiles: [TRACKING], merge: 'dropping', onRemote: 'main' }, ({ mainSha, pushedSha, recorded, run }) => {
      const result = run({}, refLine('refs/heads/job/1', mainSha, pushedSha), ARGS);
      assert.equal(result.status, 0, output(result));
      assert.deepEqual(toolNames(recorded()), uploaded);
    });
  });

  await t.test('h: a local replacement hides a tip whose tracking lies in an ancestor the remote holds', () => {
    withLfs({ mainFiles: [TRACKING], pushedFiles: [{ path: 'asset.bin', content: 'pointer\n' }], onRemote: 'main' }, ({ mainSha, nativeRoot, pushedSha, recorded, run }) => {
      replaceCommit(nativeRoot, pushedSha);
      const result = run({}, refLine('refs/heads/job/1', mainSha, pushedSha), ARGS);
      assert.equal(result.status, 0, output(result));
      assert.deepEqual(toolNames(recorded()), uploaded);
    });
  });

  await t.test('i: a local replacement hides the commit that added tracking in a range whose tip dropped it', () => {
    withLfs({ pushedFiles: [TRACKING, { path: 'asset.bin', content: 'pointer\n' }], merge: 'dropping', onRemote: 'main' }, ({ mainSha, nativeRoot, pushedSha, recorded, run }) => {
      replaceCommit(nativeRoot, `${pushedSha}^1`, `${mainSha}^{tree}`);
      const result = run({}, refLine('refs/heads/job/1', mainSha, pushedSha), ARGS);
      assert.equal(result.status, 0, output(result));
      assert.deepEqual(toolNames(recorded()), uploaded);
    });
  });
});

test('pre-push passes every ref that uses LFS to the upload', () => {
  withLfs({ pushedFiles: [TRACKING] }, ({ mainSha, pushedSha, recorded, run }) => {
    const plain = refLine('refs/heads/plain', ZERO, mainSha);
    const first = refLine('refs/heads/first', ZERO, pushedSha);
    const second = refLine('refs/heads/second', ZERO, pushedSha);
    const stdin = (input) => {
      const before = recorded().length;
      const result = run({}, input, ARGS);
      assert.equal(result.status, 0, output(result));
      const [call] = recorded().slice(before).map((line) => line.split('\t')).filter(([tool]) => tool === 'lfs');
      return call.at(-1);
    };
    // The fake `git lfs` records each stdin line followed by a semicolon.
    const lines = (...refs) => refs.map((ref) => `${ref.trim()};`).join('');
    assert.equal(stdin(plain + first), lines(first));
    assert.equal(stdin(first + second), lines(first, second));
  });
});

test('pre-push behaves as before for a push that does not use LFS', async (t) => {
  const cases = [
    ['a: git-lfs installed, no tracking', 'installed', {}],
    ['b: git-lfs absent, no tracking', 'absent', {}],
    ['c: git-lfs absent, tracking only in a comment', 'absent', { pushedFiles: [{ path: '.gitattributes', content: `# ${TRACKING.content}` }] }],
    ['d: git-lfs absent, a deleted ref', 'absent', { pushedFiles: [TRACKING], ref: 'old' }],
    ['e: git-lfs absent, tracking that the remote already dropped', 'absent', { onRemote: 'pushed', mainFiles: [TRACKING], pushedFiles: [{ path: '.gitattributes', content: PLAIN }], remoteArgs: true }],
    ['f: git-lfs absent, attributes files with no tracking', 'absent', { infoAttributes: PLAIN, userAttributes: PLAIN }],
    ['g: git-lfs absent, a core.attributesFile replacing a per-user file that tracks', 'absent', { userAttributes: TRACKING.content, attributesFile: PLAIN }],
  ];
  for (const [title, lfs, { ref, remoteArgs, ...options }] of cases) {
    await t.test(title, () => {
      withLfs({ ...options, lfs }, ({ mainSha, pushedSha, recorded, run }) => {
        const input = ref ? refLine(`refs/heads/${ref}`, mainSha, ZERO) : refLine('refs/heads/job/1', mainSha, pushedSha);
        const result = run({}, input, remoteArgs ? ARGS : []);
        assert.equal(result.status, 0, output(result));
        assert.deepEqual(toolNames(recorded()), ['npm', 'node']);
        assert.doesNotMatch(result.stderr, /git-lfs/);
      });
    });
  }
});

test('ANTI-REGRESSION: pre-push names a missing LFS install before lint or tests', () => {
  withLfs({ lfs: 'absent', pushedFiles: [TRACKING] }, ({ mainSha, pushedSha, recorded, run }) => {
    const result = run({}, refLine('refs/heads/job/1', mainSha, pushedSha));
    assert.equal(result.status, 1, output(result));
    assert.equal(result.stdout, '');
    assert.deepEqual(recorded(), []);
    assert.ok(result.stderr.endsWith(LFS_MISSING), result.stderr);
  });
});

test('ANTI-REGRESSION: a push the hook refuses uploads no LFS objects', async (t) => {
  await t.test('a: the gate on the remote main refuses', () => {
    withLfs({ main: 'refuse', pushedFiles: [TRACKING] }, ({ mainSha, pushedSha, recorded, run }) => {
      const result = run({}, refLine('refs/heads/main', mainSha, pushedSha));
      assert.notEqual(result.status, 0);
      assert.deepEqual(toolNames(recorded()), ['gate']);
    });
  });

  await t.test('b: the optional full test fails', () => {
    withLfs({ pushedFiles: [TRACKING] }, ({ mainSha, pushedSha, recorded, run }) => {
      const result = run({ RUN_TESTS: '1', FULL_TEST_STATUS: '1' }, refLine('refs/heads/job/1', mainSha, pushedSha));
      assert.notEqual(result.status, 0);
      assert.deepEqual(toolNames(recorded()), ['npm', 'node', 'npm']);
    });
  });
});

test('pre-push refuses a push whose LFS upload fails', () => {
  withLfs({ pushedFiles: [TRACKING] }, ({ mainSha, pushedSha, recorded, run }) => {
    const result = run({ LFS_STATUS: '2' }, refLine('refs/heads/job/1', mainSha, pushedSha));
    assert.equal(result.status, 1, output(result));
    assert.deepEqual(toolNames(recorded()), ['npm', 'node', 'lfs']);
    assert.ok(result.stderr.includes(LFS_FAILED), result.stderr);
  });
});

// Pushes one Git LFS object of `payload` over the installed git-lfs to a file remote. The local cache holds the
// payload under the oid the pushed pointer names. `scenario` receives the fixture, takes its own step and runs
// the push; the remote's store must then hold the payload.
function withRealUpload(payload, scenario) {
  const oid = createHash('sha256').update(payload).digest('hex');
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(payload)}\n`;
  const store = [oid.slice(0, 2), oid.slice(2, 4), oid];
  withLfs({ lfs: 'real', remote: true, pushedFiles: [TRACKING, { path: 'asset.bin', content: pointer }] }, (fixture) => {
    const local = join(fixture.nativeRoot, '.git', 'lfs', 'objects', ...store);
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, payload);
    scenario(fixture);
    const uploaded = join(fixture.remote, 'lfs', 'objects', ...store);
    assert.ok(existsSync(uploaded), `the remote's LFS store lacks ${uploaded}`);
    assert.deepEqual(readFileSync(uploaded), Buffer.from(payload));
  });
}

test('pre-push uploads an LFS object through the installed tool to a file remote', { skip: HAS_GIT_LFS ? false : 'git-lfs is not installed on this machine' }, () => {
  withRealUpload('fabraik lfs payload\n', ({ mainSha, pushedSha, recorded, remoteUrl, run }) => {
    const result = run({}, refLine('refs/heads/job/1', mainSha, pushedSha), ['origin', remoteUrl]);
    assert.equal(result.status, 0, output(result));
    assert.deepEqual(toolNames(recorded()), ['npm', 'node']);
  });
});

test('pre-push uploads an LFS object a local replacement hides', { skip: HAS_GIT_LFS ? false : 'git-lfs is not installed on this machine' }, () => {
  withRealUpload('fabraik hidden payload\n', ({ mainSha, nativeRoot, pushedSha, remoteUrl, run }) => {
    replaceCommit(nativeRoot, pushedSha, `${mainSha}^{tree}`);
    const result = run({}, refLine('refs/heads/job/1', ZERO, pushedSha), ['origin', remoteUrl]);
    assert.equal(result.status, 0, output(result));
  });
});

test('pre-push refuses a push when its LFS use cannot be read', async (t) => {
  const cases = [
    ['grep *', { FAILING_GIT: 'grep *' }, {}],
    ['log *', { FAILING_GIT: 'log *' }, {}],
    ['config *', { FAILING_GIT: 'config *' }, {}],
    ['rev-parse --git-path *', { FAILING_GIT: 'rev-parse --git-path *' }, {}],
    ['a failing grep of a local attributes file', { FAILING_GREP: '1' }, { infoAttributes: PLAIN }],
  ];
  for (const [title, extra, options] of cases) {
    await t.test(title, () => {
      withLfs(options, ({ mainSha, pushedSha, recorded, run }) => {
        const result = run(extra, refLine('refs/heads/job/1', mainSha, pushedSha));
        assert.equal(result.status, 1, output(result));
        assert.deepEqual(recorded(), []);
        assert.ok(result.stderr.includes(lfsUnreadable(pushedSha)), result.stderr);
      });
    });
  }
});
