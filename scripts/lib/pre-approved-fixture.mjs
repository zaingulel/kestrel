// pre-approved-fixture.mjs: the scheduler fixture shared by the pre-approved scheduler tests and the Herdr lead's tests, with the managed-systemd probe and the systemd helpers its tests use.

import childProcess, { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { gitEnvironment } from './factory-sync.mjs';
import { copyToolkit, GITHUB_TEST_CONFIG } from './board-toolkit-copy.mjs';

export const END_MESSAGE = 'End of run summary.';
export const END_REPLY = { message: END_MESSAGE };
// The runtime's own refusal line, as the guard probe showed it on the session's stderr (spelled out here, not imported).
export const GUARD_REFUSAL = 'Command blocked by PreToolUse hook: Blocked: git commit';
export const STDERR_FIRST_WITNESS = `warning: an unrelated line\n${GUARD_REFUSAL}: the owner commits\n`;

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Observations never throw inside a starter: assertion failures must remain visible outside production's catch.
export function readPhaseEvidence(logBase, card) {
  const observed = {};
  for (const [name, path] of Object.entries({ context: `${logBase}.context.json`,
    plan: join(dirname(logBase), `job-${card}.plan.snapshot.md`), review: join(dirname(logBase), `job-${card}.review.snapshot.md`) })) {
    try {
      observed[name] = { bytes: readFileSync(path, 'utf8') };
    } catch (error) {
      observed[name] = { error: error.code };
    }
  }
  return observed;
}

// Scheduler traces reuse authoritative board/approval/Git readers, with only the named phase completions deferred.
// Recurring cost: one toolkit copy per test; native traces add Git and flock subprocesses. No network.
export async function schedulerFixture(t, { native = false } = {}) {
  const toolkit = copyToolkit(GITHUB_TEST_CONFIG);
  t.after(() => toolkit.cleanup());
  copyFileSync(new URL('./product-manager-run.mjs', import.meta.url), toolkit.script('lib/product-manager-run.mjs'));
  copyFileSync(new URL('./closeout-cleanup.mjs', import.meta.url), toolkit.script('lib/closeout-cleanup.mjs'));
  copyFileSync(new URL('../product-manager-run.mjs', import.meta.url), toolkit.script('product-manager-run.mjs'));
  copyFileSync(new URL('./checkout-context.mjs', import.meta.url), toolkit.script('lib/checkout-context.mjs'));
  const runtime = await toolkit.load('lib/product-manager-run.mjs');
  const { main: launcherMain } = await toolkit.load('product-manager-run.mjs');
  const { boardReadExec, leanBoardPage, leanNode } = await toolkit.load('lib/board-fixtures.mjs');
  const { BOARD_OWNER, BOARD_REPOSITORY } = await toolkit.load('lib/board-config.mjs');
  const repository = `${BOARD_OWNER}/${BOARD_REPOSITORY}`;
  const repositoryId = 'R_scheduler_fixture';
  const runStart = '2026-11-05T10:00:00Z';
  const claimTime = '2026-11-05T10:01:00Z';
  const nativeGit = (args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: toolkit.root, env: gitEnvironment(), encoding: 'utf8', stdio: 'pipe' });
  let base = 'a'.repeat(40);
  if (native) {
    nativeGit(['init', '-q', '-b', 'main']);
    nativeGit(['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
    mkdirSync(join(toolkit.root, '.agents'));
    writeFileSync(join(toolkit.root, '.agents', 'factory-settings.json'), '{"version":1,"preApprovedRun":true}\n');
    nativeGit(['add', '.agents/factory-settings.json']);
    nativeGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture settings']);
    base = nativeGit(['rev-parse', 'HEAD']).trim();
    nativeGit(['update-ref', 'refs/remotes/origin/main', base]);
  }
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const prefixes = {
    select: 'Select and claim one eligible pre-approved job. Do not plan, build, or deliver.',
    prepare: 'Prepare this exact pre-approved job. Do not build or deliver.',
    build: 'Build and verify this exact prepared job. Do not publish or deliver.',
    deliver: 'Deliver this exact built job. Do not select or build another job.',
  };
  // `hookStreams` maps a session name to `{ events, stderr }`: that session's starter writes `events` beside its logs and
  // names the file as `hookEvents`; `stderr`, when given, replaces the witnessed stderr log.
  return ({ cards, held = [], waiting = [], endReply = END_REPLY, observeNotification, observeOutput, phaseReplies = {}, hookStreams = {} }) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'product-manager-scheduler-')));
    const folder = join(home, 'results');
    mkdirSync(folder);
    const jobs = new Map(cards.map((card, index) => [card, {
      card, file: String.fromCharCode(97 + index), status: 'Ready', state: 'OPEN', selected: false,
      worktree: join(home, `job-${card}`), claimUrl: `https://github.com/${repository}/issues/${card}#issuecomment-${1000 + card}`,
      head: base, deltas: new Map(), ancestry: new Map([[`${base} ${base}`, true]]),
      committed: [], unstaged: [], staged: [], untracked: [],
    }]));
    const gitState = { mainTip: base, mainReadError: undefined };
    const gates = new Map(held.map((name) => [name, deferred()]));
    const checkpoints = new Map();
    const reached = (name) => {
      if (!checkpoints.has(name)) checkpoints.set(name, deferred());
      return checkpoints.get(name);
    };
    const calls = [];
    const notifications = [];
    const inspections = [];
    const errors = [];
    const logged = [];
    let openDelivery = 0;
    let maxDelivery = 0;
    let running;
    let active = runStart;
    const selection = (job, start = runStart) => ({
      runStart: start, card: job.card, claimUrl: job.claimUrl, priorClaimUrls: [], branch: `job/${job.card}`, worktree: job.worktree, base,
    });
    const select = (job) => {
      job.selected = true;
      job.status = 'In progress';
      if (native) nativeGit(['worktree', 'add', '-qB', `job/${job.card}`, job.worktree, base]);
      else mkdirSync(job.worktree);
    };
    const merge = (job) => {
      job.status = 'Done';
      job.state = 'CLOSED';
      if (native) nativeGit(['worktree', 'remove', '--force', job.worktree]);
      else rmSync(job.worktree, { recursive: true });
    };
    const prepare = (job, results = folder, start = runStart) => {
      const planPath = native ? join(results, `job-${job.card}.plan.md`) : join(job.worktree, 'plan.md');
      writeFileSync(planPath, `Reviewed scope ${job.file} for card ${job.card}.\n`);
      const planHash = hash(readFileSync(planPath));
      const descriptorPath = join(results, `job-${job.card}.prepared.json`);
      const reviewRecordPath = join(results, `job-${job.card}.reviewed.json`);
      const reviewEvidencePath = join(results, `job-${job.card}-review.md`);
      job.descriptor = { ...selection(job, start), planPath, planHash, plannedFiles: job.plannedFiles ?? [job.file], prerequisites: job.prerequisites ?? [],
        exclusiveResources: job.exclusiveResources ?? [`${native ? 'local:' : ''}preview-${job.card}`] };
      writeFileSync(descriptorPath, JSON.stringify(job.descriptor));
      const descriptorHash = hash(readFileSync(descriptorPath));
      writeFileSync(reviewEvidencePath, `Independent review accepted card ${job.card}'s descriptor and plan.\n`);
      writeFileSync(reviewRecordPath, JSON.stringify({
        runStart: start, card: job.card, claimUrl: job.claimUrl, descriptorPath, descriptorHash, planPath, planHash,
        reviewEvidencePath, reviewEvidenceHash: hash(readFileSync(reviewEvidencePath)), verdict: 'accepted',
      }));
      job.reference = { descriptorPath, descriptorHash, planHash, reviewRecordPath };
    };
    const metadata = (job) => ({
      state: job.state, title: `Scheduler card ${job.card}`, lastEditedAt: null, timelineItems: { nodes: [] },
      comments: { pageInfo: { hasNextPage: false }, nodes: [
        { author: { login: 'owner' }, createdAt: '2026-11-05T09:00:00Z', lastEditedAt: null,
          url: `https://github.com/${repository}/issues/${job.card}#issuecomment-${2000 + job.card}`,
          body: `Approved: card=${job.card} edited=none` },
        ...(job.selected ? [{ author: { login: 'owner' }, createdAt: job.claimCreatedAt ?? claimTime, lastEditedAt: null, url: job.claimUrl,
          body: `Claim: fixture-machine Codex job/${job.card} ${job.worktree}` }] : []),
        ...(job.comments ?? []).map((body, index) => ({ author: { login: 'owner' }, createdAt: '2026-11-05T10:15:00Z',
          lastEditedAt: null, url: `https://github.com/${repository}/issues/${job.card}#issuecomment-${4000 + index}`, body })),
      ] },
    });
    const exec = (args) => {
      if (args[0] === 'repo' && args[1] === 'view' && args.includes('--json')) {
        return JSON.stringify({ id: repositoryId, nameWithOwner: repository, defaultBranchRef: { name: 'main' } });
      }
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (args[0] === 'api' && args[1] === 'graphql' && query.includes('comments(first: 100)')) {
        const number = Number(args.find((arg) => /^number=\d+$/.test(arg))?.slice('number='.length));
        assert.ok(jobs.has(number), `unexpected scheduler approval identity: ${JSON.stringify(args)}`);
        return JSON.stringify({ data: { viewer: { login: 'owner' }, repository: { id: repositoryId, issue: metadata(jobs.get(number)) } } });
      }
      if (args[0] === 'api' && args[1] === 'graphql' && query.includes('comments(last:100')) {
        const aliases = {};
        for (const [, alias, text] of query.matchAll(/(i(\d+)): issue\(number:\d+\)/g)) {
          const number = Number(text);
          assert.ok(jobs.has(number), `unexpected scheduler detail identity: ${number}`);
          const nodes = metadata(jobs.get(number)).comments.nodes.map(({ body }) => ({ body }));
          aliases[alias] = { number, body: `Scope evidence for card ${number}.`, parent: null,
            comments: { totalCount: nodes.length, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes } };
        }
        assert.ok(Object.keys(aliases).length, `unexpected scheduler detail query: ${query}`);
        return JSON.stringify({ data: { repository: aliases } });
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        // A fresh board reader makes each authoritative read observe the fixture's current state.
        return boardReadExec({ board: [leanBoardPage([...jobs.values()].map((job) => leanNode({
          id: `PVTI_scheduler_${job.card}`, title: `Scheduler card ${job.card}`, status: job.status,
          content: { __typename: 'Issue', number: job.card, state: job.state, assignees: job.assignees ?? (job.selected && job.state === 'OPEN' ? ['owner'] : []) },
        })))] }).exec(args);
      }
      throw new Error(`unexpected scheduler gh invocation: ${JSON.stringify(args)}`);
    };
    const git = (args) => {
      const argv = [...args];
      const worktree = argv[0] === '-C' ? argv.splice(0, 2)[1] : undefined;
      const job = [...jobs.values()].find((entry) => entry.selected && entry.worktree === worktree && entry.state === 'OPEN');
      if (worktree !== undefined) assert.ok(job, `unexpected scheduler worktree: ${worktree}`);
      if (argv[0] === 'remote' && argv[1] === 'get-url') return `https://github.com/${repository}.git\n`;
      if (argv.join(' ') === 'rev-parse --verify --quiet refs/remotes/origin/main^{commit}') return `${base}\n`;
      if (argv.join(' ') === `ls-tree --full-tree --format=%(objectmode) ${base} -- .agents/factory-settings.json`) return '100644\n';
      if (argv.join(' ') === `show ${base}:.agents/factory-settings.json`) return '{"version":1,"preApprovedRun":true}';
      if (worktree === undefined && argv.join(' ') === 'rev-parse --verify refs/remotes/origin/main^{commit}') {
        if (gitState.mainReadError) throw new Error(gitState.mainReadError);
        return `${gitState.mainTip}\n`;
      }
      if (argv[0] === 'worktree' && argv[1] === 'list' && argv[2] === '--porcelain') {
        const separator = argv.includes('-z') ? '\0' : '\n';
        const integration = [`worktree ${toolkit.root}`, `HEAD ${base}`, 'branch refs/heads/main', '', ''].join(separator);
        return integration + [...jobs.values()].filter((entry) => entry.selected && existsSync(entry.worktree))
          .map((entry) => [`worktree ${entry.worktree}`, `HEAD ${entry.head}`, `branch refs/heads/job/${entry.card}`, '', ''].join(separator)).join('');
      }
      if (job && argv.join(' ') === 'rev-parse --show-toplevel') return `${worktree}\n`;
      if (job && argv[0] === 'rev-parse' && ['HEAD', '--verify'].includes(argv[1])) return `${job.head}\n`;
      if (job && ['symbolic-ref --quiet --short HEAD', 'branch --show-current'].includes(argv.join(' '))) return `job/${job.card}\n`;
      if (job && argv[0] === 'merge-base' && argv[1] === '--is-ancestor') {
        const pair = `${argv[2]} ${argv[3] === 'HEAD' ? job.head : argv[3]}`;
        assert.ok(job.ancestry.has(pair), `unexpected scheduler ancestry pair: ${pair}`);
        if (!job.ancestry.get(pair)) throw new Error('SyntheticUnavailable: original base is not an ancestor of origin/main');
        return '';
      }
      if (job && argv[0] === 'status' && argv.includes('--porcelain')) return job.unstaged.map((file) => ` M ${file}\n`).join('');
      if (job && argv[0] === 'diff' && argv.includes('--name-only') && argv.includes('-z')) {
        const range = argv.find((arg) => arg.includes('...'));
        let files;
        if (range) {
          assert.ok(job.deltas.has(range) || range === `${base}...HEAD`, `unexpected scheduler diff range: ${range}`);
          files = job.deltas.has(range) ? job.deltas.get(range) : job.committed;
        } else files = argv.includes('--cached') ? job.staged : job.unstaged;
        return files.map((file) => `${file}\0`).join('');
      }
      if (job && argv[0] === 'ls-files' && argv.length === 4 && ['--others', '--exclude-standard', '-z'].every((arg) => argv.includes(arg))) {
        return job.untracked.map((file) => `${file}\0`).join('');
      }
      throw new Error(`unexpected scheduler git invocation: ${JSON.stringify(args)}`);
    };
    const startSession = async ({ argv, logs, afterClaim }) => {
      const prompt = argv.at(-1);
      const name = basename(logs);
      const phase = Object.keys(prefixes).find((key) => prompt.startsWith(`${prefixes[key]}\n`));
      const call = { name, prompt, phase, results: dirname(logs) };
      calls.push(call);
      const outputFile = argv[argv.indexOf('--output-last-message') + 1];
      const reply = (message, result = { exitCode: 0 }) => {
        writeFileSync(outputFile, message);
        const stream = Object.hasOwn(hookStreams, name) ? hookStreams[name] : undefined;
        writeFileSync(`${logs}.stderr.log`, stream?.stderr ?? `${STDERR_FIRST_WITNESS}Command blocked by PreToolUse hook: Blocked: a pre-approved run session\n`);
        if (!stream) return result;
        writeFileSync(`${logs}.hook-events.jsonl`, stream.events);
        return { ...result, hookEvents: `${logs}.hook-events.jsonl` };
      };
      if (!phase) {
        reached(name).resolve();
        return prompt.startsWith('End the pre-approved run: ')
          ? reply(endReply.message, endReply.result)
          : reply('Run result: stop none: scheduler fixture complete');
      }
      const context = JSON.parse(prompt.slice(prefixes[phase].length + 1));
      call.context = context;
      const callStart = active;
      if (phase === 'select') {
        assert.deepEqual(context, { runStart: callStart });
        const job = [...jobs.values()].find((entry) => !entry.selected && ['Ready', 'Backlog'].includes(entry.status)
          && !(entry.comments ?? []).some((body) => body.trimStart().startsWith('Needs owner:')));
        if (!job) {
          reached(name).resolve();
          return reply('Run result: stop none: scheduler fixture complete');
        }
        assert.equal(name, `select-${calls.filter((entry) => entry.phase === 'select' && entry.results === call.results).length}`);
        select(job);
        call.card = job.card;
        writeFileSync(`${logs}.selected.json`, JSON.stringify(selection(job, callStart)));
        reached(name).resolve();
        if (afterClaim) await afterClaim(job);
        if (gates.has(name)) await gates.get(name).promise;
        return reply(`Run result: selected ${job.card}`);
      }
      call.evidence = readPhaseEvidence(logs, context.card);
      const job = jobs.get(context.card);
      assert.ok(job?.selected, 'only the selected identity receives phase authority');
      call.card = job.card;
      assert.equal(name, `job-${job.card}-${phase}`);
      assert.deepEqual(context, phase === 'prepare' ? { phase, ...selection(job, callStart) } : { phase, ...selection(job, callStart), ...job.reference });
      if (phase === 'deliver') {
        job.assignees ??= job.selected && job.state === 'OPEN' ? ['owner'] : [];
        openDelivery += 1;
        maxDelivery = Math.max(maxDelivery, openDelivery);
      }
      reached(name).resolve();
      const result = gates.has(name) ? await gates.get(name).promise : { exitCode: 0 };
      if (phase === 'deliver') openDelivery -= 1;
      if (result.interrupted) return reply(`Run result: built ${job.card}`, result);
      if (Object.hasOwn(phaseReplies, name)) {
        const override = phaseReplies[name];
        return reply(typeof override === 'function' ? override(job) : override, result);
      }
      if (phase === 'prepare') prepare(job, dirname(logs), callStart);
      if (phase === 'build') {
        job.committed = [job.file];
        if (native) writeFileSync(join(job.worktree, job.file), `built ${job.card}\n`);
      }
      if (phase === 'deliver') {
        if (waiting.includes(job.card)) job.status = 'Awaiting push';
        else merge(job);
      }
      return reply(`Run result: ${phase === 'prepare' ? 'prepared' : phase === 'build' || job.status === 'Awaiting push' ? 'built' : 'merged'} ${job.card}`, result);
    };
    const fixture = {
      folder, jobs, calls, notifications, inspections, errors, logged, gitState,
      main: launcherMain, mainModuleUrl: pathToFileURL(toolkit.script('product-manager-run.mjs')).href, exec,
      git: native ? nativeGit : git,
      toolkit, runtime, root: toolkit.root, base, runStart, repository, select, prepare, merge, startSession,
      prepareSelected: (card) => {
        const job = jobs.get(card);
        select(job);
        prepare(job, folder, active);
        writeFileSync(join(folder, `job-${card}-prepare.context.json`), JSON.stringify({ phase: 'prepare', ...selection(job, active) }), { flag: 'wx' });
        writeFileSync(join(folder, `job-${card}-prepare.outcome.json`), JSON.stringify({ runStart: active, card, claimUrl: job.claimUrl,
          phase: 'prepare', disposition: 'prepared', reason: `Prepared card ${card} accepted by the independent fixture review` }));
        return { phase: 'build', ...selection(job, active), ...job.reference };
      },
      get maxDelivery() { return maxDelivery; },
      release: (name, result = { exitCode: 0 }) => { assert.ok(gates.has(name), `no named gate ${name}`); gates.get(name).resolve(result); },
      drain: () => new Promise((done) => setImmediate(done)),
      noGeneric: () => assert.equal(calls.filter((call) => call.prompt === 'Continue the pre-approved run.').length, 0,
        'a generic full-job dispatch grants forbidden selection/build/delivery authority'),
      has: (name) => calls.some((call) => call.name === name),
      outcome: (name, card, phase, disposition) => {
        const bytes = readFileSync(join(folder, `${name}.outcome.json`), 'utf8');
        const record = JSON.parse(bytes);
        assert.deepEqual(Object.keys(record).sort(), ['card', 'claimUrl', 'disposition', 'phase', 'reason', 'runStart']);
        assert.deepEqual({ ...record, reason: undefined }, { runStart: active, card, claimUrl: jobs.get(card).claimUrl, phase, disposition, reason: undefined });
        assert.equal(typeof record.reason, 'string');
        assert.ok(record.reason.trim());
        return bytes;
      },
      retained: (identities) => assert.match(readFileSync(join(folder, 'run-end.txt'), 'utf8'),
        new RegExp(`^Retained reservations: ${identities.length ? identities.join(',') : 'none'}$`, 'm')),
      checkpoint: async (name) => {
        const checkpoint = await Promise.race([
          reached(name).promise.then(() => name), running.then(() => 'run finished'),
          new Promise((done) => setImmediate(() => done('phase did not start'))),
        ]);
        fixture.noGeneric();
        assert.equal(checkpoint, name, `the ${name} phase checkpoint must be reached`);
      },
      notifyGate: undefined,
      notificationBytes: new Map(),
      // For a caller that runs the scheduler itself: the mark later sessions must carry, with no run started.
      activate: (mark) => { active = mark; },
      start: ({ runStart: mark = runStart } = {}) => {
        active = mark;
        running = runtime.runRun({ root: toolkit.root, folder, kind: 'pre-approved', runStart: mark,
          now: () => new Date('2026-11-05T10:15:00Z'), exec, git, startSession,
          inspectAdmission: (request, readers) => {
            const answer = runtime.inspectAdmission(request, readers);
            inspections.push({ request: structuredClone(request), answer: structuredClone(answer) });
            return answer;
          },
          notify: async (reference) => {
            notifications.push(reference);
            observeNotification?.(reference);
            if (/^job-\d+-(?:prepare|build|deliver)$/.test(reference.name)) {
              fixture.notificationBytes.set(reference.name, readFileSync(join(reference.folder, `${reference.name}.outcome.json`), 'utf8'));
            }
            reached(`notify ${reference.name}`).resolve();
            if (fixture.notifyGate?.name === reference.name) await fixture.notifyGate.gate.promise;
          }, output: { log: (text) => { logged.push(text); observeOutput?.(text); }, error: (text) => errors.push(text) },
        });
        return running;
      },
      finish: async () => {
        for (const gate of gates.values()) gate.resolve({ exitCode: 0 });
        fixture.notifyGate?.gate.resolve();
        try {
          if (running) await running;
          if (native) for (const job of jobs.values()) {
            if (job.selected && existsSync(job.worktree)) nativeGit(['worktree', 'remove', '--force', job.worktree]);
          }
        } finally { rmSync(home, { recursive: true, force: true }); }
      },
      settledOnce: () => {
        const phaseCalls = calls.filter((call) => call.phase);
        assert.equal(new Set(phaseCalls.map((call) => call.name)).size, phaseCalls.length, 'each phase is dispatched once');
        assert.equal(new Set(notifications.map((reference) => reference.name)).size, notifications.length, 'each outcome is notified once');
        assert.deepEqual(notifications.filter((reference) => phaseCalls.some((call) => call.name === reference.name)).map((reference) => reference.name).sort(),
          phaseCalls.map((call) => call.name).sort(), 'every settled phase has one notification');
        for (const call of phaseCalls) assert.ok(existsSync(join(folder, `${call.name}.outcome.json`)), `${call.name}: durable outcome`);
      },
    };
    return fixture;
  };
}

export const SYSTEMD_RUN = '/usr/bin/systemd-run';
export const SYSTEMCTL = '/usr/bin/systemctl';

export function nativeSystemd(command, args) {
  const result = childProcess.spawnSync(command, args, { encoding: 'utf8', timeout: 8000, maxBuffer: 65536 });
  if (result.error) throw result.error;
  return result;
}

export function probeManagedSystemd() {
  if (process.platform !== 'linux') return `a Linux user service manager is required (platform: ${process.platform})`;
  for (const executable of [SYSTEMD_RUN, SYSTEMCTL, '/usr/bin/loginctl', '/usr/bin/xdg-dbus-proxy']) {
    if (!existsSync(executable)) return `native executable unavailable: ${executable}`;
  }
  const runtime = nativeSystemd('/usr/bin/loginctl', ['show-user', String(process.getuid()), '--property=RuntimePath', '--value']);
  if (runtime.status !== 0 || !runtime.stdout.trim()) return `native user runtime directory unavailable: ${runtime.stderr.trim()}`;
  const runtimeDir = runtime.stdout.trim();
  if (!existsSync(join(runtimeDir, 'bus'))) return `native session bus socket unavailable in ${runtimeDir}`;
  const unit = `fabraik-fixture-probe-${randomBytes(16).toString('hex')}.service`;
  const result = nativeSystemd(SYSTEMD_RUN, ['--user', '--wait', '--pipe', '--quiet', '--expand-environment=no',
    `--unit=${unit}`, '--working-directory=/', '--property=Type=exec', '--property=ExitType=main',
    '--property=KillMode=control-group', '--property=Restart=no', '--property=TimeoutStopSec=2s',
    '--property=ExecStartPre=/usr/bin/true', '--property=ExecStopPost=/usr/bin/true', '/usr/bin/true']);
  if (result.status === 0) return undefined;
  const diagnostic = result.stderr.trim();
  if (/failed to connect to (?:user scope )?bus|failed to connect to user (?:manager|service manager)/i.test(diagnostic)) return diagnostic;
  if (/(?:unrecognized|unknown|unsupported|cannot set|not supported|invalid)/i.test(diagnostic)
    && /expand-environment|ExitType|KillMode|Restart|TimeoutStopSec|ExecStartPre|ExecStopPost|Type=exec/i.test(diagnostic)) return diagnostic;
  assert.fail(`native managed phase preflight failed: ${diagnostic}`);
}
