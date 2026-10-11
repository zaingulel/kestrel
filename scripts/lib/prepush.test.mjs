// prepush.test.mjs — real-shell proof for the shared pre-push gate.
//
// The fixture executes the tracked hook from a nested directory with isolated Git, npm, Node, and
// local-ESLint capabilities. It observes calls and scrubbed environment at the executable boundary;
// no push or hook activation occurs.
//
// The tests of a push to main run the hook over a real git and a real two-commit repository, because
// what they prove is which commit's files the hook hands to the product gate: the first commit is what
// the remote's main holds, the second is the pushed commit and stays checked out. Every other test
// keeps the fake git, which fails any call the hook should not make.
//
// Recurring cost: about 0.6 seconds for the file, measured on Linux with Node 26: 10 to 18
// milliseconds for each test over the fake git and 49 to 77 for each of the eight over a real repository.
// Removal condition: remove with the pre-push hook, or replace when Git supplies equivalent native
// lint, nested-test, environment-scrub, and optional-full-test enforcement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureShell } from './posix-shell.mjs';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../../.githooks/pre-push');
const NO_SHELL = 'a POSIX shell is required: install Git for Windows';

const SHELL = fixtureShell();

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
 */
function realRepository(repo, isolation, options) {
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
  const commit = (definition, gate) => {
    const entries = [{ path: DEFINITION_PATH, mode: '100644', content: `${definition}\n` }];
    if (gate) entries.push({ path: GATE_PATH, ...gate });
    for (const { path, mode, content } of entries) {
      const oid = git(['hash-object', '-w', '--stdin'], content);
      git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`]);
    }
    git(['commit', '-q', '-m', definition]);
    return git(['rev-parse', 'HEAD']);
  };

  git(['init', '-q', '-b', 'main', '.']);
  const mainSha = commit('main', GATES[options.main]);
  const pushedSha = commit('pushed', GATES[options.pushed]);
  const pushedTree = git(['rev-parse', 'HEAD^{tree}']);
  const standIn = options.replaced && commit('replaced', GATES.admit);
  // The entries reached the index only; this writes the pushed commit's files to the working tree.
  git(['reset', '-q', '--hard', pushedSha]);
  const toplevel = git(['rev-parse', '--show-toplevel']);
  if (standIn) for (const real of [mainSha, pushedSha]) git(['replace', real, standIn]);
  return { mainSha, pushedSha, pushedTree, toplevel };
}

/**
 * `options.main` (`'admit'`, `'refuse'`, `'not-executable'` or `'absent'`) is the product gate the
 * remote's main holds and `options.pushed` (`'admit'` or `'refuse'`) the one the pushed commit holds.
 * Naming `options.main` swaps the fake git for the real one over a real repository, and `options.tar === false`
 * leaves `tar` off the hook's PATH.
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
    const isolation = { HOME: scratch, GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    let repository = {};
    if (options.main) {
      tools.push('git', 'mktemp', 'mkdir', 'rm');
      if (options.tar !== false) tools.push('tar');
      repository = realRepository(repo, isolation, options);
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

    if (options.node !== false) {
      executable(join(bin, 'node'), `#!/bin/sh
printf 'node\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$*" "$PWD" "$GIT_DIR" "$GIT_WORK_TREE" "$GIT_NAMESPACE" "$NODE_TEST_CONTEXT" "$GIT_TRACE_PACKET$GIT_TRACE2_EVENT" >> "$CALLS"
case "$*" in
  "--test scripts/lib/*.test.mjs") exit "\${SCRIPT_STATUS:-0}" ;;
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
      const eslint = join(repo, 'node_modules', '.bin', 'eslint');
      mkdirSync(dirname(eslint), { recursive: true });
      executable(eslint, '#!/bin/sh\nexit 0\n');
    }

    // `input` is the ref lines Git writes to the hook's stdin, one per pushed ref.
    const run = (extra = {}, input = '') => spawnSync(SHELL, [HOOK], {
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
    fn({ ...repository, leftovers, recorded, root: shellForm(repo), run });
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
      'node --test scripts/lib/*.test.mjs',
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

test('pre-push skips lint without local ESLint but still runs the script suite', () => {
  withFixture({ eslint: false }, ({ recorded, run }) => {
    const result = run();
    assert.equal(result.status, 0, output(result));
    assert.match(result.stderr, /eslint not installed.*skipping lint gate/);
    assert.deepEqual(recorded().map((line) => line.split('\t')[0]), ['node']);
  });
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
      'node --test scripts/lib/*.test.mjs',
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
      'node --test scripts/lib/*.test.mjs',
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
