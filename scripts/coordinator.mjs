#!/usr/bin/env node
// coordinator.mjs: the tools of a project's coordinator, run from the repository root.
//
//   node scripts/coordinator.mjs open --login <GitHub login> [--runtime <claude|codex>]
//   node scripts/coordinator.mjs open --runtime <claude|codex>
//   node scripts/coordinator.mjs cards --login <GitHub login>
//   node scripts/coordinator.mjs unfinished --login <GitHub login>
//   node scripts/coordinator.mjs start <card> --login <GitHub login>
//   node scripts/coordinator.mjs bind-job
//   node scripts/coordinator.mjs forward
//   node scripts/coordinator.mjs forward-watch --coordinator <address> --space <space id>
//   node scripts/coordinator.mjs wake
//
// `wake` types one fixed line into the project's live coordinator through `hc send`, with no tracker request. `open`
// opens the coordinator as a Coordinator tab in the project's Herdr space. The Herdr chooser's login-less route uses the
// signed-in GitHub login and excludes a standing lead. `cards` prints the startable Ready cards in build order.
// `unfinished` prints each job whose card has a local branch job/N, a job worktree or an open draft pull request,
// one `#N <verdict>: <detail>` line in card order: running, held, elsewhere, stopped or continue. `start` starts card <card>'s job as a
// kept runtime session running the resume skill, in its own tab `job <card>`, as an hc child of the terminal it runs in.
// Claude uses the model and effort of fetched main's coordinator setting. Codex requires verified native hooks and a versioned mise install.
// `start` refuses a card whose job session
// still runs, an unfinished job whose verdict is not continue or stopped, and one that would take more running places than the lead's
// cap allows: a job waiting on the owner takes none.
// Where the card's job terminal is kept but its Claude is gone, as after a restart, `start` resumes the recorded session from
// its transcript under {CLAUDE_CONFIG_DIR or ~/.claude}/projects, or prints why it cannot and starts nothing.
// `cards`, `unfinished` and `start` read GitHub through `ghExec`; when GitHub refuses a read for quota they make no further read,
// print `GitHub refused a coordinator tracker read for quota; repeat it after <ISO>.` and end with exit 6, without waiting or
// repeating. `bind-job` reads back the host's binding for the current Codex Herdr job. `forward-watch` types into coordinator
// <address>, through `hc send`, one fixed line each time a job of space <space id> that an earlier coordinator started
// becomes blocked, done or error, or finishes, with no tracker request; it prints `forward-ready` once watching and ends
// once no such job is live. `forward`, run from the sole Coordinator, starts `forward-watch` for it as its child in tab
// `job notes` while a job of an earlier coordinator is live, and otherwise closes the tabs of the finished forwarders it
// removes and starts nothing.
//
// Exit 0 done; for `unfinished`, the list is complete. 1: it could not (the reason is on stdout); for `unfinished`, a read failed
// and the unfinished jobs are unknown, with no verdict printed; for `forward-watch`, a Herdr read, record or send failed, or
// `hc events` ended before Herdr subscribed or while a job of an earlier coordinator was still live; for `forward`, it is not
// run from the sole Coordinator, a Herdr read or change failed, its earlier forwarder stopped with a failure, or the watch
// never showed `forward-ready`. 3: the Herdr add-on is off on fetched main. 4: `wake` found no
// coordinator to wake (the reason is on stdout). 5: a Coordinator tab is already open. 6: GitHub refused a tracker read for quota
// (`cards`, `unfinished`, `start`): the line names the reset, and nothing was listed or started. 2: any other argument shape, refused
// before any call with the usage line on stderr.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configuredTracker } from './lib/board-markdown.mjs';
import { gitEnvironment, MANIFEST_PATH, readManifest } from './lib/factory-sync.mjs';
import { readGitHubLogin, runGh } from './lib/gh-exec.mjs';
import { codexBindingPath, forwardNotes, herdrCommand, listCards, listUnfinished, openCoordinator, readCodexBinding, readLiveCodexBinding, requireVersionedCodex, startForwarder, startJob, wakeCoordinator } from './lib/coordinator.mjs';
import { capLock, readCap, standingLead, standingLeadProcessCommand } from './lib/cap-lock.mjs';
import { isCanonicalLeadFolder } from './lib/pre-approved-run.mjs';
import { LOCAL_HERDR_TERMINAL, RUNTIMES } from './lib/runtimes.mjs';
import { repositoryRoot } from './pre-approved-run.mjs';

const USAGE = 'usage: node scripts/coordinator.mjs open --login <GitHub login> [--runtime <claude|codex>] | open --runtime <claude|codex> | cards --login <GitHub login> | unfinished --login <GitHub login> | start <card> --login <GitHub login> | bind-job | forward | forward-watch --coordinator <address> --space <space id> | wake';
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const CARD = /^[1-9]\d*$/;
const SPACE = /^[A-Za-z0-9_-]+$/;
const CODEX_HOOK_CONFIG = '.codex/hooks.json';
const CODEX_GIT_GUARD = '.codex/hooks/block-unsafe-git.mjs';

function installedFile(root, path) {
  const file = join(root, path);
  if (!lstatSync(file).isFile() || realpathSync(file) !== file) throw new Error(`${path} must be a canonical regular file`);
  return file;
}

function readNativeExecutable(pid) {
  try {
    const processExecutable = `/proc/${pid}/exe`;
    const executable = readlinkSync(processExecutable);
    if (!isAbsolute(executable) || basename(executable) !== 'codex') {
      throw new Error('the responding app-server is not a native codex process; a launcher wrapper can hide it');
    }
    const { dev, ino } = statSync(processExecutable, { bigint: true });
    const verifyExecutable = () => {
      const message = 'the native Codex executable generation changed or its canonical path is unavailable';
      try {
        const file = lstatSync(executable, { bigint: true });
        if (file.isFile() && realpathSync.native(executable) === executable && file.dev === dev && file.ino === ino) return;
      } catch (cause) {
        throw new Error(message, { cause });
      }
      throw new Error(message);
    };
    verifyExecutable();
    return { executable, verifyExecutable };
  } catch (error) {
    return new Error(`unverified native Codex executable identity: ${/** @type {Error} */ (error).message}`);
  }
}

// This connection only initializes and makes one read request. It never starts a thread or a turn.
/** @param {'hooks/list' | 'thread/items/list'} request
 * @param {{ cwds: string[] } | { threadId: string, limit: number }} params
 * @returns {Promise<{ reply: { data?: unknown, nextCursor?: unknown }, identity: ReturnType<typeof readNativeExecutable> }>} */
async function readNativeAppServer(root, request, params, executable = 'codex') {
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const exitCause = ({ code, signal }) => `app-server exited with ${signal ?? `code ${code}`}`;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  let timer;
  let result;
  let killed;
  try {
    result = await new Promise((resolve, reject) => {
      let method = 'initialize';
      let id = 1;
      let buffered = '';
      let bytes = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      timer = setTimeout(() => reject(new Error(`app-server timed out waiting for ${method}`)), 5_000);
      child.once('error', reject);
      child.stdin.on('error', reject);
      child.stdout.on('error', reject);
      void closed.then((exit) => reject(new Error(`${exitCause(exit)} while waiting for ${method}`)));
      child.stdout.on('data', (chunk) => {
        try {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) throw new Error(`app-server ${request === 'hooks/list' ? 'hook inventory' : 'claim history'} exceeded 1 MiB`);
          const lines = (buffered + decoder.decode(chunk, { stream: true })).split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            const message = JSON.parse(line);
            if (typeof message?.method === 'string' && !('id' in message)) continue;
            if (message?.id !== id || typeof message.method !== 'undefined') throw new Error(`app-server returned an unexpected ${method} response`);
            if ('error' in message) throw new Error(`app-server ${method} failed with code ${message.error?.code ?? 'unknown'}`);
            const reply = message.result;
            if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error(`app-server ${method} returned no result object`);
            if (method === request) {
              resolve({ reply, identity: readNativeExecutable(child.pid) });
              return;
            }
            if (![reply.userAgent, reply.codexHome, reply.platformFamily, reply.platformOs].every((value) => typeof value === 'string' && value)) {
              throw new Error('app-server initialize returned incomplete server information');
            }
            method = request;
            id = 2;
            send({ method: 'initialized' });
            send({ id, method, params });
          }
        } catch (error) {
          reject(error);
        }
      });
      send({ id, method, params: { clientInfo: { name: request === 'hooks/list' ? 'fabraik-hook-inspection' : 'fabraik-claim-history', version: '1' }, capabilities: { experimentalApi: true } } });
    });
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    child.stdout.destroy();
    killed = child.kill('SIGKILL');
    await closed;
  }
  const exit = await closed;
  if (exit.code !== 0 && !(killed && exit.signal === 'SIGKILL')) throw new Error(exitCause(exit));
  return result;
}

/** @returns {Promise<import('./lib/coordinator.mjs').CodexHookPreflight>} */
async function checkCodexHooks({ root }) {
  try {
    if (process.platform !== 'linux') throw new Error('Codex Herdr jobs require Linux');
    if (realpathSync(root) !== root) throw new Error('the integration root is not canonical');
    installedFile(root, MANIFEST_PATH);
    const { entries } = readManifest(root);
    for (const path of [CODEX_HOOK_CONFIG, CODEX_GIT_GUARD]) {
      const file = installedFile(root, path);
      const entry = entries.find((candidate) => candidate.path === path);
      if (!entry || 'region' in entry) throw new Error(`${path} has no whole-file entry in ${MANIFEST_PATH}`);
      if (createHash('sha256').update(readFileSync(file)).digest('hex') !== entry.sha256) throw new Error(`${path} differs from ${MANIFEST_PATH}`);
    }
    const { reply: { data }, identity } = await readNativeAppServer(root, 'hooks/list', { cwds: [root] });
    if (!Array.isArray(data) || data.length !== 1 || data[0]?.cwd !== root) throw new Error('hooks/list did not report exactly the integration root');
    const { hooks, errors } = data[0];
    if (!Array.isArray(hooks) || !Array.isArray(errors)) throw new Error('hooks/list returned an incomplete inventory');
    if (errors.length > 0) throw new Error('hooks/list could not read every configured hook');

    const projectSource = join(root, CODEX_HOOK_CONFIG);
    const expected = [
      { label: 'project Bash guard', key: `${projectSource}:pre_tool_use:0:0`, sourcePath: projectSource, source: 'project', eventName: 'preToolUse',
        matcher: 'Bash', command: 'node "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.codex/hooks/block-unsafe-git.mjs"' },
    ];
    for (const hook of hooks) {
      if (typeof hook?.key !== 'string' || !hook.key || typeof hook.enabled !== 'boolean'
        || !['managed', 'trusted', 'untrusted', 'modified'].includes(hook.trustStatus)) throw new Error('hooks/list returned a malformed registration');
    }
    for (const { label, ...registration } of expected) {
      const matches = hooks.filter((hook) => hook.key === registration.key || (hook.eventName === registration.eventName
        && hook.sourcePath === registration.sourcePath && hook.matcher === registration.matcher));
      if (matches.length !== 1) throw new Error(`hooks/list reported ${matches.length} registrations for the ${label}`);
      const [hook] = matches;
      if (hook.handlerType !== 'command' || hook.async !== false
        || Object.entries(registration).some(([key, value]) => hook[key] !== value)) throw new Error(`the ${label} differs from the required registration`);
      if (!hook.enabled || hook.trustStatus !== 'trusted') throw new Error(`the ${label} is ${hook.enabled ? hook.trustStatus : 'disabled'}`);
    }
    const prompting = hooks.find((hook) => hook.enabled && ['untrusted', 'modified'].includes(hook.trustStatus));
    if (prompting) throw new Error(`enabled registration ${prompting.key} is ${prompting.trustStatus}`);
    if (identity instanceof Error) throw identity;
    requireVersionedCodex(identity.executable, (release) => execFileSync('mise', ['where', `codex@${release}`], {
      cwd: root, env: { ...process.env, MISE_OFFLINE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024,
    }).trim());
    return { status: 'ready', ...identity };
  } catch (error) {
    throw new Error(`Codex native hook preflight failed. ${/** @type {Error} */ (error).message}. Inspect /hooks in Codex for the exact definitions.`);
  }
}

async function readCodexClaimHistory({ root, threadId }, { executable, verifyExecutable }) {
  const limit = 20;
  verifyExecutable();
  const { reply: { data, nextCursor }, identity } = await readNativeAppServer(root, 'thread/items/list', { threadId, limit }, executable);
  if (identity instanceof Error) throw identity;
  if (identity.executable !== executable) throw new Error('the claim history server differs from the checked native Codex executable');
  identity.verifyExecutable();
  verifyExecutable();
  if (!Array.isArray(data) || data.length > limit || nextCursor !== null) throw new Error('Codex claim history did not return one complete bounded page');
  return data;
}

async function observeCodexBinding({ root, address, wait }) {
  const path = codexBindingPath(root, address);
  const delivery = dirname(path);
  const folders = [dirname(delivery), delivery];
  const deadline = performance.now() + 5_000;
  for (;;) {
    if (lstatSync(path, { throwIfNoEntry: false })) return readCodexBinding({ root, address });
    // A missing record can still sit below an unsafe directory, which must fail before any wait.
    for (const folder of folders) {
      if (!lstatSync(folder, { throwIfNoEntry: false })) break;
      if (!isCanonicalLeadFolder(folder)) throw new Error(`${basename(folder)} must be an owned, physical 0700 directory`);
    }
    const remaining = deadline - performance.now();
    if (!wait || remaining <= 0) return null;
    await delay(Math.min(100, remaining));
  }
}

// The stdout lines of a streaming `hc` command run with `args`, read from its start; ending the iteration stops the command.
/** @param {string[]} args @param {(line: string) => void} print @returns {AsyncIterable<string>} */
function herdrLines(args, print) {
  const child = spawn('hc', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  child.once('error', (error) => print(`hc ${args[0]} could not run: ${error.message}`));
  const reader = createInterface({ input: child.stdout });
  // The iterator is taken at once so the lines printed before the first read are kept.
  const lines = reader[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => lines.next(),
      return: async () => {
        child.kill();
        reader.close();
        return { done: true, value: undefined };
      },
    }),
  };
}

// The command and its operands, or undefined for any other shape.
/** @returns {{ command: 'start', card: number, login: string } | { command: 'wake' } | { command: 'bind-job' } | { command: 'forward' } | { command: 'forward-watch', coordinator: string, space: string } | { command: 'open', login?: string, runtimeOverride?: string } | { command: 'cards', login: string } | { command: 'unfinished', login: string } | undefined} */
function parse(args) {
  const [command, ...rest] = args;
  if (command === 'wake' && rest.length === 0) return { command };
  if (command === 'bind-job' && rest.length === 0) return { command };
  if (command === 'forward' && rest.length === 0) return { command };
  if (command === 'forward-watch' && rest.length === 4 && rest[0] === '--coordinator' && LOCAL_HERDR_TERMINAL.test(rest[1]) && rest[2] === '--space' && SPACE.test(rest[3])) {
    return { command, coordinator: rest[1], space: rest[3] };
  }
  if (command === 'start' && rest.length === 3 && CARD.test(rest[0]) && Number.isSafeInteger(Number(rest[0])) && rest[1] === '--login' && LOGIN.test(rest[2])) {
    return { command, card: Number(rest[0]), login: rest[2] };
  }
  if ((command === 'open' || command === 'cards' || command === 'unfinished') && rest.length === 2 && rest[0] === '--login' && LOGIN.test(rest[1])) {
    return { command, login: rest[1] };
  }
  if (command === 'open' && rest.length === 4 && rest[0] === '--login' && LOGIN.test(rest[1]) && rest[2] === '--runtime' && RUNTIMES.includes(rest[3])) {
    return { command, login: rest[1], runtimeOverride: rest[3] };
  }
  if (command === 'open' && rest.length === 2 && rest[0] === '--runtime' && RUNTIMES.includes(rest[1])) {
    return { command, runtimeOverride: rest[1] };
  }
  return undefined;
}

function checkStandingLead(root) {
  const account = userInfo();
  const machine = {
    account,
    platform: process.platform,
    processCommand: standingLeadProcessCommand,
    run: (command, args, { env }) => spawnSync(command, args, { env, encoding: 'utf8', timeout: 30_000 }),
  };
  const env = { PATH: process.env.PATH, XDG_RUNTIME_DIR: `/run/user/${account.uid}` };
  const lead = standingLead({ root, machine, env, command: 'coordinator.mjs open' });
  if (lead.cause) throw new Error(lead.cause);
  if (lead.pid) throw new Error(`a standing lead runs this project as process ${lead.pid}; it is left as it is`);
}

async function main(args) {
  const options = parse(args);
  if (!options) {
    console.error(USAGE);
    return 2;
  }
  const print = (line) => console.log(line);
  try {
    if (options.command === 'bind-job') {
      if (process.platform !== 'linux') throw new Error('Codex Herdr binding requires Linux');
      const cwd = process.cwd();
      const root = realpathSync(repositoryRoot());
      if (cwd !== root) throw new Error('run bind-job from the canonical integration root');
      const binding = await readLiveCodexBinding({ root, hc: herdrCommand('hc', 5_000) });
      print(`Bound Codex Herdr job #${binding.card} at ${binding.terminalAddress} to thread ${binding.threadId}.`);
      return 0;
    }
    if (options.command === 'forward-watch') return await forwardNotes({ hc: herdrCommand('hc'), events: (eventArgs) => herdrLines(eventArgs, print), coordinator: options.coordinator, space: options.space, print });
    const chooser = options.command === 'open' && options.login === undefined;
    const repository = repositoryRoot();
    const root = chooser ? realpathSync(repository) : repository;
    if (chooser && root !== realpathSync(process.cwd())) {
      throw new Error('open with the signed-in GitHub login from the repository root');
    }
    process.chdir(root);
    const herdrApp = herdrCommand('herdr-app');
    if (options.command === 'wake') return await wakeCoordinator({ root, herdrApp, hc: herdrCommand('hc'), print });
    if (options.command === 'forward') return await startForwarder({ root, herdrApp, hc: herdrCommand('hc'), parent: process.env.HC_TERMINAL_ID, print });
    const git = (gitArgs) => execFileSync('git', gitArgs, { cwd: root, env: gitEnvironment(), encoding: 'utf8', stdio: 'pipe', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    const state = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'fabraik-lead');
    // This command uses the shared lead state folder only for the cap lock, so it makes the folder where the lock is taken.
    const lockCap = async (work) => {
      mkdirSync(state, { recursive: true, mode: 0o700 });
      return await capLock(state, work);
    };
    if (options.command === 'open') {
      if (chooser && configuredTracker() !== 'github') throw new Error('opening from the Herdr chooser requires a GitHub tracker');
      const login = options.login ?? readGitHubLogin(runGh);
      if (login === null) throw new Error('gh gave no GitHub login');
      return await openCoordinator({ root, login, runtimeOverride: options.runtimeOverride, git, herdrApp, hc: herdrCommand('hc'),
        capLock: lockCap, checkStandingLead: chooser ? () => checkStandingLead(root) : undefined, print });
    }
    const tracker = { rawGh: runGh, print };
    if (options.command === 'cards') return await listCards(tracker);
    if (options.command === 'unfinished') return await listUnfinished({ root, herdrApp, hc: herdrCommand('hc'), git, hostname: hostname(), ...tracker });
    // What `{session}.jsonl` is in Claude's project folders: 'link' where any is a symbolic link, else 'file' where any is a
    // regular file, else undefined. startJob passes only a session it checked as a v4 UUID.
    const transcript = (session) => {
      const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
      let folders;
      try {
        folders = readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
        throw error;
      }
      let kind;
      for (const folder of folders) {
        let found;
        try {
          found = lstatSync(join(projects, folder.name, `${session}.jsonl`));
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
          throw error;
        }
        if (found.isSymbolicLink()) return 'link';
        if (found.isFile()) kind = 'file';
      }
      return kind;
    };
    return await startJob({ root, card: options.card, login: options.login, herdrApp, hc: herdrCommand('hc'), parent: process.env.HC_TERMINAL_ID, hostname: hostname(), transcript, newSessionId: randomUUID,
      now: Date.now, cap: () => readCap(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fabraik', 'lead.json')),
      capLock: lockCap, git, checkCodexHooks, readCodexBinding: observeCodexBinding, readCodexClaimHistory, ...tracker });
  } catch (error) {
    const command = options.command === 'bind-job' ? 'Codex bind read-back' : 'Coordinator command';
    print(`${command} stopped: ${/** @type {Error} */ (error).message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
