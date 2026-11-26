// Observes admission, native app binding and phase preparation, and launcher refusals.
// Synthetic admission uses private records and scripted board and Git readers. The default Git reader
// cases use finite child processes for inventory and filename bytes, with no network or model calls.

import childProcess, { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitEnvironment } from './factory-sync.mjs';
import { main } from '../pre-approved-run.mjs';
import { copyToolkit, GITHUB_TEST_CONFIG } from './board-toolkit-copy.mjs';
import { admissionFixture, readPhaseEvidence } from './pre-approved-fixture.mjs';

const USAGE = 'usage: node scripts/pre-approved-run.mjs --check-admission <absolute request file> | --bind-app-job <absolute request file> | --prepare-app-phase <absolute phase-log-base> <ready-session-uuid> <original-claim-created-at> [<absolute admission-request-file>]';
const COORDINATOR = '11111111-1111-4111-8111-111111111111';

// A starter that replies from the script, one reply per session: { message, stderr, events, exitCode, spawnError }. A
// reply without a message, stderr or events writes no such file. `maxOpen` is the most sessions ever open at once.
function scriptedSessions(replies) {
  const calls = [];
  let open = 0;
  let maxOpen = 0;
  const startSession = async ({ argv, logs }) => {
    const reply = replies[calls.length];
    if (!reply) throw new Error(`session ${calls.length + 1} was not expected`);
    const outputFile = argv[argv.indexOf('--output-last-message') + 1];
    calls.push({ prompt: argv.at(-1), outputFile });
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    await new Promise((later) => setImmediate(later));
    if (reply.message !== undefined) writeFileSync(outputFile, reply.message);
    if (reply.stderr !== undefined) writeFileSync(`${logs}.stderr.log`, reply.stderr);
    if (reply.events !== undefined) writeFileSync(`${logs}.jsonl`, reply.events);
    open -= 1;
    return { exitCode: reply.exitCode ?? 0, spawnError: reply.spawnError };
  };
  return { startSession, calls, get maxOpen() { return maxOpen; } };
}


// Admission uses the existing GitHub-configured toolkit fixture so installed tracker choices cannot change its oracle.
// Recurring cost: one toolkit copy, legacy admission/argv contrasts plus independent inventory/comment-page/Epic cases,
// with the existing main root lookup per trace; no network or model. No card carries an approval record: admission
// judges claim ownership and exclusive resources alone.
test('ANTI-REGRESSION: pre-approved admission needs no approval record, only ownership and disjoint exclusive resources', async (t) => {
  const toolkit = copyToolkit(GITHUB_TEST_CONFIG);
  t.after(() => toolkit.cleanup());
  copyFileSync(new URL('../pre-approved-run.mjs', import.meta.url), toolkit.script('pre-approved-run.mjs'));
  copyFileSync(new URL('./checkout-context.mjs', import.meta.url), toolkit.script('lib/checkout-context.mjs'));
  copyFileSync(new URL('./pre-approved-run.mjs', import.meta.url), toolkit.script('lib/pre-approved-run.mjs'));
  copyFileSync(new URL('./closeout-cleanup.mjs', import.meta.url), toolkit.script('lib/closeout-cleanup.mjs'));
  copyFileSync(new URL('./run-folder.mjs', import.meta.url), toolkit.script('lib/run-folder.mjs'));
  const { main: admissionMain } = await toolkit.load('pre-approved-run.mjs');
  const { boardReadExec, leanBoardPage, leanNode } = await toolkit.load('lib/board-fixtures.mjs');
  const { BOARD_OWNER, BOARD_REPOSITORY } = await toolkit.load('lib/board-config.mjs');
  const repository = `${BOARD_OWNER}/${BOARD_REPOSITORY}`;
  const repositoryId = 'R_admission_fixture';
  const runStart = '2026-11-05T10:00:00Z';
  const base = 'a'.repeat(40);
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const cases = [
    { name: 'shared file', decision: 'allow', code: 0 },
    { name: 'disjoint', decision: 'allow', code: 0 },
    { name: 'shared resource', decision: 'wait', code: 3, reason: /preview-port/ },
    { name: 'prerequisite', decision: 'wait', code: 3, reason: /\b7\b/ },
    { name: 'replaced claim', decision: 'unavailable', code: 1, reason: /claim/i },
    { name: 'changed review bytes', decision: 'unavailable', code: 1, reason: /review/i },
    { name: 'corrupt descriptor', decision: 'unavailable', code: 1, reason: /scope|complete|descriptor/i },
    { name: 'legacy scopeComplete field', decision: 'unavailable', code: 1, reason: /descriptor/ },
  ];
  const check = async (scenario) => {
    const home = mkdtempSync(join(tmpdir(), 'product-manager-admission-'));
    const origin = scenario.origin ?? `https://github.com/${repository}.git`;
    const results = join(home, 'results');
    mkdirSync(results);
    const jobs = new Map();
    const prepare = (card) => {
      const worktree = join(home, `job-${card}`);
      mkdirSync(worktree);
      const planPath = join(worktree, 'plan.md');
      writeFileSync(planPath, `Reviewed scope for card ${card}.\n`);
      const planHash = digest(readFileSync(planPath));
      const descriptorPath = join(results, `job-${card}.prepared.json`);
      const reviewRecordPath = join(results, `job-${card}.reviewed.json`);
      const reviewEvidencePath = join(results, `job-${card}-review.md`);
      const claimUrl = `https://github.com/${repository}/issues/${card}#issuecomment-${100 + card}`;
      const descriptor = {
        runStart, card, claimUrl, priorClaimUrls: [], branch: `job/${card}`, worktree, base, planPath, planHash,
        plannedFiles: [card === 7 || scenario.name === 'shared file' ? 'shared-file' : 'independent-file'],
        prerequisites: card === 8 && scenario.prerequisiteRead ? [{ repository, number: 9 }]
          : card === 8 && scenario.name === 'prerequisite' ? [{ repository, number: 7 }] : [],
        exclusiveResources: scenario.name === 'shared resource' ? ['preview-port'] : [`preview-${card}`],
      };
      // @ts-expect-error The corrupt-descriptor scenario removes a required field on purpose.
      if (card === 8 && scenario.name === 'corrupt descriptor') delete descriptor.exclusiveResources;
      if (card === 8 && scenario.name === 'legacy scopeComplete field') descriptor.scopeComplete = true;
      writeFileSync(descriptorPath, JSON.stringify(descriptor));
      const descriptorHash = digest(readFileSync(descriptorPath));
      writeFileSync(reviewEvidencePath, 'Required independent plan review accepted the descriptor and plan.\n');
      const reviewEvidenceHash = digest(readFileSync(reviewEvidencePath));
      writeFileSync(reviewRecordPath, JSON.stringify({
        runStart, card, claimUrl, descriptorPath, descriptorHash, planPath, planHash,
        reviewEvidencePath, reviewEvidenceHash, verdict: 'accepted',
      }));
      if (card === 8 && scenario.name === 'changed review bytes') writeFileSync(reviewEvidencePath, 'Review bytes changed after acceptance.\n');
      const claim = {
        author: { login: 'owner' }, createdAt: '2026-11-05T10:01:00Z', lastEditedAt: null,
        url: card === 8 && scenario.name === 'replaced claim' ? `https://github.com/${repository}/issues/${card}#issuecomment-${300 + card}` : claimUrl,
        body: `Claim: fixture-machine Codex job/${card} ${worktree}`,
      };
      const issue = { state: 'OPEN', title: `Prepared card ${card}`, lastEditedAt: null,
        comments: { pageInfo: { hasNextPage: false }, nodes: [claim] } };
      const job = { descriptor, issue, reference: { descriptorPath, descriptorHash, planHash, reviewRecordPath } };
      jobs.set(card, job);
      const selection = { runStart, card, claimUrl, priorClaimUrls: [], branch: descriptor.branch, worktree, base };
      writeFileSync(join(results, `job-${card}-prepare.context.json`), JSON.stringify({ phase: 'prepare', ...selection }), { flag: 'wx' });
      writeFileSync(join(results, `job-${card}-prepare.outcome.json`), JSON.stringify({ runStart, card, claimUrl,
        phase: 'prepare', disposition: 'prepared', reason: 'Independent preparation accepted the fixture descriptor' }), { flag: 'wx' });
      if (card === 7 || scenario.phase === 'deliver') {
        for (const phase of card === 7 ? ['build', 'deliver'] : ['build']) {
          if (card === 8 && scenario.builtEvidence === 'missing build context') continue;
          writeFileSync(join(results, `job-${card}-${phase}.context.json`), JSON.stringify({ phase, ...selection, ...job.reference,
            ...(card === 8 && scenario.builtEvidence === 'mismatched build context' ? { claimUrl: claimUrl + '-other' } : {}) }), { flag: 'wx' });
        }
        if (!(card === 8 && scenario.builtEvidence === 'missing built outcome')) {
          writeFileSync(join(results, `job-${card}-build.outcome.json`), JSON.stringify({ runStart,
            card: card === 8 && scenario.builtEvidence === 'mismatched built outcome' ? 9 : card, claimUrl,
            phase: 'build', disposition: 'built', reason: 'Completed fixture build verification' }), { flag: 'wx' });
        }
      }
      return job;
    };
    const a = scenario.inventory ? undefined : prepare(7);
    const b = prepare(8);
    const extra = scenario.inventory && { state: 'OPEN', title: 'Historical or current card 9', lastEditedAt: null,
      comments: { nodes: [
        ...scenario.inventory.comments.map((body, index) => ({ author: { login: 'owner' }, createdAt: '2026-11-04T10:00:00Z',
          lastEditedAt: null, url: `https://github.com/${repository}/issues/9#issuecomment-${300 + index}`, body })),
      ] } };
    const extraWorktree = scenario.inventory?.worktree ? join(home, 'job-9') : undefined;
    if (extraWorktree) mkdirSync(extraWorktree);
    const request = { runStart, phase: scenario.phase ?? 'build', candidate: b.reference, reservations: a ? [{ ...a.reference, phase: 'deliver' }] : [] };
    const makeBoard = () => boardReadExec({ board: [leanBoardPage([
      ...[...jobs.keys()].map((card) => leanNode({
        id: `PVTI_admission_${card}`, title: `Prepared card ${card}`, status: card === 7 ? 'Awaiting push' : 'In progress',
        content: { __typename: 'Issue', number: card, assignees: ['owner'],
          ...(card === 7 && scenario.epicReservation ? { labels: ['epic'] } : {}) },
      })),
      ...(extra ? [leanNode({ id: 'PVTI_admission_9', title: extra.title, status: scenario.inventory.status,
        content: { __typename: 'Issue', number: 9, assignees: scenario.inventory.assignees ?? [],
          ...(scenario.inventory.epic ? { labels: ['epic'], subIssuesSummary: { total: 2, completed: 0 } } : {}) } })] : []),
    ])] });
    let board = makeBoard();
    const ghCalls = [];
    const exec = (args) => {
      ghCalls.push([...args]);
      if (args[0] === 'repo' && args[1] === 'view' && args.includes('--json')) {
        return JSON.stringify({ id: repositoryId, nameWithOwner: repository, defaultBranchRef: { name: 'main' } });
      }
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (args[0] === 'api' && args[1] === 'graphql' && query.includes('comments(first: 100)')) {
        const number = Number(args.find((arg) => /^number=\d+$/.test(arg))?.slice('number='.length));
        assert.ok(jobs.has(number) || (number === 9 && extra), `unexpected approval identity: ${JSON.stringify(args)}`);
        const issue = number === 9 ? { ...extra, comments: { pageInfo: { hasNextPage: extra.comments.nodes.length > 100 },
          nodes: extra.comments.nodes.slice(0, 100) } } : jobs.get(number).issue;
        return JSON.stringify({ data: { viewer: { login: 'owner' }, repository: { id: repositoryId, issue } } });
      }
      if (args[0] === 'api' && args[1] === 'graphql' && query.includes('comments(last:100')) {
        const before = args.find((arg) => arg.startsWith('before='));
        if (before !== undefined) {
          assert.ok(extra && args.includes('number=9') && before === 'before=older-9', `unexpected older comment identity: ${JSON.stringify(args)}`);
          if (scenario.inventory.unreadable) throw new Error('SyntheticUnavailable: older comments for card 9 could not be read');
          const nodes = extra.comments.nodes.slice(0, -100).map(({ body, url, author }) => ({ body, url, author }));
          return JSON.stringify({ data: { repository: { issue: { number: 9, comments: { totalCount: extra.comments.nodes.length,
            pageInfo: { hasPreviousPage: false, startCursor: 'oldest-9' }, nodes } } } } });
        }
        const aliases = {};
        for (const [, alias, text] of query.matchAll(/(i(\d+)): issue\(number:\d+\)/g)) {
          const number = Number(text);
          assert.ok(jobs.has(number) || (number === 9 && extra), `unexpected detail identity: ${number}`);
          const nodes = (number === 9 ? extra : jobs.get(number).issue).comments.nodes.map(({ body, url, author }) => ({ body, url, author }));
          aliases[alias] = { number, body: `Scope evidence for card ${number}.`,
            parent: number === 8 && scenario.inventory?.epic ? { number: 9 } : null, comments: {
            totalCount: nodes.length + (number === 9 && scenario.inventory.partial ? 1 : 0),
            pageInfo: { hasPreviousPage: nodes.length > 100, startCursor: nodes.length > 100 ? 'older-9' : null },
            nodes: nodes.slice(-100),
          } };
        }
        assert.ok(Object.keys(aliases).length, `unexpected detail query: ${query}`);
        return JSON.stringify({ data: { repository: aliases } });
      }
      if (scenario.prerequisiteRead && args[0] === 'issue' && args[1] === 'view' && args[2] === '9') {
        assert.deepEqual(args, ['issue', 'view', '9', '--repo', repository, '--json', 'state']);
        if (scenario.prerequisiteRead === 'throw') throw new Error('SyntheticUnavailable: explicit prerequisite read failed');
        return JSON.stringify(scenario.prerequisiteRead === 'closed' ? { state: 'CLOSED' }
          : scenario.prerequisiteRead === 'absent' ? {} : { state: 'UNKNOWN' });
      }
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '7' && args.includes('--json') && args.includes('state')) {
        return JSON.stringify({ state: 'OPEN' });
      }
      if (args[0] === 'api' && args[1] === 'graphql') return board.exec(args);
      throw new Error(`unexpected gh invocation: ${JSON.stringify(args)}`);
    };
    const git = (args) => {
      const argv = [...args];
      const worktree = argv[0] === '-C' ? argv.splice(0, 2)[1] : undefined;
      const job = [...jobs.values()].find((entry) => entry.descriptor.worktree === worktree);
      if (worktree !== undefined) assert.ok(job, `unexpected git worktree: ${worktree}`);
      if (argv[0] === 'worktree' && argv[1] === 'list' && argv[2] === '--porcelain') {
        const separator = argv.includes('-z') ? '\0' : '\n';
        const integration = [`worktree ${toolkit.root}`, `HEAD ${base}`, 'branch refs/heads/main', '', ''].join(separator);
        return integration + [...jobs.values()].map(({ descriptor }) => [
          `worktree ${descriptor.worktree}`, `HEAD ${descriptor.card === 7 ? 'b'.repeat(40) : base}`, `branch refs/heads/${descriptor.branch}`, '', '',
        ].join(separator)).join('')
          + (extraWorktree ? [`worktree ${extraWorktree}`, `HEAD ${base}`, 'branch refs/heads/job/9', '', ''].join(separator) : '');
      }
      if (argv[0] === 'remote' && argv[1] === 'get-url') return `${origin}\n`;
      if (worktree === undefined && argv.join(' ') === 'rev-parse --verify refs/remotes/origin/main^{commit}') return `${base}\n`;
      if (job && argv[0] === 'rev-parse' && ['HEAD', '--verify'].includes(argv[1])) return `${job.descriptor.card === 7 ? 'b'.repeat(40) : base}\n`;
      if (job && argv.join(' ') === 'rev-parse --show-toplevel') return `${worktree}\n`;
      if (job && argv.join(' ') === 'symbolic-ref --quiet --short HEAD') return `${job.descriptor.branch}\n`;
      if (job && argv.join(' ') === 'branch --show-current') return `${job.descriptor.branch}\n`;
      if (job && argv[0] === 'status' && argv.includes('--porcelain')) return '';
      if (job && argv[0] === 'diff' && argv.includes('--name-only') && argv.includes('-z')) {
        const committed = argv.some((arg) => arg.includes(base));
        if (committed && job.descriptor.card === 8 && scenario.nulList !== undefined) return scenario.nulList;
        return committed && job.descriptor.card === 7 ? 'shared-file\0' : '';
      }
      if (job && argv[0] === 'ls-files' && argv.length === 4 && ['--others', '--exclude-standard', '-z'].every((arg) => argv.includes(arg))) return '';
      if (job && argv[0] === 'merge-base' && argv[1] === '--is-ancestor') return '';
      throw new Error(`unexpected git invocation: ${JSON.stringify(args)}`);
    };
    const sessions = scriptedSessions([]);
    const logged = [];
    try {
      const code = await admissionMain([], {
        coordinator: COORDINATOR, admissionRequest: request, exec, git,
        now: () => new Date('2026-11-05T10:15:00Z'), startSession: sessions.startSession,
        notify: async () => {}, output: { log: (text) => logged.push(text), error: (text) => logged.push(text) },
      });
      if (scenario.credentials) {
        t.diagnostic(`${scenario.name}: gh calls=${ghCalls.length}; model dispatches=${sessions.calls.length}`);
        assert.equal(ghCalls.length, 0, 'a credential-bearing origin must be refused before any gh invocation');
        for (const privateValue of [...scenario.credentials, origin]) {
          assert.ok(!logged.join('\n').includes(privateValue), 'origin credentials and the raw URL must stay out of all output');
        }
      }
      assert.equal(sessions.calls.length, 0, `${scenario.name}: read-only admission must never dispatch a model`);
      if (scenario.inventory || scenario.epicReservation) t.diagnostic(`inventory ${scenario.name}: exit=${code}; actual=${logged.join('\n')}`);
      assert.equal(code, scenario.code, `${scenario.name}: ${logged.join('\n')}`);
      assert.equal(logged.length, 1, 'admission returns one JSON decision');
      const answer = JSON.parse(logged[0]);
      assert.deepEqual(Object.keys(answer).sort(), ['decision', 'reasons']);
      assert.equal(answer.decision, scenario.decision, scenario.name);
      assert.ok(Array.isArray(answer.reasons) && answer.reasons.every((reason) => typeof reason === 'string'));
      if (scenario.decision === 'allow') assert.deepEqual(answer.reasons, []);
      else {
        assert.ok(answer.reasons.length > 0, scenario.name);
        assert.match(answer.reasons.join('\n'), scenario.reason, scenario.name);
        if (scenario.expectedReason !== undefined) assert.deepEqual(answer.reasons, [scenario.expectedReason], scenario.name);
      }
      if (scenario.inventory?.paged) {
        assert.ok(ghCalls.some((args) => args.includes('before=older-9')), 'complete held-job evidence includes the older comment page');
      }
      t.diagnostic(`dependency ${scenario.name}: ${code} ${answer.decision}; dispatches=${sessions.calls.length}`);
      if (scenario.name === 'shared resource' || scenario.name === 'disjoint') {
        const requestFile = join(results, 'admission-request.json');
        writeFileSync(requestFile, JSON.stringify(request));
        board = makeBoard();
        const publicOutput = [];
        const publicCode = await admissionMain(['--check-admission', requestFile], {
          coordinator: COORDINATOR, exec, git,
          now: () => new Date('2026-11-05T10:15:00Z'), startSession: sessions.startSession,
          notify: async () => {}, output: { log: (text) => publicOutput.push(text), error: (text) => publicOutput.push(text) },
        });
        // Repeat the independent policy oracle at the public argv boundary; the original trace is asserted above.
        assert.equal(sessions.calls.length, 0, `${scenario.name}: public admission must never dispatch a model`);
        assert.equal(publicCode, scenario.code, scenario.name);
        assert.equal(publicOutput.length, 1, 'public admission returns one JSON decision');
        assert.deepEqual(JSON.parse(publicOutput[0]), answer, scenario.name);
        t.diagnostic(`public argv ${scenario.name}: ${publicCode} ${answer.decision}; dispatches=${sessions.calls.length}`);
      }
    } finally {
      const outputFolder = sessions.calls[0] && dirname(sessions.calls[0].outputFile);
      if (outputFolder) rmSync(outputFolder, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
  for (const scenario of cases) await check(scenario);

  // ANTI-REGRESSION: credential custody is independent of prerequisite wait classification; both failures must execute.
  await t.test('ANTI-REGRESSION: admission origin credential custody', async (custody) => {
    for (const origin of [`ssh://git@github.com/${repository}.git`, `git@github.com:${repository}.git`]) {
      await check({ name: 'supported SSH origin', origin, decision: 'allow', code: 0 });
    }
    for (const { name, origin } of [
      { name: 'ordinary no-user SCP origin', origin: `github.com:${repository}.git` },
      { name: 'ordinary no-user SSH URI origin', origin: `ssh://github.com/${repository}.git` },
      { name: 'ordinary Git URI origin', origin: `git://github.com/${repository}.git` },
      { name: 'provider-confirmed case variant origin', origin: `https://github.com/${repository.toUpperCase()}.git` },
      { name: 'provider-confirmed renamed path origin', origin: `https://github.com/${BOARD_OWNER}/former-repo.git` },
    ]) await custody.test(name, () => check({ name, origin, decision: 'allow', code: 0 }));
    await custody.test('unsupported opaque credential-shaped origin', () => check({
      name: 'unsupported opaque credential-shaped origin',
      origin: `synthetic-user:synthetic-password@github.com:${repository}.git`,
      credentials: ['synthetic-user', 'synthetic-password'], decision: 'unavailable', code: 1,
      reason: /^admission origin URL is invalid$/, expectedReason: 'admission origin URL is invalid',
    }));
    for (const origin of [
      `https://synthetic-user:synthetic-password@github.com/${repository}.git`,
      `https://synthetic-user@github.com/${repository}.git`,
      `ssh://git:synthetic-password@github.com/${repository}.git`,
    ]) {
      await check({ name: 'credential-bearing origin', origin, credentials: ['synthetic-user', 'synthetic-password'],
        decision: 'unavailable', code: 1, reason: /credential|userinfo|password/i });
    }
    for (const { family, origin } of [
      { family: 'HTTPS', origin: `https://github.com/${repository}.git` },
      { family: 'SSH', origin: `ssh://git@github.com/${repository}.git` },
      { family: 'SCP', origin: `git@github.com:${repository}.git` },
    ]) for (const { kind, suffix, secret } of [
      { kind: 'query', suffix: '?access_token=synthetic-query-secret', secret: 'synthetic-query-secret' },
      { kind: 'fragment', suffix: '#synthetic-fragment-secret', secret: 'synthetic-fragment-secret' },
    ]) await custody.test(`${family} origin ${kind} credentials`, () => check({
      name: `${family} origin ${kind} credentials`, origin: origin + suffix, credentials: [secret],
      decision: 'unavailable', code: 1, reason: /query or fragment credentials/,
      expectedReason: 'admission origin must not contain query or fragment credentials',
    }));
  });
  await t.test('ANTI-REGRESSION: unreadable explicit prerequisite waits', async () => {
    await check({ name: 'closed off-board prerequisite', prerequisiteRead: 'closed', decision: 'allow', code: 0 });
    for (const prerequisiteRead of ['throw', 'absent', 'invalid']) {
      await check({ name: 'unreadable off-board prerequisite', prerequisiteRead, decision: 'wait', code: 3,
        reason: /(?:9.*(?:unreadable|unavailable)|(?:unreadable|unavailable).*9)/i });
    }
  });
  // Controls for the NUL path-list protocol at the injected Git boundary.
  for (const { name, nulList } of [
    { name: 'missing terminator', nulList: 'independent-file' },
    { name: 'empty interior entry', nulList: 'independent-file\0\0independent-file\0' },
  ]) {
    await t.test(`malformed NUL changed-path list: ${name}`, () => check({ name: `malformed NUL ${name}`, nulList, phase: 'deliver',
      decision: 'unavailable', code: 1, reason: /card 8.*changed path|changed path.*card 8/i }));
  }
  for (const builtEvidence of ['valid', 'missing build context', 'mismatched build context', 'missing built outcome', 'mismatched built outcome']) {
    await t.test(`delivery authority requires ${builtEvidence} build evidence`, () => check({
      name: `delivery ${builtEvidence}`, phase: 'deliver', builtEvidence,
      decision: builtEvidence === 'valid' ? 'allow' : 'unavailable', code: builtEvidence === 'valid' ? 0 : 1,
      reason: /build|built/i,
    }));
  }
  const oldClaim = 'Claim: former-machine Claude job/9 /historical/job-9';
  const heldJob = '  Needs owner: preparation parked. Job: job/9 on former-machine.  \nWorklog: retained review notes.';
  const newestComments = Array.from({ length: 100 }, (_, index) => `Later worklog note ${index}.`);
  const inventoryCases = [
    { name: 'unassigned pickable history', inventory: { status: 'Ready', comments: [oldClaim] }, decision: 'allow', code: 0 },
    { name: 'assigned Backlog history after reopen', inventory: { status: 'Backlog', assignees: ['owner'],
      comments: [oldClaim, 'Reopened: prior session released the card.'] }, decision: 'allow', code: 0 },
    { name: 'remote In progress unknown scope', inventory: { status: 'In progress', assignees: ['owner'], comments: [] },
      decision: 'wait', code: 3, reason: /\b9\b/ },
    { name: 'remote In progress unknown scope blocks delivery', phase: 'deliver',
      inventory: { status: 'In progress', assignees: ['owner'], comments: [] }, decision: 'wait', code: 3, reason: /\b9\b/ },
    { name: 'earlier Awaiting push unknown scope', inventory: { status: 'Awaiting push', assignees: ['owner'], comments: [oldClaim] },
      decision: 'wait', code: 3, reason: /\b9\b/ },
    { name: 'held first-line job followed by worklog note', inventory: { status: 'Backlog', comments: [heldJob] },
      decision: 'wait', code: 3, reason: /\b9\b/ },
    { name: 'no-job hold mentioning Job in a question', inventory: { status: 'Backlog',
      comments: ['Needs owner: should the next Job: use a different machine?',
        'Needs owner: should prior work resume? Job: job/8 on former-machine.'] }, decision: 'allow', code: 0 },
    { name: 'Returned first-line former job', inventory: { status: 'Backlog',
      comments: ['Returned: preparation released. Job: job/9 on former-machine.'] }, decision: 'allow', code: 0 },
    { name: 'held job before the newest hundred comments', inventory: { status: 'Backlog', comments: [heldJob, ...newestComments], paged: true },
      decision: 'wait', code: 3, reason: /\b9\b/ },
    { name: 'partial comment detail remains unavailable', inventory: { status: 'Backlog', comments: ['A worklog note.'], partial: true },
      decision: 'unavailable', code: 1, reason: /9.*(?:comment|detail|incomplete|unavailable|read)|(?:comment|detail|incomplete|unavailable|read).*9/i },
    { name: 'unreadable older comment page remains unavailable', inventory: { status: 'Backlog', comments: [heldJob, ...newestComments], unreadable: true },
      decision: 'unavailable', code: 1, reason: /older comments for card 9 could not be read/i },
  ];
  for (const scenario of inventoryCases) await t.test(`inventory: ${scenario.name}`, () => check(scenario));
  const epicParent = { status: 'In progress', assignees: ['owner'], comments: [], epic: true };
  for (const scenario of [
    { name: 'active Epic parent status alone grants no job reservation', inventory: { ...epicParent }, decision: 'allow', code: 0 },
    { name: 'Epic parent actual job worktree retains its reservation', inventory: { ...epicParent, worktree: true },
      decision: 'wait', code: 3, reason: /\b9\b/ },
    { name: 'Epic parent held job retains its reservation', inventory: { ...epicParent,
      comments: ['Needs owner: parent work parked. Job: job/9 on former-machine.'] }, decision: 'wait', code: 3, reason: /\b9\b/ },
  ]) await t.test(scenario.name, () => check(scenario));
  await t.test('Epic supplied reviewed reservation retains its resource conflict',
    () => check({ ...cases.find(({ name }) => name === 'shared resource'), epicReservation: true }));

});

async function readAdmission(t, fixture, request, { exec = fixture.exec, git = fixture.git } = {}) {
  const requestFile = join(fixture.folder, 'admission-request.json');
  const requestBytes = JSON.stringify(request);
  writeFileSync(requestFile, requestBytes);
  const printed = [];
  let dispatches = 0;
  const readGit = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    assert.equal(options?.encoding, 'utf8');
    return `${join(fixture.root, '.git')}\n`;
  });
  try {
    syncBuiltinESMExports();
    const code = await fixture.main(['--check-admission', requestFile], {
      exec, git, startSession: async () => { dispatches += 1; return { exitCode: 0 }; },
      output: { log: (text) => printed.push(text), error: (text) => printed.push(text) },
    });
    assert.equal(readGit.mock.callCount(), 1, 'only the common-directory lookup uses real process bindings');
    assert.equal(dispatches, 0, 'read-only admission never starts a model');
    assert.equal(printed.length, 1, 'the CLI prints one admission reply');
    assert.equal(readFileSync(requestFile, 'utf8'), requestBytes);
    const answer = JSON.parse(printed[0]);
    t.diagnostic(JSON.stringify({ code, answer, dispatches }));
    return { code, answer };
  } finally {
    readGit.mock.restore();
    syncBuiltinESMExports();
  }
}

test('admission refuses unproved inactive reservations', async (t) => {
  const create = await admissionFixture(t);
  for (const fact of ['application delta', 'nonprepared outcome', 'unreadable prerequisite']) await t.test(`inactive exception refuses ${fact}`, async (t) => {
    const fixture = create({ cards: [91, 92] });
    try {
      const a = fixture.jobs.get(91);
      const b = fixture.jobs.get(92);
      a.file = 'scope/a';
      b.file = 'scope/b';
      a.exclusiveResources = b.exclusiveResources = ['shared-preview'];
      const repository = new URL(a.claimUrl).pathname.split('/').slice(1, 3).join('/');
      if (fact === 'unreadable prerequisite') a.prerequisites = [{ repository, number: 9 }];
      // The candidate's earlier claim would win over a rival wrongly classed inactive.
      a.claimCreatedAt = '2026-11-05T10:03:00Z';
      b.claimCreatedAt = '2026-11-05T10:02:00Z';
      fixture.prepareSelected(91);
      fixture.prepareSelected(92);
      if (fact === 'application delta') a.unstaged = ['scope/a'];
      if (fact === 'nonprepared outcome') {
        const path = join(fixture.folder, 'job-91-prepare.outcome.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        writeFileSync(path, JSON.stringify({ ...record, disposition: 'parked', reason: 'Preparation parked before acceptance' }));
      }
      const { code, answer } = await readAdmission(t, fixture, { runStart: fixture.runStart, phase: 'build',
        candidate: b.reference, reservations: [{ ...a.reference, phase: 'prepare' }] }, {
        exec: (args) => {
          if (args[0] === 'issue' && args[1] === 'view' && args[2] === '9') throw new Error('SyntheticUnavailable: rival prerequisite 9 could not be read');
          return fixture.exec(args);
        },
      });
      assert.equal(code, 3);
      assert.equal(answer.decision, 'wait', 'unproved inactive intent remains a binding reservation');
      assert.match(answer.reasons.join('\n'), /91/);
      if (fact === 'unreadable prerequisite') {
        assert.match(answer.reasons.join('\n'), /9\b/);
        assert.match(answer.reasons.join('\n'), /unreadable|unavailable/i);
      } else assert.match(answer.reasons.join('\n'), /shared-preview/);
    } finally {
      await fixture.finish();
    }
  });
});

test('admission verifies retained active build evidence', async (t) => {
  const create = await admissionFixture(t);
  // In the valid case, 92 has the earlier claim and 91's active build keeps its reservation binding.
  for (const evidence of ['missing', 'malformed', 'valid']) await t.test(evidence === 'valid'
    ? 'empty started build with valid context remains binding' : `empty started build with ${evidence} context is unavailable`, async (t) => {
    const fixture = create({ cards: [91, 92] });
    try {
      const a = fixture.jobs.get(91);
      const b = fixture.jobs.get(92);
      a.file = 'scope/a';
      b.file = 'scope/b';
      a.exclusiveResources = b.exclusiveResources = ['shared-preview'];
      if (evidence === 'valid') {
        a.claimCreatedAt = '2026-11-05T10:03:00Z';
        b.claimCreatedAt = '2026-11-05T10:02:00Z';
      }
      const context = fixture.prepareSelected(91);
      fixture.prepareSelected(92);
      const path = join(fixture.folder, 'job-91-build.context.json');
      const outcome = join(fixture.folder, 'job-91-build.outcome.json');
      if (evidence !== 'missing') writeFileSync(path, JSON.stringify(context));
      if (evidence === 'malformed') writeFileSync(path, '{');
      if (evidence === 'valid') {
        const { planPath, plannedFiles, prerequisites, exclusiveResources, ...selection } = a.descriptor;
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { phase: 'build', ...selection, ...a.reference });
        assert.equal(planPath, join(a.worktree, 'plan.md'));
        assert.deepEqual(plannedFiles, ['scope/a']);
        assert.deepEqual(prerequisites, []);
        assert.deepEqual(exclusiveResources, ['shared-preview']);
      } else if (evidence === 'malformed') assert.equal(readFileSync(path, 'utf8'), '{');
      else assert.equal(existsSync(path), false);
      assert.equal(existsSync(outcome), false);
      assert.deepEqual([a.committed, a.unstaged, a.staged, a.untracked], [[], [], [], []]);

      const { code, answer } = await readAdmission(t, fixture, { runStart: fixture.runStart, phase: 'build',
        candidate: b.reference, reservations: [{ ...a.reference, phase: 'build' }] });
      assert.equal(existsSync(outcome), false);
      assert.match(answer.reasons.join('\n'), /91/);
      if (evidence === 'valid') {
        assert.equal(code, 3);
        assert.equal(answer.decision, 'wait', 'a started empty build remains a binding reservation');
        assert.match(answer.reasons.join('\n'), /shared-preview/);
      } else {
        assert.equal(code, 1);
        assert.equal(answer.decision, 'unavailable', 'lost or corrupt active execution evidence cannot become inactive intent');
        assert.match(answer.reasons.join('\n'), /context|evidence|JSON/i);
      }
    } finally {
      await fixture.finish();
    }
  });
});

function prepareCloseout(fixture) {
  const a = fixture.jobs.get(91);
  const c = fixture.jobs.get(93);
  a.exclusiveResources = c.exclusiveResources = ['shared-preview'];
  const contexts = [91, 92, 93].map((card) => fixture.prepareSelected(card));
  for (const context of contexts.slice(0, 2)) {
    const { runStart, card, claimUrl } = context;
    const build = join(fixture.folder, `job-${card}-build`);
    writeFileSync(`${build}.context.json`, JSON.stringify(context));
    writeFileSync(`${build}.outcome.json`, JSON.stringify({
      runStart, card, claimUrl, phase: 'build', disposition: 'built', reason: `Completed fixture build for card ${card}`,
    }));
    const job = fixture.jobs.get(card);
    job.committed = [job.file];
  }
  const retained = join(fixture.folder, 'job-91-deliver.context.json');
  const delivery = { ...contexts[0], phase: 'deliver' };
  writeFileSync(retained, JSON.stringify(delivery));
  const { planPath, reviewEvidencePath } = JSON.parse(readFileSync(a.reference.reviewRecordPath, 'utf8'));
  assert.equal(planPath, a.descriptor.planPath);
  const planSnapshot = join(fixture.folder, 'job-91.plan.snapshot.md');
  writeFileSync(planSnapshot, readFileSync(planPath));
  writeFileSync(join(fixture.folder, 'job-91.review.snapshot.md'), readFileSync(reviewEvidencePath));
  return { retained, delivery, planPath, planSnapshot };
}

function retainedCloseoutBytes(fixture, originalPlans = []) {
  const records = readdirSync(fixture.folder).filter((name) => name !== 'admission-request.json')
    .map((name) => join(fixture.folder, name));
  return new Map([...records, ...originalPlans.filter(existsSync)].map((path) => [path, readFileSync(path)]));
}

test('admission verifies settling closeout', async (t) => {
  const create = await admissionFixture(t);
  for (const scenario of ['already closing', 'disappears during inventory', 'missing nonclosing peer',
    'ancestry rejection during disappearance', 'permission refusal during disappearance']) {
    await t.test(`canonical alias closeout admission: ${scenario}`, async (t) => {
      const ancestryRefusal = scenario.endsWith('during disappearance');
      const fixture = create({ cards: [91, 92, 93] });
      try {
        const home = dirname(fixture.folder);
        const canonicalParent = join(home, 'canonical-parent');
        const aliasParent = join(home, 'alias-parent');
        mkdirSync(canonicalParent);
        symlinkSync(canonicalParent, aliasParent, 'junction');
        assert.equal(realpathSync(aliasParent), realpathSync(canonicalParent));
        const a = fixture.jobs.get(91);
        const b = fixture.jobs.get(92);
        const c = fixture.jobs.get(93);
        a.worktree = join(aliasParent, 'job-91');
        const { retained, delivery } = prepareCloseout(fixture);
        const canonicalRoot = realpathSync(a.worktree);
        assert.notEqual(a.worktree, canonicalRoot);
        assert.equal(canonicalRoot, join(realpathSync(canonicalParent), 'job-91'));
        assert.equal(delivery.worktree, a.worktree);
        assert.deepEqual(JSON.parse(readFileSync(retained, 'utf8')), delivery);
        const closeA = () => {
          a.state = 'CLOSED';
          a.status = 'Done';
          a.assignees = ['owner'];
          rmSync(a.worktree, { recursive: true, force: true });
        };
        const records = retainedCloseoutBytes(fixture);
        const inventories = new Map([false, true].map((nul) => {
          const separator = nul ? '\0' : '\n';
          const args = ['worktree', 'list', '--porcelain', ...(nul ? ['-z'] : [])];
          const raw = fixture.git(args);
          assert.ok(raw.includes(`worktree ${a.worktree}${separator}`));
          const inventory = raw.replace(`worktree ${a.worktree}${separator}`, `worktree ${canonicalRoot}${separator}`);
          assert.ok(inventory.includes(`worktree ${canonicalRoot}${separator}`));
          return [nul, inventory];
        }));
        if (scenario === 'already closing' || scenario === 'missing nonclosing peer') closeA();
        if (scenario === 'missing nonclosing peer') rmSync(c.worktree, { recursive: true });
        let inventoryReads = 0;
        const ancestryReads = [];
        const { code, answer } = await readAdmission(t, fixture, { runStart: fixture.runStart, phase: 'deliver',
          candidate: b.reference, reservations: [{ ...a.reference, phase: 'deliver' }, { ...c.reference, phase: 'prepare' }] }, {
          git: (args) => {
            if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
              inventoryReads += 1;
              if (scenario === 'disappears during inventory' && inventoryReads === 1) closeA();
              return inventories.get(args.includes('-z'));
            }
            // Only A's original-base-to-origin/main read fails, after inventory and hydration saw A open and present.
            if (ancestryRefusal && args[0] === '-C' && args[1] === a.worktree && args[2] === 'merge-base' && args[3] === '--is-ancestor'
              && args[4] === a.descriptor.base && args[5] === fixture.gitState.mainTip && args[5] !== 'HEAD') {
              ancestryReads.push({ open: a.state === 'OPEN', present: existsSync(a.worktree) });
              closeA();
              throw scenario.startsWith('ancestry')
                ? Object.assign(new Error('Command failed: git merge-base --is-ancestor'), { status: 1 })
                : Object.assign(new Error('EACCES: permission denied, original-base ancestry read'), { code: 'EACCES' });
            }
            return fixture.git(args);
          },
        });
        t.diagnostic(JSON.stringify({ inventoryReads, canonicalRoot, descriptorRoot: a.worktree, ancestryReads }));
        assert.ok(inventoryReads > 0);
        assert.deepEqual(retainedCloseoutBytes(fixture), records, 'admission preserves all retained filenames and bytes');
        assert.equal(existsSync(join(fixture.folder, 'job-91-deliver.outcome.json')), false);
        if (scenario === 'missing nonclosing peer') {
          assert.equal(code, 1);
          assert.equal(answer.decision, 'unavailable');
          assert.ok(answer.reasons.some((reason) => reason.includes(c.worktree)), 'the missing nonclosing peer causes its own refusal');
        } else if (ancestryRefusal) {
          assert.deepEqual(ancestryReads, [{ open: true, present: true }], 'the designated original-base read is reached once with A open and present');
          assert.equal(code, 1);
          assert.equal(answer.decision, 'unavailable', 'a concurrent closeout never forgives a failed ancestry or permission read');
          assert.match(answer.reasons.join('\n'), scenario.startsWith('ancestry') ? /91.*ancestry.*origin\/main/ : /EACCES|permission/);
        } else {
          assert.equal(code, 3, 'canonical registration and accepted descriptor alias retain the same closing identity');
          assert.equal(answer.decision, 'wait');
          assert.match(answer.reasons.join('\n'), /91/);
          assert.match(answer.reasons.join('\n'), /settling|closeout/i);
          if (scenario === 'disappears during inventory') assert.ok(inventoryReads >= 2, 'the attributed disappearance receives one fresh closing verification');
        }
      } finally {
        await fixture.finish();
      }
    });
  }

  for (const [scenario, reason, exitCode = 1] of [
    ['closed with listed worktree', 'card 91 delivery closeout is settling; admission waits', 3],
    ['corrupt delivery context', 'card 91 retained deliver context is not valid JSON'],
    ['corrupt retained snapshot', 'card 91 plan snapshot differs from accepted evidence'],
    ['changed original plan', 'card 91 original plan differs from accepted evidence'],
    ['changed sole assignee', 'card 91 assignment does not confirm current claim ownership'],
  ]) await t.test(`settling closeout: ${scenario}`, async (t) => {
    const fixture = create({ cards: [91, 92, 93] });
    try {
      const a = fixture.jobs.get(91);
      const b = fixture.jobs.get(92);
      const c = fixture.jobs.get(93);
      const { retained, delivery, planPath, planSnapshot } = prepareCloseout(fixture);
      assert.deepEqual(JSON.parse(readFileSync(retained, 'utf8')), delivery);
      assert.deepEqual(readFileSync(planSnapshot), readFileSync(planPath));
      const outcome = join(fixture.folder, 'job-91-deliver.outcome.json');
      assert.equal(existsSync(outcome), false);
      a.state = 'CLOSED';
      a.status = 'Done';
      a.assignees = scenario === 'changed sole assignee' ? [] : ['owner'];
      const removeRoot = scenario === 'corrupt retained snapshot';
      if (removeRoot) {
        rmSync(a.worktree, { recursive: true });
        writeFileSync(planSnapshot, 'corrupt accepted-plan snapshot\n');
      }
      if (scenario === 'changed original plan') writeFileSync(planPath, 'changed accepted plan after its snapshot\n');
      const corruptContext = scenario === 'corrupt delivery context';
      if (corruptContext) writeFileSync(retained, '{');
      const inventory = fixture.git(['worktree', 'list', '--porcelain', '-z']);
      assert.equal(inventory.includes(`worktree ${a.worktree}\0`), !removeRoot, 'inventory follows physical roots independently of CLOSED issue state');
      const plans = [planPath, b.descriptor.planPath, c.descriptor.planPath];
      const records = retainedCloseoutBytes(fixture, plans);
      const cards = structuredClone(fixture.jobs);

      const { code, answer } = await readAdmission(t, fixture, { runStart: fixture.runStart, phase: 'build',
        candidate: c.reference, reservations: [{ ...a.reference, phase: 'deliver' }, { ...b.reference, phase: 'build' }] });
      assert.equal(code, exitCode);
      assert.deepEqual(answer, { decision: exitCode === 3 ? 'wait' : 'unavailable',
        reasons: [corruptContext ? `${reason}: ${retained}` : reason] });
      assert.deepEqual(retainedCloseoutBytes(fixture, plans), records, 'admission preserves all retained filenames and bytes');
      assert.deepEqual(fixture.jobs, cards, 'scripted readers leave card and worktree metadata unchanged');
      assert.equal(existsSync(a.worktree), !removeRoot);
      assert.equal(existsSync(outcome), false);
    } finally {
      await fixture.finish();
    }
  });
});

// The card's edit history as `writeStateLine` reads it after a write: its two newest revisions, newest first, each
// `diff` the revision's whole text.
const STATE_HISTORY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    issue(number: $number) { userContentEdits(first: 2) { nodes { diff } } }
  }
}`;
const STATE_CARD = 42;
const NAMES_STATE_CARD = /\bcard 42\b/;
const PARKED_LINE = 'Parked: from the queue panel';
const OWNER_BODY = `Scope of card ${STATE_CARD}, revised by the owner.`;

// `writeStateLine` for card 42 of the configured repository, over a card holding `body` and its revisions, newest
// first. A body edit records its text in `writes` and as the newest revision. `owner(moment)` runs after each approval
// read answers ('read') and before each body edit lands ('write'), and returns the owner's edited body to land there,
// or nothing. `history(reply)` returns the history reply to send in place of the honest one.
/**
 * @param {import('node:test').TestContext} t
 * @param {{ body: string, owner?: (moment: string) => string | undefined, history?: (reply: { data: { repository: { id: string, issue: { userContentEdits: { nodes: { diff: string }[] } } } } }) => object }} fixture
 */
async function stateLineCard(t, { body, owner = () => undefined, history = (reply) => reply }) {
  const toolkit = copyToolkit(GITHUB_TEST_CONFIG);
  t.after(() => toolkit.cleanup());
  copyFileSync(new URL('./pre-approved-run.mjs', import.meta.url), toolkit.script('lib/pre-approved-run.mjs'));
  copyFileSync(new URL('./closeout-cleanup.mjs', import.meta.url), toolkit.script('lib/closeout-cleanup.mjs'));
  copyFileSync(new URL('./run-folder.mjs', import.meta.url), toolkit.script('lib/run-folder.mjs'));
  const { writeStateLine } = await toolkit.load('lib/pre-approved-run.mjs');
  const { BOARD_OWNER, BOARD_REPOSITORY } = await toolkit.load('lib/board-config.mjs');
  const repository = `${BOARD_OWNER}/${BOARD_REPOSITORY}`;
  const card = { body, revisions: [body], writes: /** @type {string[]} */ ([]), historyReads: 0 };
  const land = (text) => {
    if (text === undefined) return;
    card.body = text;
    card.revisions.unshift(text);
  };
  const variables = ['-f', `owner=${BOARD_OWNER}`, '-f', `name=${BOARD_REPOSITORY}`, '-F', `number=${STATE_CARD}`];
  const exec = (args) => {
    const call = JSON.stringify(args);
    if (call === JSON.stringify(['repo', 'view', repository, '--json', 'id,nameWithOwner'])) {
      return JSON.stringify({ id: 'R_state', nameWithOwner: repository });
    }
    if (call === JSON.stringify(['api', 'graphql', '-f', `query=${STATE_HISTORY_QUERY}`, ...variables])) {
      card.historyReads += 1;
      const nodes = card.revisions.slice(0, 2).map((diff) => ({ diff }));
      return JSON.stringify(history({ data: { repository: { id: 'R_state', issue: { userContentEdits: { nodes } } } } }));
    }
    if (args[0] === 'api' && args[1] === 'graphql' && args[3]?.includes('comments(first: 100') && JSON.stringify(args.slice(4)) === JSON.stringify(variables)) {
      const reply = JSON.stringify({ data: { viewer: { login: 'owner' }, repository: { id: 'R_state', issue: {
        state: 'OPEN', title: `Card ${STATE_CARD}`, body: card.body, lastEditedAt: null,
        comments: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
      land(owner('read'));
      return reply;
    }
    if (args.length === 6 && JSON.stringify(args.slice(0, 5)) === JSON.stringify(['api', '-X', 'PATCH', `repos/${repository}/issues/${STATE_CARD}`, '-f'])
      && args[5].startsWith('body=')) {
      land(owner('write'));
      const text = args[5].slice('body='.length);
      card.writes.push(text);
      land(text);
      return JSON.stringify({ number: STATE_CARD, body: text });
    }
    throw new Error(`unexpected gh ${call}`);
  };
  return { card, write: (line) => writeStateLine(STATE_CARD, line, { exec }) };
}

// The thrown message, or that nothing was thrown.
const thrown = (run) => {
  try {
    run();
    return 'nothing thrown';
  } catch (error) {
    return /** @type {Error} */ (error).message;
  }
};

const STALE_LINE = `Waiting version: job/${STATE_CARD} ${'0'.repeat(40)} stale run 2026-11-04T10:00:00Z`;
const STALE_BODY = `Scope of card ${STATE_CARD}.\n${STALE_LINE}`;

test('writeStateLine writes once when nothing lands between read and write', async (t) => {
  const { card, write } = await stateLineCard(t, { body: STALE_BODY });
  write(PARKED_LINE);
  const expected = `Scope of card ${STATE_CARD}.\n${PARKED_LINE}`;
  assert.deepEqual({ writes: card.writes, body: card.body }, { writes: [expected], body: expected });
});

// GitHub records no revision for an edit that changes nothing, so such a write could not be told apart in the history.
test('writeStateLine makes no edit when the card already ends with that state line', async (t) => {
  const body = `Scope of card ${STATE_CARD}.\n${PARKED_LINE}`;
  const { card, write } = await stateLineCard(t, { body });
  const message = thrown(() => write(PARKED_LINE));
  assert.deepEqual({ writes: card.writes, historyReads: card.historyReads, body: card.body },
    { writes: [], historyReads: 0, body }, message);
});

test('writeStateLine keeps an owner edit that lands between its read and its write', async (t) => {
  let landed = false;
  const { card, write } = await stateLineCard(t, { body: STALE_BODY, owner: (moment) => {
    if (moment !== 'read' || landed) return undefined;
    landed = true;
    // The owner's edit keeps the earlier state line, which the write still drops.
    return `${OWNER_BODY}\n${STALE_LINE}`;
  } });
  write(PARKED_LINE);
  assert.equal(card.body, `${OWNER_BODY}\n${PARKED_LINE}`);
});

test('writeStateLine refuses an edit history it cannot read', async (t) => {
  /** @type {[string, object][]} */
  const rows = [
    ['no edit list', { data: { repository: { id: 'R_state', issue: {} } } }],
    ['an edit list that is not a list', { data: { repository: { id: 'R_state', issue: { userContentEdits: { nodes: { diff: STALE_BODY } } } } } }],
    ['a one-revision edit list', { data: { repository: { id: 'R_state', issue: { userContentEdits: { nodes: [{ diff: `Scope of card ${STATE_CARD}.\n${PARKED_LINE}` }] } } } } }],
  ];
  const observed = [];
  for (const [row, reply] of rows) {
    const { card, write } = await stateLineCard(t, { body: STALE_BODY, history: () => reply });
    const message = thrown(() => write(PARKED_LINE));
    t.diagnostic(`${row}: ${message}`);
    observed.push({ row, historyRead: card.historyReads > 0, namesCard: NAMES_STATE_CARD.test(message) });
  }
  assert.deepEqual(observed, rows.map(([row]) => ({ row, historyRead: true, namesCard: true })));
});

test('writeStateLine stops after three writes when edits keep landing', async (t) => {
  let edits = 0;
  const { card, write } = await stateLineCard(t, { body: STALE_BODY, owner: (moment) => {
    if (moment !== 'write') return undefined;
    edits += 1;
    return `${OWNER_BODY} Edit ${edits}.`;
  } });
  const message = thrown(() => write(PARKED_LINE));
  assert.deepEqual({
    writes: card.writes.length,
    body: card.body,
    namesCard: NAMES_STATE_CARD.test(message),
    saysWritten: message.includes('its state line is written'),
    namesHistory: message.includes("survives only in the card's edit history"),
    saysNotWritten: message.includes('not written'),
  }, {
    writes: 3,
    body: `${OWNER_BODY} Edit 2.\n${PARKED_LINE}`,
    namesCard: true,
    saysWritten: true,
    namesHistory: true,
    saysNotWritten: false,
  }, message);
});

test('writeStateLine refuses a history whose newest revision is not its own write', async (t) => {
  // A summary of the change in place of the revision's whole text.
  const { card, write } = await stateLineCard(t, { body: STALE_BODY, history: (reply) => {
    const { nodes } = reply.data.repository.issue.userContentEdits;
    return { data: { repository: { id: 'R_state', issue: { userContentEdits: { nodes: [{ diff: `+${PARKED_LINE}` }, ...nodes.slice(1)] } } } } };
  } });
  const message = thrown(() => write(PARKED_LINE));
  assert.deepEqual({ historyRead: card.historyReads > 0, namesCard: NAMES_STATE_CARD.test(message) },
    { historyRead: true, namesCard: true }, message);
});

// The pre-approved run's prompts are spelled out here to verify the operating instructions.
const PRE_APPROVED_CARD_PROMPT = 'Select and claim one eligible pre-approved job. Do not plan, build, or deliver.';
const PRE_APPROVED_END_PREFIX = 'End the pre-approved run: ';

test('default Git readers share the admission output budget', async (t) => {
  const create = await admissionFixture(t);
  const temporaryParent = realpathSync(mkdtempSync(join(tmpdir(), 'product-manager-output-budget-')));
  const temporaryEnvironment = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map((key) => [key, process.env[key]]));
  const originalExecFileSync = childProcess.execFileSync;
  const runStart = '2026-11-05T10:00:00Z';
  // Each byte case reviews one literal name; a finite child writes the actual untracked-path bytes Git would return.
  const byteCases = {
    'admission refuses malformed UTF-8 filename bytes': { planned: '\uFFFD.txt', bytes: [0xff, 0x2e, 0x74, 0x78, 0x74, 0x00] },
    'admission keeps a leading U+FEFF and literal U+FFFD filename': { planned: '\uFEFF\uFFFD.txt',
      bytes: [0xef, 0xbb, 0xbf, 0xef, 0xbf, 0xbd, 0x2e, 0x74, 0x78, 0x74, 0x00] },
  };
  try {
    for (const key of Object.keys(temporaryEnvironment)) process.env[key] = temporaryParent;
    for (const scenario of ['admission', ...Object.keys(byteCases)]) {
      await t.test(scenario, async (t) => {
        const byteCase = byteCases[scenario];
        const fixture = create({ cards: [92] });
        if (byteCase) fixture.jobs.get(92).plannedFiles = [byteCase.planned];
        const context = fixture.prepareSelected(92);
        if (byteCase) {
          writeFileSync(join(fixture.folder, 'job-92-build.context.json'), JSON.stringify(context));
          writeFileSync(join(fixture.folder, 'job-92-build.outcome.json'), JSON.stringify({ runStart, card: 92,
            claimUrl: context.claimUrl, phase: 'build', disposition: 'built', reason: 'Completed byte-identity fixture build' }));
        }
        const byteReads = [];
        const inventory = fixture.git(['worktree', 'list', '--porcelain', '-z']);
        const root = inventory.split('\0', 1)[0].slice('worktree '.length);
        let bufferedInventory;
        const readGit = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
          assert.equal(command, 'git');
          // Proxy replies honour the requested encoding: a raw request receives the Buffer Node itself would return.
          const reply = (text) => (options?.encoding && options.encoding !== 'buffer' ? text : Buffer.from(text, 'utf8'));
          if (args.join(' ') === 'rev-parse --path-format=absolute --git-common-dir') return reply(`${join(root, '.git')}\n`);
          if (byteCase && args[0] === '-C' && args[1] === fixture.jobs.get(92).worktree && args[2] === 'ls-files') {
            const output = originalExecFileSync(process.execPath, ['-e', `process.stdout.write(Buffer.from(${JSON.stringify(byteCase.bytes)}))`], options);
            byteReads.push({ bytes: byteCase.bytes, options: { encoding: options?.encoding, maxBuffer: options?.maxBuffer, timeout: options?.timeout },
              output: [...Buffer.from(output)] });
            return output;
          }
          // Byte cases read the ordinary inventory; admission proves the padded buffer budget.
          if (!byteCase && args.join(' ') === 'worktree list --porcelain -z') {
            // A real child enforces the caller's buffer; cache only its completed output to bound recurring cost.
            bufferedInventory ??= originalExecFileSync(process.execPath, ['-e', `
  const inventory = ${JSON.stringify(inventory)};
  process.stdout.write(inventory.replace('\\0\\0', '\\0locked ' + 'x'.repeat(2 * 1024 * 1024) + '\\0\\0'));
  `], options);
            return bufferedInventory;
          }
          return reply(fixture.git(args));
        });
        try {
          syncBuiltinESMExports();
          if (scenario === 'admission') {
            const printed = [];
            const code = await fixture.main([], {
              admissionRequest: { runStart, phase: 'build', candidate: fixture.jobs.get(92).reference, reservations: [] },
              exec: fixture.exec, output: { log: (text) => printed.push(text), error: (text) => printed.push(text) },
            });
            t.diagnostic(`admission: exit=${code}; ${printed.join('\n')}`);
            assert.equal(code, 0, printed.join('\n'));
            assert.deepEqual(printed.map((text) => JSON.parse(text)), [{ decision: 'allow', reasons: [] }]);
          } else if (byteCase) {
            const printed = [];
            let dispatches = 0;
            const code = await fixture.main([], {
              admissionRequest: { runStart, phase: 'deliver', candidate: fixture.jobs.get(92).reference, reservations: [] },
              exec: fixture.exec, startSession: async () => { dispatches += 1; return { exitCode: 0 }; },
              output: { log: (text) => printed.push(text), error: (text) => printed.push(text) },
            });
            t.diagnostic(`${scenario}: exit=${code}; dispatches=${dispatches}; reads=${JSON.stringify(byteReads)}; ${printed.join('\n')}`);
            assert.equal(dispatches, 0, 'read-only admission never starts a model');
            assert.equal(byteReads.length, 1, 'the actual untracked-path bytes reach the production reader');
            assert.equal(printed.length, 1);
            const answer = JSON.parse(printed[0]);
            if (byteCase.planned === '\uFFFD.txt') {
              assert.equal(answer.decision, 'unavailable', 'invalid filename bytes never alias the reviewed U+FFFD name');
              assert.equal(code, 1);
              assert.match(answer.reasons.join('\n'), /utf-8/i);
            } else {
              assert.deepEqual(answer, { decision: 'allow', reasons: [] }, 'valid leading U+FEFF and U+FFFD bytes keep the reviewed name');
              assert.equal(code, 0);
            }
          }
          if (!byteCase) {
            assert.ok(Buffer.byteLength(bufferedInventory) > 1024 * 1024, 'valid inventory crosses the default Node buffer');
            assert.ok(Buffer.byteLength(bufferedInventory) < 64 * 1024 * 1024, 'inventory remains inside the existing admission budget');
          }
        } finally {
          readGit.mock.restore();
          syncBuiltinESMExports();
          await fixture.finish();
        }
      });
    }
  } finally {
    for (const [key, value] of Object.entries(temporaryEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temporaryParent, { recursive: true, force: true });
    assert.equal(existsSync(temporaryParent), false);
    t.diagnostic(`Removed owned temporary parent: ${temporaryParent}`);
  }
});

// One detached checkout and local fetched-main ref, with a real launcher process per binding case.
test('ANTI-REGRESSION: app binding designates only the clean selected Git worktree without replacing evidence', (t) => {
  const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'app-binding-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'repository');
  const checkout = join(temporary, 'job-92');
  mkdirSync(join(root, '.agents'), { recursive: true });
  const env = /** @type {NodeJS.ProcessEnv} */ ({ ...gitEnvironment(), GIT_AUTHOR_NAME: 'Binding Test', GIT_AUTHOR_EMAIL: 'binding@workflow.invalid',
    GIT_COMMITTER_NAME: 'Binding Test', GIT_COMMITTER_EMAIL: 'binding@workflow.invalid' });
  delete env.PRE_APPROVED_RUN_SESSION;
  delete env.PRODUCT_MANAGER_RUN_SESSION;
  const git = (args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 }).trim();
  const commit = (message) => git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
  const settings = '.agents/factory-settings.json';
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'tracked.txt'), 'binding leaves tracked bytes alone\n');
  writeFileSync(join(root, settings), '{"version":1,"waitForOwner":"always"}\n');
  git(['add', '--', 'tracked.txt', settings]);
  commit('disabled fixture settings');
  const disabledBase = git(['rev-parse', 'HEAD']);
  writeFileSync(join(root, settings), '{"version":1,"waitForOwner":"when-needed"}\n');
  git(['add', '--', settings]);
  commit('enabled fixture settings');
  const base = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/main', base]);
  git(['worktree', 'add', '-q', '--detach', checkout, base]);

  const worktree = realpathSync.native(checkout);
  const designationDirectory = join(root, '.git', 'fabraik-app-run');
  const digest = createHash('sha256').update(worktree).digest('hex');
  const designation = join(designationDirectory, `${digest}.session`);
  const binding = join(git(['-C', worktree, 'rev-parse', '--absolute-git-dir']), 'fabraik-app-run.json');
  const requestPath = join(temporary, 'request.json');
  const cli = fileURLToPath(new URL('../pre-approved-run.mjs', import.meta.url));
  const identity = { sessionId: '11111111-1111-4111-8111-111111111111', kind: 'pre-approved', runStart: '2026-11-05T10:00:00Z', card: 92 };
  const run = (overrides = {}, childEnv = env) => {
    writeFileSync(requestPath, JSON.stringify({ ...identity, worktree, base, ...overrides }));
    const result = childProcess.spawnSync(process.execPath, [cli, '--bind-app-job', requestPath], {
      cwd: root, env: childEnv, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(result.error);
    return result;
  };
  const tracked = () => [root, worktree].flatMap((cwd) => ['tracked.txt', settings].map((file) => readFileSync(join(cwd, file))));
  const originalTracked = tracked();
  assert.equal(existsSync(designationDirectory), false);
  assert.equal(existsSync(binding), false);
  const bound = run();
  assert.equal(bound.status, 0, `clean matching bind: ${bound.stderr}`);
  assert.equal(bound.stderr, '');
  assert.deepEqual(JSON.parse(bound.stdout), { decision: 'bound', sessionId: identity.sessionId, worktree });
  const designationBytes = Buffer.from(`${identity.sessionId}\n`);
  const bindingBytes = readFileSync(binding);
  assert.deepEqual(readFileSync(designation), designationBytes);
  assert.deepEqual(JSON.parse(bindingBytes.toString('utf8')), identity);
  assert.deepEqual(tracked(), originalTracked);
  for (const cwd of [root, worktree]) assert.equal(git(['-C', cwd, 'status', '--porcelain']), '');

  const diagnostics = [];
  const expectedDiagnostics = [];
  const refuse = (name, reason, overrides, childEnv) => {
    const result = run(overrides, childEnv);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    diagnostics.push({ name, stdout: result.stdout, stderr: result.stderr });
    expectedDiagnostics.push({ name, stdout: '', stderr: `Native app job binding unavailable: ${reason}\n` });
  };
  const replacement = { sessionId: '22222222-2222-4222-8222-222222222222' };
  const collision = 'Existing app binding evidence';
  const generic = 'inspect the request, selected checkout and binding metadata';
  refuse('existing pair', collision, replacement);
  assert.deepEqual(readFileSync(designation), designationBytes);
  assert.deepEqual(readFileSync(binding), bindingBytes);

  rmSync(designation);
  refuse('binding alone', collision, replacement);
  assert.equal(existsSync(designation), false);
  assert.deepEqual(readFileSync(binding), bindingBytes);

  writeFileSync(designation, designationBytes);
  rmSync(binding);
  refuse('designation alone', collision, replacement);
  assert.deepEqual(readFileSync(designation), designationBytes);
  assert.equal(existsSync(binding), false);
  rmSync(designationDirectory, { recursive: true });

  const refusesWithoutWriting = (name, reason, overrides, childEnv) => {
    refuse(name, reason, overrides, childEnv);
    assert.equal(existsSync(designationDirectory), false, name);
    assert.equal(existsSync(binding), false, name);
  };
  for (const name of ['PRE_APPROVED_RUN_SESSION', 'PRODUCT_MANAGER_RUN_SESSION']) {
    refusesWithoutWriting(`run mark ${name}`, 'Bind requires Git and an unmarked coordinator', {}, { ...env, [name]: '2026-11-05T10:00:00Z' });
  }
  refusesWithoutWriting('extra request field', 'Invalid bind request', { unexpected: true });
  refusesWithoutWriting('retired product manager kind', 'Invalid bind request', { kind: 'product-manager' });
  refusesWithoutWriting('operating root target', 'The selected checkout is outside the operating repository’s linked worktrees',
    { worktree: realpathSync.native(root) });
  assert.equal(existsSync(join(root, '.git', 'fabraik-app-run.json')), false);
  refusesWithoutWriting('stale base', 'The selected checkout HEAD differs from the requested base', { base: disabledBase });
  refusesWithoutWriting('missing checkout', generic, { worktree: join(temporary, 'PRIVATE-BIND-PATH-SENTINEL') });

  const trackedPath = join(worktree, 'tracked.txt');
  const trackedBytes = readFileSync(trackedPath);
  writeFileSync(trackedPath, 'dirty fixture edit\n');
  refusesWithoutWriting('dirty checkout', 'The selected checkout is dirty');
  writeFileSync(trackedPath, trackedBytes);

  git(['-C', worktree, 'checkout', '-q', '-b', 'attached']);
  refusesWithoutWriting('attached checkout', 'The selected checkout is attached');
  git(['-C', worktree, 'checkout', '-q', '--detach', disabledBase]);
  git(['update-ref', 'refs/remotes/origin/main', disabledBase]);
  refusesWithoutWriting('disabled fetched-main opt-in', generic, { base: disabledBase });
  assert.deepEqual(diagnostics, expectedDiagnostics);
});

async function jobOwnershipFixture(t, { enablePreApproved = false } = {}) {
  const toolkit = copyToolkit(GITHUB_TEST_CONFIG);
  t.after(() => toolkit.cleanup());
  copyFileSync(new URL('./pre-approved-run.mjs', import.meta.url), toolkit.script('lib/pre-approved-run.mjs'));
  copyFileSync(new URL('./closeout-cleanup.mjs', import.meta.url), toolkit.script('lib/closeout-cleanup.mjs'));
  copyFileSync(new URL('./run-folder.mjs', import.meta.url), toolkit.script('lib/run-folder.mjs'));
  const { boardReadExec, leanBoardPage, leanNode } = await toolkit.load('lib/board-fixtures.mjs');
  const repository = 'example-owner/example-repo';
  const repositoryId = 'R_ownership_fixture';
  const runStart = '2026-11-05T10:00:00Z';
  const claimTime = '2026-11-05T10:01:00Z';
  const claimUrl = `https://github.com/${repository}/issues/92#issuecomment-1092`;
  const physicalRoot = realpathSync.native(toolkit.root);
  const root = join(physicalRoot, 'repository');
  const worktree = join(physicalRoot, 'job-92');
  mkdirSync(root);
  const env = { ...gitEnvironment(), GIT_AUTHOR_NAME: 'Ownership Test', GIT_AUTHOR_EMAIL: 'ownership@workflow.invalid',
    GIT_COMMITTER_NAME: 'Ownership Test', GIT_COMMITTER_EMAIL: 'ownership@workflow.invalid' };
  const git = (args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'tracked.txt'), 'reviewed baseline\n');
  git(['add', '--', 'tracked.txt']);
  if (enablePreApproved) {
    mkdirSync(join(root, '.agents'));
    writeFileSync(join(root, '.agents', 'factory-settings.json'), '{"version":1,"waitForOwner":"when-needed"}\n');
    git(['add', '--', '.agents/factory-settings.json']);
  }
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture baseline']);
  git(['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
  const base = git(['rev-parse', '--verify', 'HEAD']).trim();
  git(['worktree', 'add', '-q', '-b', 'job/92', worktree]);
  let currentClaimUrl = claimUrl;
  const board = boardReadExec({ board: [leanBoardPage([leanNode({
    id: 'PVTI_ownership_92', title: 'Ownership card 92', status: 'In progress',
    content: { __typename: 'Issue', number: 92, assignees: ['owner'] },
  })])] });
  const exec = (args) => {
    if (args[0] === 'repo' && args[1] === 'view' && args.includes('--json')) {
      return JSON.stringify({ id: repositoryId, nameWithOwner: repository, defaultBranchRef: { name: 'main' } });
    }
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    if (args[0] === 'api' && args[1] === 'graphql' && query.includes('comments(first: 100)')) {
      assert.ok(args.includes('number=92'), `unexpected ownership card identity: ${JSON.stringify(args)}`);
      return JSON.stringify({ data: { viewer: { login: 'owner' }, repository: { id: repositoryId, issue: {
        state: 'OPEN', title: 'Ownership card 92', lastEditedAt: null,
        comments: { pageInfo: { hasNextPage: false }, nodes: [
          { author: { login: 'owner' }, createdAt: claimTime, lastEditedAt: null,
            url: currentClaimUrl, body: `Claim: fixture-machine Codex job/92 ${worktree}` },
        ] },
      } } } });
    }
    if (args[0] === 'api' && args[1] === 'graphql' && query.includes('comments(last:100')) {
      assert.match(query, /\bi92: issue\(number:92\)/, `unexpected ownership detail query: ${query}`);
      assert.doesNotMatch(query, /\bi(?!92:)\d+: issue\(/, `unexpected ownership detail identity: ${query}`);
      const nodes = [
        { body: `Claim: fixture-machine Codex job/92 ${worktree}`, url: currentClaimUrl, author: { login: 'owner' } },
      ];
      return JSON.stringify({ data: { repository: { i92: { number: 92, body: 'Scope evidence for card 92.', parent: null,
        comments: { totalCount: nodes.length, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes } } } } });
    }
    if (args[0] === 'api' && args[1] === 'graphql') return board.exec(args);
    throw new Error(`unexpected ownership gh invocation: ${JSON.stringify(args)}`);
  };
  const planPath = join(toolkit.root, 'plan.md');
  const reviewEvidencePath = join(toolkit.root, 'review.md');
  writeFileSync(planPath, 'Reviewed scope: tracked.txt.\n');
  writeFileSync(reviewEvidencePath, 'Independent review accepted the exact descriptor and plan.\n');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const select = (path) => ({ runStart, card: 92, claimUrl, priorClaimUrls: [], branch: 'job/92', worktree: path, base });
  const reviewContext = (path, evidenceDirectory, plannedFiles = ['tracked.txt']) => {
    const selection = select(path);
    const planHash = hash(readFileSync(planPath));
    mkdirSync(evidenceDirectory);
    const descriptorPath = join(evidenceDirectory, 'job-92.prepared.json');
    const reviewRecordPath = join(evidenceDirectory, 'job-92.reviewed.json');
    writeFileSync(descriptorPath, JSON.stringify({ ...selection, planPath, planHash, plannedFiles,
      prerequisites: [], exclusiveResources: [] }));
    const descriptorHash = hash(readFileSync(descriptorPath));
    writeFileSync(reviewRecordPath, JSON.stringify({ runStart, card: 92, claimUrl, descriptorPath, descriptorHash,
      planPath, planHash, reviewEvidencePath, reviewEvidenceHash: hash(readFileSync(reviewEvidencePath)), verdict: 'accepted' }));
    return { phase: 'build', ...selection, descriptorPath, descriptorHash, planHash, reviewRecordPath };
  };
  return { toolkit, root, worktree, base, runStart, claimUrl, claimTime, exec, git, hash, planPath, reviewEvidencePath,
    select, reviewContext, setClaimUrl: (url) => { currentClaimUrl = url; } };
}

// One real claimed checkout, with synthetic GitHub reads and no session or notification processes.
test('ANTI-REGRESSION: app phase preparation retains only the admitted bound context without dispatch', async (t) => {
  const { toolkit, root, worktree: checkout, base, runStart, claimTime, claimUrl, git, exec, planPath, reviewEvidencePath,
    select, reviewContext } = await jobOwnershipFixture(t, { enablePreApproved: true });
  copyFileSync(new URL('../pre-approved-run.mjs', import.meta.url), toolkit.script('pre-approved-run.mjs'));
  copyFileSync(new URL('./checkout-context.mjs', import.meta.url), toolkit.script('lib/checkout-context.mjs'));
  const { main: phaseMain } = await toolkit.load('pre-approved-run.mjs');
  const { inspectAdmission } = await toolkit.load('lib/pre-approved-run.mjs');
  const worktree = realpathSync.native(checkout);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const marks = Object.fromEntries(['PRODUCT_MANAGER_RUN_SESSION', 'PRE_APPROVED_RUN_SESSION'].map((name) => [name, process.env[name]]));
  for (const name of Object.keys(marks)) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(marks)) if (value !== undefined) process.env[name] = value;
  });
  git(['update-ref', 'refs/remotes/origin/main', base]);

  const designationDir = join(root, '.git', 'fabraik-app-run');
  mkdirSync(designationDir, { mode: 0o700 });
  const designation = createHash('sha256').update(worktree).digest('hex');
  writeFileSync(join(designationDir, `${designation}.session`), `${sessionId}\n`, { flag: 'wx', mode: 0o600 });
  const gitDir = git(['-C', worktree, 'rev-parse', '--absolute-git-dir']).trim();
  writeFileSync(join(gitDir, 'fabraik-app-run.json'), JSON.stringify({ sessionId, kind: 'pre-approved', runStart, card: 92 }),
    { flag: 'wx', mode: 0o600 });

  const resultDir = join(toolkit.root, 'app-phase-results');
  const otherDir = join(toolkit.root, 'app-phase-other-review');
  const plannedFiles = ['tracked.txt', 'planned-new.txt'];
  writeFileSync(planPath, 'Reviewed scope: tracked.txt and planned-new.txt.\n');
  const build = reviewContext(worktree, resultDir, plannedFiles);
  const otherBuild = reviewContext(worktree, otherDir, plannedFiles);
  const prepare = { phase: 'prepare', ...select(worktree) };
  const prepareBase = join(resultDir, 'job-92-prepare');
  const buildBase = join(resultDir, 'job-92-build');
  const otherPrepare = join(otherDir, 'job-92-prepare');
  const otherBuildPath = join(otherDir, 'job-92-build.context.json');
  const admissionPath = join(toolkit.root, 'app-admission.json');
  const admission = ({ descriptorPath, descriptorHash, planHash, reviewRecordPath }) => ({
    runStart, phase: 'build', candidate: { descriptorPath, descriptorHash, planHash, reviewRecordPath }, reservations: [],
  });
  const preparedOutcome = { runStart, card: 92, claimUrl, phase: 'prepare', disposition: 'prepared', reason: 'Accepted fixture review' };
  const json = (value) => JSON.stringify(value) + '\n';
  /** @typedef {{ id?: string, claim?: string, admissionFile?: string }} PhaseRunOptions */
  /** @param {string} logBase @param {PhaseRunOptions} [options] */
  const run = async (logBase, { id = sessionId, claim = claimTime, admissionFile } = {}) => {
    const args = ['--prepare-app-phase', logBase, id, claim, ...(admissionFile ? [admissionFile] : [])];
    const cwd = process.cwd();
    const effects = [];
    const logged = [];
    const errors = [];
    process.chdir(root);
    try {
      const code = await phaseMain(args, { git, exec,
        startSession: async () => { effects.push('start'); return { exitCode: 0 }; },
        notify: async () => { effects.push('notify'); },
        output: { log: (line) => logged.push({ line, evidence: readPhaseEvidence(logBase, 92) }), error: (line) => errors.push(line) },
      });
      assert.deepEqual(effects, [], 'phase preparation must not dispatch or notify');
      return { code, logged, errors };
    } finally {
      process.chdir(cwd);
    }
  };
  const observed = ({ code, logged, errors }, expected, label) => {
    assert.equal(code, expected, `${label}: ${errors.join('\n')}`);
    assert.deepEqual(errors, [], label);
    assert.equal(logged.length, 1, label);
    return { reply: JSON.parse(logged[0].line), evidence: logged[0].evidence };
  };
  const missing = { error: 'ENOENT' };
  const allow = (actual, logBase, context, prompt, evidence) => {
    assert.deepEqual(observed(actual, 0, `admitted ${context.phase}`), {
      reply: { decision: 'allow', prompt: `${prompt}\n${JSON.stringify(context)}`, contextPath: `${logBase}.context.json` },
      evidence,
    });
  };
  /** @param {string} label @param {string} logBase @param {PhaseRunOptions} [options] @param {{ error: string } | { bytes: string }} [context] */
  const refuse = async (label, logBase, options, context = missing) => {
    const { reply, evidence } = observed(await run(logBase, options), 1, label);
    assert.deepEqual(Object.keys(reply).sort(), ['decision', 'reasons'], label);
    assert.equal(reply.decision, 'unavailable', label);
    assert.ok(Array.isArray(reply.reasons) && reply.reasons.length > 0, label);
    assert.deepEqual(evidence, { context, plan: missing, review: missing }, label);
    assert.deepEqual(readPhaseEvidence(logBase, 92), evidence, label);
    return reply;
  };

  writeFileSync(`${prepareBase}.request.json`, json(prepare));
  const retainedPrepare = { bytes: json(prepare) };
  allow(await run(prepareBase), prepareBase, prepare, 'Prepare this exact pre-approved job. Do not build or deliver.',
    { context: retainedPrepare, plan: missing, review: missing });
  await refuse('prepare context collision', prepareBase, {}, retainedPrepare);

  writeFileSync(`${otherPrepare}.request.json`, json(prepare));
  await refuse('wrong native session', otherPrepare, { id: '22222222-2222-4222-8222-222222222222' });
  await refuse('different original claim time', otherPrepare, { claim: '2026-11-05T10:01:01Z' });
  writeFileSync(`${otherPrepare}.request.json`, '{malformed');
  await refuse('malformed context request', otherPrepare);
  writeFileSync(`${otherPrepare}.request.json`, json(prepare));
  writeFileSync(otherBuildPath, json(otherBuild));
  await refuse('later retained build evidence', otherPrepare);
  assert.equal(readFileSync(otherBuildPath, 'utf8'), json(otherBuild));
  rmSync(otherBuildPath);

  // A matching prepared outcome is produced by the completed phase, independently of the next launcher call.
  writeFileSync(`${prepareBase}.outcome.json`, json(preparedOutcome));
  writeFileSync(`${otherPrepare}.context.json`, json(prepare));
  writeFileSync(`${otherPrepare}.outcome.json`, json(preparedOutcome));
  writeFileSync(`${buildBase}.request.json`, json(build));
  const otherAdmission = admission(otherBuild);
  assert.deepEqual(inspectAdmission(otherAdmission, { root, exec, git }), { decision: 'allow', reasons: [] },
    'the mismatched reviewed reference would otherwise be admitted');
  writeFileSync(admissionPath, json(otherAdmission));
  const options = { admissionFile: admissionPath };
  await refuse('mismatched admission reference', buildBase, options);
  writeFileSync(admissionPath, json(admission(build)));

  const dirty = join(worktree, 'planned-new.txt');
  writeFileSync(dirty, 'inside the reviewed footprint\n');
  try {
    assert.deepEqual(await refuse('dirty inactive preparation', buildBase, options), {
      decision: 'unavailable', reasons: ['card 92 has no verified inactive prepared state for build'],
    });
  } finally {
    rmSync(dirty);
  }
  const existingOutput = `${buildBase}.json`;
  writeFileSync(existingOutput, 'existing phase output\n');
  await refuse('build output collision', buildBase, options);
  assert.equal(readFileSync(existingOutput, 'utf8'), 'existing phase output\n');
  rmSync(existingOutput);

  const acceptedEvidence = { context: { bytes: json(build) }, plan: { bytes: readFileSync(planPath, 'utf8') },
    review: { bytes: readFileSync(reviewEvidencePath, 'utf8') } };
  allow(await run(buildBase, options), buildBase, build, 'Build and verify this exact prepared job. Do not publish or deliver.', acceptedEvidence);
  assert.deepEqual(readPhaseEvidence(buildBase, 92), acceptedEvidence);
  assert.equal(readFileSync(`${prepareBase}.context.json`, 'utf8'), retainedPrepare.bytes);
});

test('pre-approved job ownership uses canonical Git worktree identity', async (t) => {
  const { toolkit, root, worktree, base, runStart, claimUrl, claimTime, exec, git, hash, planPath, reviewContext,
    setClaimUrl } = await jobOwnershipFixture(t);
  const { inspectAdmission, verifyPreparedContext } = await toolkit.load('lib/pre-approved-run.mjs');
  const alias = join(toolkit.root, 'job-alias');
  // A directory junction also supplies a real alias on Windows without symbolic-link privilege.
  symlinkSync(worktree, alias, 'junction');
  assert.notEqual(alias, worktree);
  assert.equal(realpathSync(alias), realpathSync(worktree), 'the alias identifies the actual linked worktree');
  const contexts = [worktree, alias, root].map((path, index) => reviewContext(path, join(toolkit.root, `ownership-${index}`)));
  const [canonical, equivalent, different] = contexts;
  const verify = (context, reader = git) => verifyPreparedContext(context, { runStart, exec, git: reader });
  const claimCreatedAt = Date.parse(claimTime);
  await t.test('canonical worktree retains the original claim instant', () => {
    assert.equal(verify(canonical).claimCreatedAt, claimCreatedAt);
  });
  await t.test('realpath-backed alias retains the same authority', () => {
    assert.equal(verify(equivalent).claimCreatedAt, claimCreatedAt);
  });
  await t.test('different actual worktree refuses', () => {
    assert.notEqual(realpathSync(root), realpathSync(worktree));
    assert.throws(() => verify(different), /Git (?:worktree|branch|HEAD).*92/i);
  });
  await t.test('changed actual branch refuses', () => {
    git(['-C', worktree, 'checkout', '-q', '-b', 'other-owner']);
    try {
      assert.throws(() => verify(canonical), /Git (?:worktree|branch|HEAD).*92/i);
    } finally {
      git(['-C', worktree, 'checkout', '-q', 'job/92']);
    }
  });
  await t.test('changed authoritative claim refuses', () => {
    setClaimUrl(claimUrl.replace(/1092$/, '3092'));
    try {
      assert.throws(() => verify(canonical), /claim ownership changed.*92/i);
    } finally {
      setClaimUrl(claimUrl);
    }
  });
  await t.test('pure owned verification tolerates a missing registered peer root', () => {
    const peer = join(toolkit.root, 'private-job-93');
    git(['worktree', 'add', '-q', '-b', 'job/93', peer]);
    assert.ok(existsSync(peer));
    rmSync(peer, { recursive: true });
    try {
      assert.equal(existsSync(peer), false);
      assert.ok(git(['worktree', 'list', '--porcelain', '-z']).includes(`branch refs/heads/job/93\0`), 'the missing peer is still actually registered in Git');
      assert.equal(verify(canonical).claimCreatedAt, claimCreatedAt, 'pure ownership resolves only the exact owned worktree');
    } finally {
      git(['worktree', 'prune', '--expire=now']);
    }
  });
  // Both supported representations are snapshots of actual Git output, not invented inventory records.
  const inventory = new Map([['worktree list --porcelain', git(['worktree', 'list', '--porcelain'])],
    ['worktree list --porcelain -z', git(['worktree', 'list', '--porcelain', '-z'])]]);
  git(['-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'valid descendant']);
  const head = git(['-C', worktree, 'rev-parse', '--verify', 'HEAD']).trim();
  assert.notEqual(head, base);
  git(['-C', worktree, 'merge-base', '--is-ancestor', base, head]);
  await t.test('stale actual inventory HEAD refuses', () => {
    const staleInventory = (args) => inventory.get(args.join(' ')) ?? git(args);
    assert.throws(() => verify(canonical, staleInventory), /Git (?:worktree|branch|HEAD).*92/i);
  });
  await t.test('refreshed inventory accepts a descendant of the original base', () => {
    assert.equal(canonical.base, base, 'the selected base remains immutable');
    assert.equal(verify(canonical).claimCreatedAt, claimCreatedAt);
  });
  await t.test('a consistently reviewed base must precede owned HEAD', () => {
    const descriptorBytes = readFileSync(canonical.descriptorPath);
    const reviewBytes = readFileSync(canonical.reviewRecordPath);
    try {
      writeFileSync(canonical.descriptorPath, JSON.stringify({ ...JSON.parse(descriptorBytes.toString('utf8')), base: head }));
      const descriptorHash = hash(readFileSync(canonical.descriptorPath));
      writeFileSync(canonical.reviewRecordPath, JSON.stringify({ ...JSON.parse(reviewBytes.toString('utf8')), descriptorHash }));
      const descendant = { ...canonical, base: head, descriptorHash };
      assert.equal(verify(descendant).claimCreatedAt, claimCreatedAt, 'the descendant base and its review agree before rewinding HEAD');
      git(['update-ref', 'refs/heads/job/92', base, head]);
      assert.equal(git(['-C', worktree, 'rev-parse', '--verify', 'HEAD']).trim(), base);
      assert.equal(git(['-C', worktree, 'status', '--porcelain']), '', 'the empty descendant changes no application bytes');
      const calls = [];
      const observeGit = (args) => {
        calls.push(args);
        return git(args);
      };
      assert.throws(() => verify(descendant, observeGit), (error) => {
        assert.equal(/** @type {NodeJS.ErrnoException & { status?: number | null }} */ (error).status, 1, 'native Git rejects descendant-to-parent ancestry');
        assert.deepEqual(calls.at(-1), ['-C', worktree, 'merge-base', '--is-ancestor', head, 'HEAD']);
        return true;
      });
    } finally {
      try {
        git(['update-ref', 'refs/heads/job/92', head]);
      } finally {
        writeFileSync(canonical.descriptorPath, descriptorBytes);
        writeFileSync(canonical.reviewRecordPath, reviewBytes);
      }
    }
    assert.equal(verify(canonical).claimCreatedAt, claimCreatedAt, 'the original reviewed context remains valid after restoration');
  });
  // Full admission over the same native repository: the delivery request supplies every provider, schema and phase fact,
  // so a refusal below can only come from the observed Git paths or worktrees.
  const evidence = dirname(canonical.descriptorPath);
  const buildContextPath = join(evidence, 'job-92-build.context.json');
  const buildOutcomePath = join(evidence, 'job-92-build.outcome.json');
  const admit = (reference) => {
    writeFileSync(buildContextPath, JSON.stringify({ ...canonical, ...reference }));
    writeFileSync(buildOutcomePath, JSON.stringify({ runStart, card: 92, claimUrl, phase: 'build', disposition: 'built',
      reason: 'Completed native fixture build verification' }));
    return inspectAdmission({ runStart, phase: 'deliver', candidate: reference, reservations: [] }, { root, exec, git });
  };
  /** @param {{ descriptorHash: string, planHash: string }} [hashes] */
  const reference = ({ descriptorHash, planHash } = canonical) => ({ descriptorPath: canonical.descriptorPath, descriptorHash, planHash,
    reviewRecordPath: canonical.reviewRecordPath });
  git(['update-ref', 'refs/remotes/origin/main', base]);
  git(['config', 'core.quotePath', 'true']);
  try {
    await t.test('native full admission allows the clean reviewed delivery', () => {
      assert.deepEqual(admit(reference()), { decision: 'allow', reasons: [] });
    });
    await t.test('full admission refuses an unknown missing registered peer while pure ownership remains valid', () => {
      assert.deepEqual(admit(reference()), { decision: 'allow', reasons: [] }, 'every provider, origin and phase fact is present');
      const peer = join(toolkit.root, 'private-job-93-full');
      git(['worktree', 'add', '-q', '-B', 'job/93', peer]);
      rmSync(peer, { recursive: true });
      try {
        assert.ok(git(['worktree', 'list', '--porcelain', '-z']).includes(`branch refs/heads/job/93\0`), 'the missing peer is still actually registered in Git');
        const answer = admit(reference());
        assert.equal(answer.decision, 'unavailable');
        assert.equal(answer.reasons.length, 1);
        assert.match(answer.reasons[0], /ENOENT.*private-job-93-full/, 'the refusal names the missing unknown peer, not a missing fact');
        assert.equal(verify(canonical).claimCreatedAt, claimCreatedAt, 'pure ownership still resolves only the exact owned worktree');
      } finally {
        git(['worktree', 'prune', '--expire=now']);
        git(['branch', '-q', '-D', 'job/93']);
      }
      assert.deepEqual(admit(reference()), { decision: 'allow', reasons: [] }, 'pruning the registration restores admission');
    });
    await t.test('native admission reads Unicode and leading-space changes in every path list', () => {
      const changes = {
        committed: [' committed lead.txt', 'ü-committed.txt'],
        unstaged: [' unstaged lead.txt', 'é-unstaged.txt'],
        staged: [' staged lead.txt', 'ö-staged.txt'],
        untracked: [' untracked lead.txt', 'ß-untracked.txt'],
      };
      const reviewed = ['tracked.txt', ...Object.values(changes).flat()];
      const descriptorBytes = readFileSync(canonical.descriptorPath);
      const reviewBytes = readFileSync(canonical.reviewRecordPath);
      const planBytes = readFileSync(planPath);
      const extra = join(worktree, 'extra-outside.txt');
      try {
        writeFileSync(planPath, `Reviewed scope: ${reviewed.map((file) => JSON.stringify(file)).join(', ')}.\n`);
        const planHash = hash(readFileSync(planPath));
        writeFileSync(canonical.descriptorPath, JSON.stringify({ ...JSON.parse(descriptorBytes.toString('utf8')), planHash, plannedFiles: reviewed }));
        const descriptorHash = hash(readFileSync(canonical.descriptorPath));
        writeFileSync(canonical.reviewRecordPath, JSON.stringify({ ...JSON.parse(reviewBytes.toString('utf8')), descriptorHash, planHash }));
        const extended = reference({ descriptorHash, planHash });
        for (const file of [...changes.committed, ...changes.unstaged]) writeFileSync(join(worktree, file), `committed ${file}\n`);
        git(['-C', worktree, 'add', '--', ...changes.committed, ...changes.unstaged]);
        git(['-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'native path names']);
        for (const file of changes.unstaged) writeFileSync(join(worktree, file), `unstaged ${file}\n`);
        for (const file of [...changes.staged, ...changes.untracked]) writeFileSync(join(worktree, file), `new ${file}\n`);
        git(['-C', worktree, 'add', '--', ...changes.staged]);
        assert.match(git(['-C', worktree, 'ls-files', '--others', '--exclude-standard']), /^"\\303\\237-untracked\.txt"$/m,
          'native Git quotes a Unicode path in its default line output');
        assert.deepEqual(admit(extended), { decision: 'allow', reasons: [] }, 'every literal reviewed path is inside the footprint');
        writeFileSync(extra, 'outside the reviewed footprint\n');
        const answer = admit(extended);
        assert.equal(answer.decision, 'unavailable');
        assert.deepEqual(answer.reasons, ['card 92 changed extra-outside.txt outside its reviewed footprint']);
      } finally {
        git(['-C', worktree, 'reset', '-q', '--hard', head]);
        for (const file of [...changes.untracked, 'extra-outside.txt']) rmSync(join(worktree, file), { force: true });
        writeFileSync(planPath, planBytes);
        writeFileSync(canonical.descriptorPath, descriptorBytes);
        writeFileSync(canonical.reviewRecordPath, reviewBytes);
      }
      assert.equal(git(['-C', worktree, 'status', '--porcelain']), '', 'the native path changes are removed');
      assert.deepEqual(admit(reference()), { decision: 'allow', reasons: [] }, 'the original reviewed delivery is admitted again');
      assert.equal(verify(canonical).claimCreatedAt, claimCreatedAt);
    });
  } finally {
    rmSync(buildContextPath, { force: true });
    rmSync(buildOutcomePath, { force: true });
    git(['config', '--unset', 'core.quotePath']);
    git(['update-ref', '-d', 'refs/remotes/origin/main']);
  }
});

// Recurring cost: one existing empty-board toolkit fixture, four finite injected traces and one CLI child;
// no model, provider request or managed unit.
test('ANTI-REGRESSION: a terminal pre-approved Codex run refuses before starting work', async (t) => {
  const fixture = (await admissionFixture(t))({ cards: [] });
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-pre-approved-refusal-')));
  const inherited = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map((key) => [key, process.env[key]]));
  const refusal = 'Pre-approved Codex run refused: start the run in the Codex app at the repository root so every card has a visible chat.';
  const observed = [];
  const expected = [];
  let counts;
  mkdirSync(join(fixture.root, '.git'));
  const readGit = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    assert.equal(command, 'git');
    let text;
    if (args.join(' ') === 'rev-parse --path-format=absolute --git-common-dir') {
      counts.root += 1;
      text = `${join(fixture.root, '.git')}\n`;
    } else {
      counts.git += 1;
      text = fixture.git(args);
    }
    return options?.encoding ? text : Buffer.from(text);
  });
  try {
    syncBuiltinESMExports();
    for (const key of Object.keys(inherited)) process.env[key] = temporary;
    for (const managed of [false, true]) for (const args of [
      ['--pre-approved', '--coordinator', COORDINATOR],
      ['--coordinator', COORDINATOR, '--pre-approved'],
    ]) {
      counts = { root: 0, git: 0, provider: 0, session: 0, notification: 0 };
      const startSession = async () => {
        counts.session += 1;
        return { exitCode: 0 };
      };
      const logged = [];
      const errors = [];
      const code = await fixture.main(args, {
        exec: (argv) => { counts.provider += 1; return fixture.exec(argv); },
        git: (argv) => { counts.git += 1; return fixture.git(argv); },
        now: () => new Date('2026-11-05T10:15:00Z'),
        startSession, ...(managed ? { managedPhase: startSession } : {}),
        notify: async () => { counts.notification += 1; },
        output: { log: (text) => logged.push(text), error: (text) => errors.push(text) },
      });
      const label = `${managed ? 'managed' : 'fallback'} ${args.join(' ')}`;
      observed.push({ label, code, logged, errors, counts });
      expected.push({ label, code: 2, logged: [], errors: [refusal],
        counts: { root: 0, git: 0, provider: 0, session: 0, notification: 0 } });
    }
    const empty = join(temporary, 'empty');
    mkdirSync(empty);
    const cli = childProcess.spawnSync(process.execPath, [
      fileURLToPath(new URL('../pre-approved-run.mjs', import.meta.url)),
      '--coordinator', COORDINATOR, '--pre-approved',
    ], { cwd: empty, env: gitEnvironment(), encoding: 'utf8' });
    assert.ifError(cli.error);
    observed.push({ label: 'real CLI from empty directory', code: cli.status, stdout: cli.stdout, stderr: cli.stderr });
    expected.push({ label: 'real CLI from empty directory', code: 2, stdout: '', stderr: `${refusal}\n` });
    for (const result of observed) t.diagnostic(JSON.stringify(result));
    assert.deepEqual(observed, expected);
  } finally {
    readGit.mock.restore();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temporary, { recursive: true, force: true });
    await fixture.finish();
  }
});

// Recurring cost: one read each of the resume skill and its four run references.
test('the resume skill and run references name the retained launcher command, fixed prompts and guard probe', () => {
  const resume = readFileSync(new URL('../../.agents/skills/resume/SKILL.md', import.meta.url), 'utf8');
  const runs = ['runs.md', 'card-session.md', 'pre-approved-run.md', 'pre-approved-phase.md'].map((name) => readFileSync(new URL(`../../.agents/skills/resume/references/${name}`, import.meta.url), 'utf8')).join('\n');
  for (const command of [
    'node scripts/pre-approved-run.mjs --check-admission <request-file>',
    'node scripts/pre-approved-run.mjs --bind-app-job <absolute-request-file>',
    'node scripts/pre-approved-run.mjs --prepare-app-phase <absolute-phase-log-base> <ready-session-uuid> <original-claim-created-at> [<absolute-admission-request-file>]',
  ]) {
    assert.ok(runs.includes(`\`${command}\``), `the run reference does not hold the command ${command}`);
  }
  for (const text of [
    PRE_APPROVED_END_PREFIX,
    'git push --dry-run ./.pre-approved-run-no-remote HEAD',
  ]) {
    assert.ok(runs.includes(text), `the run reference does not hold ${text}`);
  }
  for (const text of [PRE_APPROVED_CARD_PROMPT, PRE_APPROVED_END_PREFIX]) {
    assert.ok(resume.includes(text), `the resume main file does not hold ${text}`);
  }
});

// Oracle: card 770's criterion that the product manager run's launcher routes are gone. Mutation: restore the
// --coordinator route. Recurring cost: in-process launcher calls that start no process.
test('ANTI-REGRESSION: the retired product manager arguments and malformed arguments exit 2 with usage and start no session', async () => {
  const base = join(tmpdir(), 'retired-card');
  for (const args of [
    [], ['--bogus'], ['--coordinator', COORDINATOR], ['--claude-card', base], ['--claude-card', base, '--carry', `${base}-ended`],
    ['--admit-job', 'build', join(tmpdir(), 'retired-admission-request.json')], ['--lead-holds', '7'],
  ]) {
    const sessions = scriptedSessions([]);
    const logged = [];
    const errors = [];
    const code = await main(args, {
      startSession: sessions.startSession, notify: async () => {},
      output: { log: (text) => logged.push(text), error: (text) => errors.push(text) },
    });
    assert.equal(code, 2, args.join(' '));
    assert.deepEqual(errors, [USAGE], args.join(' '));
    assert.deepEqual(logged, [], args.join(' '));
    assert.equal(sessions.calls.length, 0, args.join(' '));
  }
});
