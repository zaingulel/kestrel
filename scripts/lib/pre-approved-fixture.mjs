// The admission fixture serves board, claim and Git reads from private prepared worktrees.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { copyToolkit, GITHUB_TEST_CONFIG } from './board-toolkit-copy.mjs';

// Observations never throw inside a starter: assertion failures must remain visible outside production's catch.
export function readPhaseEvidence(logBase, card) {
  const observed = {};
  for (const [name, path] of Object.entries({ context: `${logBase}.context.json`,
    plan: join(dirname(logBase), `job-${card}.plan.snapshot.md`), review: join(dirname(logBase), `job-${card}.review.snapshot.md`) })) {
    try {
      observed[name] = { bytes: readFileSync(path, 'utf8') };
    } catch (error) {
      observed[name] = { error: /** @type {NodeJS.ErrnoException} */ (error).code };
    }
  }
  return observed;
}

export async function admissionFixture(t) {
  const toolkit = copyToolkit(GITHUB_TEST_CONFIG);
  t.after(() => toolkit.cleanup());
  copyFileSync(new URL('./pre-approved-run.mjs', import.meta.url), toolkit.script('lib/pre-approved-run.mjs'));
  copyFileSync(new URL('./closeout-cleanup.mjs', import.meta.url), toolkit.script('lib/closeout-cleanup.mjs'));
  copyFileSync(new URL('./run-folder.mjs', import.meta.url), toolkit.script('lib/run-folder.mjs'));
  copyFileSync(new URL('../pre-approved-run.mjs', import.meta.url), toolkit.script('pre-approved-run.mjs'));
  copyFileSync(new URL('./checkout-context.mjs', import.meta.url), toolkit.script('lib/checkout-context.mjs'));
  const { main } = await toolkit.load('pre-approved-run.mjs');
  const { boardReadExec, leanBoardPage, leanNode } = await toolkit.load('lib/board-fixtures.mjs');
  const { BOARD_OWNER, BOARD_REPOSITORY } = await toolkit.load('lib/board-config.mjs');
  const repository = `${BOARD_OWNER}/${BOARD_REPOSITORY}`;
  const repositoryId = 'R_admission_fixture';
  const runStart = '2026-11-05T10:00:00Z';
  const claimTime = '2026-11-05T10:01:00Z';
  const base = 'a'.repeat(40);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

  return ({ cards }) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pre-approved-admission-')));
    const folder = join(home, 'results');
    mkdirSync(folder);
    const jobs = new Map(cards.map((card, index) => [card, {
      card, file: String.fromCharCode(97 + index), status: 'Ready', state: 'OPEN', selected: false,
      worktree: join(home, `job-${card}`), claimUrl: `https://github.com/${repository}/issues/${card}#issuecomment-${1000 + card}`,
      head: base, deltas: new Map(), ancestry: new Map([[`${base} ${base}`, true]]),
      committed: [], unstaged: [], staged: [], untracked: [],
    }]));
    const bodyOf = (job) => `Scope evidence for card ${job.card}.`;
    const gitState = { mainTip: base, mainReadError: undefined };
    const selection = (job) => ({
      runStart, card: job.card, claimUrl: job.claimUrl, priorClaimUrls: [], branch: `job/${job.card}`, worktree: job.worktree, base,
    });
    const prepareSelected = (card) => {
      const job = jobs.get(card);
      job.selected = true;
      job.status = 'In progress';
      mkdirSync(job.worktree);
      const planPath = join(job.worktree, 'plan.md');
      writeFileSync(planPath, `Reviewed scope ${job.file} for card ${card}.\n`);
      const planHash = hash(readFileSync(planPath));
      const descriptorPath = join(folder, `job-${card}.prepared.json`);
      const reviewRecordPath = join(folder, `job-${card}.reviewed.json`);
      const reviewEvidencePath = join(folder, `job-${card}-review.md`);
      const selected = selection(job);
      job.descriptor = { ...selected, planPath, planHash, plannedFiles: job.plannedFiles ?? [job.file], prerequisites: job.prerequisites ?? [],
        exclusiveResources: job.exclusiveResources ?? [`preview-${card}`] };
      writeFileSync(descriptorPath, JSON.stringify(job.descriptor));
      const descriptorHash = hash(readFileSync(descriptorPath));
      writeFileSync(reviewEvidencePath, `Independent review accepted card ${card}'s descriptor and plan.\n`);
      writeFileSync(reviewRecordPath, JSON.stringify({
        runStart, card, claimUrl: job.claimUrl, descriptorPath, descriptorHash, planPath, planHash,
        reviewEvidencePath, reviewEvidenceHash: hash(readFileSync(reviewEvidencePath)), verdict: 'accepted',
      }));
      job.reference = { descriptorPath, descriptorHash, planHash, reviewRecordPath };
      writeFileSync(join(folder, `job-${card}-prepare.context.json`), JSON.stringify({ phase: 'prepare', ...selected }), { flag: 'wx' });
      writeFileSync(join(folder, `job-${card}-prepare.outcome.json`), JSON.stringify({ runStart, card, claimUrl: job.claimUrl,
        phase: 'prepare', disposition: 'prepared', reason: `Prepared card ${card} accepted by the independent fixture review` }));
      return { phase: 'build', ...selected, ...job.reference };
    };
    const metadata = (job) => ({
      state: job.state, title: `Admission card ${job.card}`, body: bodyOf(job), lastEditedAt: null,
      comments: { pageInfo: { hasNextPage: false }, nodes: job.selected
        ? [{ author: { login: 'owner' }, editor: null, createdAt: job.claimCreatedAt ?? claimTime, lastEditedAt: null, url: job.claimUrl,
          body: `Claim: fixture-machine Codex job/${job.card} ${job.worktree}` }] : [] },
    });
    const exec = (args) => {
      if (args[0] === 'repo' && args[1] === 'view' && args.includes('--json')) {
        return JSON.stringify({ id: repositoryId, nameWithOwner: repository, defaultBranchRef: { name: 'main' } });
      }
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (args[0] === 'api' && args[1] === 'graphql' && query.includes('comments(first: 100')) {
        const number = Number(args.find((arg) => /^number=\d+$/.test(arg))?.slice('number='.length));
        assert.ok(jobs.has(number), `unexpected admission claim identity: ${JSON.stringify(args)}`);
        // The card carries no label, on one complete page.
        const issue = { ...metadata(jobs.get(number)), labels: { pageInfo: { hasNextPage: false }, nodes: [] } };
        return JSON.stringify({ data: { viewer: { login: 'owner' }, repository: { id: repositoryId, issue } } });
      }
      if (args[0] === 'api' && args[1] === 'graphql' && query.includes('comments(last:100')) {
        const aliases = {};
        for (const [, alias, text] of query.matchAll(/(i(\d+)): issue\(number:\d+\)/g)) {
          const number = Number(text);
          assert.ok(jobs.has(number), `unexpected admission detail identity: ${number}`);
          const nodes = metadata(jobs.get(number)).comments.nodes.map(({ body, url, author }) => ({ body, url, author }));
          aliases[alias] = { number, body: bodyOf(jobs.get(number)), parent: null,
            comments: { totalCount: nodes.length, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes } };
        }
        assert.ok(Object.keys(aliases).length, `unexpected admission detail query: ${query}`);
        return JSON.stringify({ data: { repository: aliases } });
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        // A fresh board reader makes each authoritative read observe the fixture's current state.
        return boardReadExec({ board: [leanBoardPage([...jobs.values()].map((job) => leanNode({
          id: `PVTI_admission_${job.card}`, title: `Admission card ${job.card}`, status: job.status,
          content: { __typename: 'Issue', number: job.card, state: job.state, assignees: job.assignees ?? (job.selected && job.state === 'OPEN' ? ['owner'] : []) },
        })))] }).exec(args);
      }
      throw new Error(`unexpected admission gh invocation: ${JSON.stringify(args)}`);
    };
    const git = (args) => {
      const argv = [...args];
      const worktree = argv[0] === '-C' ? argv.splice(0, 2)[1] : undefined;
      const job = [...jobs.values()].find((entry) => entry.selected && entry.worktree === worktree && entry.state === 'OPEN');
      if (args.join(' ') === `-C ${toolkit.root} rev-parse --path-format=absolute --git-common-dir`) return `${join(toolkit.root, '.git')}\n`;
      if (worktree !== undefined) assert.ok(job, `unexpected admission worktree: ${worktree}`);
      if (argv[0] === 'remote' && argv[1] === 'get-url') return `https://github.com/${repository}.git\n`;
      if (argv.join(' ') === 'rev-parse --verify --quiet refs/remotes/origin/main^{commit}') return `${base}\n`;
      if (argv.join(' ') === `ls-tree --full-tree --format=%(objectmode) ${base} -- .agents/factory-settings.json`) return '100644\n';
      if (argv.join(' ') === `show ${base}:.agents/factory-settings.json`) return '{"version":1,"waitForOwner":"when-needed"}';
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
        assert.ok(job.ancestry.has(pair), `unexpected admission ancestry pair: ${pair}`);
        if (!job.ancestry.get(pair)) throw new Error('SyntheticUnavailable: original base is not an ancestor of origin/main');
        return '';
      }
      if (job && argv[0] === 'status' && argv.includes('--porcelain')) return job.unstaged.map((file) => ` M ${file}\n`).join('');
      if (job && argv[0] === 'diff' && argv.includes('--name-only') && argv.includes('-z')) {
        const range = argv.find((arg) => arg.includes('...'));
        let files;
        if (range) {
          assert.ok(job.deltas.has(range) || range === `${base}...HEAD`, `unexpected admission diff range: ${range}`);
          files = job.deltas.has(range) ? job.deltas.get(range) : job.committed;
        } else files = argv.includes('--cached') ? job.staged : job.unstaged;
        return files.map((file) => `${file}\0`).join('');
      }
      if (job && argv[0] === 'ls-files' && argv.length === 4 && ['--others', '--exclude-standard', '-z'].every((arg) => argv.includes(arg))) {
        return job.untracked.map((file) => `${file}\0`).join('');
      }
      throw new Error(`unexpected admission git invocation: ${JSON.stringify(args)}`);
    };
    return {
      main, root: toolkit.root, folder, jobs, runStart, exec, git, gitState, prepareSelected,
      finish: () => rmSync(home, { recursive: true, force: true }),
    };
  };
}
