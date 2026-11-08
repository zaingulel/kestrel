// product-manager-run.mjs — serial product manager cards or concurrent pre-approved builds,
// with one delivery lane and normally one final summary session.
//
// Product manager cards use resume's result lines. Pre-approved phases bind each selected job to its reviewed
// identity and footprint, with immutable outcomes before attention. The run-end diagnostic names held reservations.
// Message files are model text: they are matched, never obeyed. The session starter is injected,
// resolving { exitCode, spawnError, interrupted, terminationFailure, pid }; exitCode is the exit code or terminating signal.
// An interruption reports identity and termination state, queues attention, and starts no end session.
//
// A session that started counts only when its runtime log, `<logs>.stderr.log`, holds both of the runtime's own refusal
// lines of its kind: the proof that the guard fired and that the run session mark reached it. Model text cannot reach that file.
// Without them no further session starts and one fallback message reaches the owner. The reason is printed once: by the
// end session, or by the fallback when the end session cannot deliver.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fetchBoard, fetchCardDetails, isContentUnresolved, normalizeItem, pickable } from './board.mjs';
import { isEpic } from './board-rules.mjs';
import { readApproval, judgeApproval, requirePreApprovedRun } from './advance-approval.mjs';
import { parseWorktreeList } from './closeout-cleanup.mjs';
import * as boardConfig from './board-config.mjs';

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RUN_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const MANIFEST_FILE = '.agents/factory-manifest.json';
const cardNumber = (value) => Number.isSafeInteger(value) && value > 0;
const runTime = (value) => typeof value === 'string' && RUN_TIME.test(value) && !Number.isNaN(Date.parse(value));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function admissionFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new Error(`${label} must contain exactly ${fields.join(', ')}`);
  }
}

function admissionPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || CONTROL.test(value)) {
    throw new Error(`${label} must be an unambiguous absolute path`);
  }
  return value;
}

function admissionBytes(path, label) {
  admissionPath(path, label);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular unlinked file`);
  return readFileSync(path);
}

function admissionJson(path, label) {
  const bytes = admissionBytes(path, label);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new Error(`${label} is not valid JSON: ${path}`);
  }
}

// A changed path names its card, so Git's data is never reported as the reviewed plannedFiles.
function admissionFootprint(path, worktree, changedBy) {
  if (typeof path !== 'string' || !path || CONTROL.test(path) || path.includes('\\') || path.includes(':')
    || path.normalize('NFC') !== path || path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error(`${changedBy === undefined ? 'plannedFiles' : `card ${changedBy} changed path list`} contains a traversal, absolute path or ambiguous alias`);
  }
  if (path.toLowerCase() === MANIFEST_FILE && path !== MANIFEST_FILE) throw new Error('ambiguous manifest path alias');
  if (worktree === undefined) return path.toLowerCase();
  let current = worktree;
  for (const part of path.split('/')) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`${changedBy === undefined ? 'planned' : `card ${changedBy} changed`} path has a linked alias: ${path}`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return path.toLowerCase();
}

// Git -z path output is used raw: never trimmed, and only an empty list has no entries.
function readPathList(text, card) {
  if (text === '') return [];
  const entries = text.split('\0');
  if (entries.pop() !== '' || entries.includes('')) throw new Error(`card ${card} changed path list from Git is malformed`);
  return entries;
}

function admissionRepository(exec, git) {
  const repositoryName = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;
  const pushes = git(['remote', 'get-url', '--push', '--all', 'origin']).trim().split(/\r?\n/);
  const fetchUrl = git(['remote', 'get-url', 'origin']).trim();
  if (pushes.length !== 1 || pushes[0] !== fetchUrl) throw new Error('admission cannot establish one origin repository');
  if (/[?#]/.test(fetchUrl)) throw new Error('admission origin must not contain query or fragment credentials');
  const scpOrigin = /^(?:[^/@:\s]+@)?[^/@:\s]+:\/?[^/@:\s]+\/[^/@:\s]+$/;
  if (!scpOrigin.test(fetchUrl)) {
    if (!/^(?:https?|ssh|git):\/\//i.test(fetchUrl)) throw new Error('admission origin URL is invalid');
    let originUrl;
    try {
      originUrl = new URL(fetchUrl);
    } catch {
      throw new Error('admission origin URL is invalid');
    }
    if (!originUrl.hostname || !/^\/[^/@:\s]+\/[^/@:\s]+$/.test(originUrl.pathname)) throw new Error('admission origin URL is invalid');
    if (originUrl.password || (['http:', 'https:', 'git:'].includes(originUrl.protocol) && originUrl.username)) {
      throw new Error('admission origin must not contain credentials');
    }
  }
  const repository = JSON.parse(exec(['repo', 'view', '--json', 'id,nameWithOwner,defaultBranchRef', '--', fetchUrl]));
  if (typeof repository.id !== 'string' || !/^\S+$/.test(repository.id) || repository.nameWithOwner !== repositoryName
    || typeof repository.defaultBranchRef?.name !== 'string' || !/^\S+$/.test(repository.defaultBranchRef.name)) throw new Error('origin repository differs from the configured board repository');
  return repository;
}

// One spelling of a worktree identity: its resolved real path, NFC-normalized and case-folded.
function canonicalWorktreeKey(path) {
  return realpathSync(path).normalize('NFC').toLowerCase();
}

function readWorktreeRecords(git) {
  const records = parseWorktreeList(git(['worktree', 'list', '--porcelain', '-z']));
  if (!records) throw new Error('Git worktree inventory has an unreadable record');
  return records.map((record) => {
    if (CONTROL.test(record.path)) throw new Error('Git worktree inventory path contains a control character');
    return { path: record.path, branch: record.branch?.replace(/^refs\/heads\//, ''), head: record.HEAD };
  });
}

export function readWorktreeInventory(git) {
  return readWorktreeRecords(git).map((record) => ({ ...record, key: canonicalWorktreeKey(record.path) }));
}

function readRunInventory(exec, git, records = readWorktreeRecords(git), closing = new Map(), board = fetchBoard(exec), suppliedDetails) {
  const byCard = new Map(board.filter((item) => item.content.__typename === 'Issue').map((item) => [item.content.number, item]));
  const worktrees = records.map((record) => {
    const match = /^job\/([1-9]\d*)$/.exec(record.branch ?? '');
    const owner = closing.get(Number(match?.[1]));
    try {
      return { ...record, key: canonicalWorktreeKey(record.path) };
    } catch (error) {
      if (error.code !== 'ENOENT' || !owner) {
        if (error.code === 'ENOENT') {
          error.inventoryCard = Number(match?.[1]);
        }
        throw error;
      }
      return record;
    }
  });
  const openCards = [...byCard].filter(([, item]) => item.content.state === 'OPEN' && !boardConfig.TERMINAL_STATUSES.includes(item.status));
  const details = suppliedDetails ?? fetchCardDetails(exec, openCards.map(([card]) => card));
  const currentCards = new Set();
  const heldCards = new Set();
  for (const [card, item] of openCards) {
    const detail = details.get(card);
    if (detail.unavailable || detail.commentsUnavailable) throw new Error(`card ${card} inventory details unavailable: ${detail.unavailable || detail.commentsUnavailable}`);
    const held = detail.comments.some((comment) => {
      const firstLine = comment.trimStart().split(/[\r\n]/, 1)[0].trimEnd();
      return firstLine.startsWith('Needs owner:') && new RegExp(`Job: job/${card} on \\S+\\.$`).test(firstLine);
    });
    if ((['In progress', 'Awaiting push', 'In review'].includes(item.status) && !isEpic(normalizeItem(item))) || held) currentCards.add(card);
    if (held) heldCards.add(card);
  }
  for (const entry of worktrees) {
    const match = /^job\/([1-9]\d*)$/.exec(entry.branch ?? '');
    if (!match) continue;
    const card = Number(match[1]);
    const item = byCard.get(card);
    if (!cardNumber(card) || !COMMIT.test(entry.head) || !item
      || (!closing.has(card) && (item.content.state !== 'OPEN' || boardConfig.TERMINAL_STATUSES.includes(item.status)))) {
      throw new Error(`Git job ${entry.branch} has no verifiable current open board job`);
    }
    currentCards.add(card);
  }
  return { byCard, worktrees, currentCards, heldCards };
}

function verifyClaimOwner(selection, metadata, item) {
  const claims = metadata.issue.comments.nodes.filter((comment) => comment.body.trimStart().startsWith('Claim:') && !selection.priorClaimUrls.includes(comment.url));
  const claim = claims[0];
  if (claim?.url !== selection.claimUrl || claim?.author?.login !== metadata.login || !Number.isFinite(Date.parse(claim?.createdAt))) {
    throw new Error(`claim ownership changed for card ${selection.card}`);
  }
  if (!item || item.assignees.length !== 1 || item.assignees[0] !== metadata.login) throw new Error(`card ${selection.card} assignment does not confirm current claim ownership`);
  return claim;
}

function verifyClaimedJob(selection, { runStart, metadata, item, inventory, git }) {
  const judgement = judgeApproval(selection.card, metadata, { before: runStart, run: true });
  if (!judgement.startsWith('approved ')) throw new Error(`approval unavailable: ${judgement}`);
  if (!item || item.content.state !== 'OPEN' || boardConfig.TERMINAL_STATUSES.includes(item.status)) throw new Error(`card ${selection.card} has no current open board job`);
  const claim = verifyClaimOwner(selection, metadata, item);
  const key = canonicalWorktreeKey(selection.worktree);
  const entries = inventory.filter((entry) => entry.branch === selection.branch);
  if (entries.length !== 1 || canonicalWorktreeKey(entries[0].path) !== key || !COMMIT.test(entries[0].head)) throw new Error(`Git worktree ownership is unavailable for card ${selection.card}`);
  const readGit = (args) => git(['-C', selection.worktree, ...args]).trim();
  if (canonicalWorktreeKey(readGit(['rev-parse', '--show-toplevel'])) !== key
    || readGit(['symbolic-ref', '--quiet', '--short', 'HEAD']) !== selection.branch
    || readGit(['rev-parse', '--verify', 'HEAD']) !== entries[0].head) throw new Error(`Git branch or HEAD changed for card ${selection.card}`);
  readGit(['merge-base', '--is-ancestor', selection.base, 'HEAD']);
  return claim;
}

function readPreparedReference(reference, runStart, reserved = false) {
  admissionFields(reference, ['descriptorPath', 'descriptorHash', 'planHash', 'reviewRecordPath', ...(reserved ? ['phase'] : [])], 'job reference');
  if (!HASH.test(reference.descriptorHash) || !HASH.test(reference.planHash)) throw new Error('job reference hashes must be lowercase SHA256');
  if (reserved && !['prepare', 'build', 'deliver'].includes(reference.phase)) throw new Error('reservation phase is unavailable');
  const prepared = admissionJson(reference.descriptorPath, 'prepared descriptor');
  const descriptor = prepared.value;
  admissionFields(descriptor, ['runStart', 'card', 'claimUrl', 'priorClaimUrls', 'branch', 'worktree', 'base', 'planPath', 'planHash', 'plannedFiles', 'prerequisites', 'scopeComplete', 'exclusiveResources'], 'prepared descriptor');
  validateSelection(Object.fromEntries(SELECTION_FIELDS.map((field) => [field, descriptor[field]])), runStart);
  if (typeof descriptor.scopeComplete !== 'boolean' || !Array.isArray(descriptor.plannedFiles)
    || !Array.isArray(descriptor.prerequisites) || !Array.isArray(descriptor.exclusiveResources)) {
    throw new Error('prepared descriptor has invalid scopeComplete or scope declarations');
  }
  if (basename(reference.descriptorPath) !== `job-${descriptor.card}.prepared.json`
    || reference.reviewRecordPath !== join(dirname(reference.descriptorPath), `job-${descriptor.card}.reviewed.json`)) {
    throw new Error('descriptor and review record paths are not paired');
  }
  const record = admissionJson(reference.reviewRecordPath, 'accepted review record').value;
  admissionFields(record, ['runStart', 'card', 'claimUrl', 'descriptorPath', 'descriptorHash', 'planPath', 'planHash', 'reviewEvidencePath', 'reviewEvidenceHash', 'verdict'], 'accepted review record');
  if (record.verdict !== 'accepted' || record.runStart !== runStart || record.card !== descriptor.card
    || record.claimUrl !== descriptor.claimUrl || record.descriptorPath !== reference.descriptorPath
    || record.descriptorHash !== reference.descriptorHash || record.planHash !== reference.planHash
    || record.planPath !== descriptor.planPath || descriptor.planHash !== reference.planHash || !HASH.test(record.reviewEvidenceHash)) {
    throw new Error(`review record does not accept the exact descriptor and plan for card ${descriptor.card}`);
  }
  if (sha256(prepared.bytes) !== reference.descriptorHash) throw new Error(`reviewed descriptor, plan or review evidence bytes changed for card ${descriptor.card}`);
  if (descriptor.exclusiveResources.some((label) => typeof label !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/.test(label) || label.includes('://'))) {
    throw new Error('exclusiveResources must be stable resource labels, never connection URLs');
  }
  const resources = descriptor.exclusiveResources.map((label) => label.toLowerCase());
  if (new Set(resources).size !== resources.length) throw new Error('duplicate exclusive resource labels');
  const prerequisites = new Set();
  for (const prerequisite of descriptor.prerequisites) {
    admissionFields(prerequisite, ['repository', 'number'], 'reviewed prerequisite');
    if (typeof prerequisite.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(prerequisite.repository) || !cardNumber(prerequisite.number)) throw new Error('reviewed prerequisite identity is invalid');
    const key = `${prerequisite.repository.toLowerCase()}#${prerequisite.number}`;
    if (prerequisites.has(key)) throw new Error('duplicate reviewed prerequisite identity');
    prerequisites.add(key);
  }
  return { descriptor, resources, record, phase: reference.phase, reference };
}

function readPreparedFiles(descriptor) {
  const files = descriptor.plannedFiles.map((path) => admissionFootprint(path, descriptor.worktree));
  if (new Set(files).size !== files.length) throw new Error(`ambiguous planned file aliases for card ${descriptor.card}`);
  return files;
}

function hydratePreparedJob(job) {
  const planBytes = admissionBytes(job.descriptor.planPath, 'reviewed plan');
  const reviewBytes = admissionBytes(job.record.reviewEvidencePath, 'retained review evidence');
  if (sha256(planBytes) !== job.reference.planHash || sha256(reviewBytes) !== job.record.reviewEvidenceHash) {
    throw new Error(`reviewed descriptor, plan or review evidence bytes changed for card ${job.descriptor.card}`);
  }
  return { ...job, files: readPreparedFiles(job.descriptor), planBytes, reviewBytes, worktreeKey: canonicalWorktreeKey(job.descriptor.worktree) };
}

function readPreparedJob(reference, runStart) {
  return hydratePreparedJob(readPreparedReference(reference, runStart));
}

function readJobLifecycle(job, runStart) {
  const selection = Object.fromEntries(SELECTION_FIELDS.map((field) => [field, job.descriptor[field]]));
  const directory = dirname(job.reference.descriptorPath);
  const contexts = {};
  const outcomes = {};
  for (const phase of ['prepare', 'build', 'deliver']) {
    const expected = { phase, ...selection, ...(phase === 'prepare' ? {} : {
      descriptorPath: job.reference.descriptorPath, descriptorHash: job.reference.descriptorHash,
      planHash: job.reference.planHash, reviewRecordPath: job.reference.reviewRecordPath,
    }) };
    try {
      const context = admissionJson(join(directory, `job-${selection.card}-${phase}.context.json`), `card ${selection.card} retained ${phase} context`).value;
      admissionFields(context, Object.keys(expected), `card ${selection.card} retained ${phase} context`);
      for (const field of Object.keys(expected)) {
        if (JSON.stringify(context[field]) !== JSON.stringify(expected[field])) throw new Error(`card ${selection.card} retained ${phase} context ${field} differs from reviewed identity`);
      }
      contexts[phase] = context;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      outcomes[phase] = readPhaseOutcome({ ...selection, runStart }, directory, phase);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (['build', 'deliver'].includes(job.phase) && !contexts[job.phase]) {
    throw new Error(`card ${selection.card} expected retained ${job.phase} context is unavailable`);
  }
  return { contexts, outcomes };
}

function prerequisiteReasons(job, byCard, repositoryName, exec) {
  const reasons = [];
  let unreadable = false;
  for (const blocker of byCard.get(job.descriptor.card).blockers) {
    if (blocker.state === 'OPEN') reasons.push(`card ${job.descriptor.card} waits for native prerequisite ${blocker.number}`);
  }
  for (const prerequisite of job.descriptor.prerequisites) {
    let state;
    if (prerequisite.repository === repositoryName && byCard.has(prerequisite.number)) state = byCard.get(prerequisite.number).content.state;
    else {
      try {
        state = JSON.parse(exec(['issue', 'view', String(prerequisite.number), '--repo', prerequisite.repository, '--json', 'state'])).state;
      } catch {
        unreadable = true;
        reasons.push(`card ${job.descriptor.card} waits for unreadable prerequisite ${prerequisite.repository}#${prerequisite.number}`);
        continue;
      }
    }
    if (state !== 'OPEN' && state !== 'CLOSED') {
      unreadable = true;
      reasons.push(`card ${job.descriptor.card} waits for unreadable prerequisite ${prerequisite.repository}#${prerequisite.number}`);
    } else if (state !== 'CLOSED') reasons.push(`card ${job.descriptor.card} waits for prerequisite ${prerequisite.repository}#${prerequisite.number}`);
  }
  return { reasons, unreadable };
}

function conflictReasons(candidate, reserved) {
  const reasons = [];
  if (!candidate.descriptor.scopeComplete || !reserved.descriptor.scopeComplete) reasons.push(`card ${candidate.descriptor.card} needs exclusive admission: incomplete scope beside card ${reserved.descriptor.card}`);
  for (const a of candidate.files) for (const b of reserved.files) {
    if (a === MANIFEST_FILE && b === MANIFEST_FILE) continue;
    if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) reasons.push(`card ${candidate.descriptor.card} overlaps card ${reserved.descriptor.card}: ${a} / ${b}`);
  }
  for (const resource of candidate.resources) if (reserved.resources.includes(resource)) reasons.push(`card ${candidate.descriptor.card} waits for card ${reserved.descriptor.card} resource ${resource}`);
  return reasons;
}

function validateJobIdentities(jobs) {
  for (const field of ['card', 'claimUrl', 'branch']) {
    if (new Set(jobs.map((job) => job.descriptor[field])).size !== jobs.length) throw new Error(`duplicate job ${field} identity`);
  }
}

function readMainTip(git) {
  let mainTip;
  try {
    mainTip = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']).trim();
  } catch (error) {
    throw new Error(`origin/main commit is unavailable: ${error.message}`);
  }
  if (!COMMIT.test(mainTip)) throw new Error('origin/main did not resolve to a full commit hash');
  return mainTip;
}

function readJobRoot(job) {
  try {
    return realpathSync(job.descriptor.worktree);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

function readClosingBytes(job) {
  const directory = dirname(job.reference.descriptorPath);
  for (const [name, path, hash] of [['plan', job.descriptor.planPath, job.reference.planHash],
    ['review', job.record.reviewEvidencePath, job.record.reviewEvidenceHash]]) {
    const snapshot = admissionBytes(join(directory, `job-${job.descriptor.card}.${name}.snapshot.md`), `card ${job.descriptor.card} ${name} snapshot`);
    if (sha256(snapshot) !== hash) throw new Error(`card ${job.descriptor.card} ${name} snapshot differs from accepted evidence`);
    try {
      if (sha256(admissionBytes(path, `card ${job.descriptor.card} original ${name}`)) !== hash) {
        throw new Error(`card ${job.descriptor.card} original ${name} differs from accepted evidence`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function readClosingJobs(jobs, runStart, { exec, repository }) {
  for (const job of jobs) {
    job.lifecycle = readJobLifecycle(job, runStart);
    job.inactive = false;
  }
  const board = fetchBoard(exec);
  const byCard = new Map(board.filter((item) => item.content.__typename === 'Issue').map((item) => [item.content.number, item]));
  const approvals = new Map();
  const approval = (card) => {
    if (!approvals.has(card)) approvals.set(card, readApproval(card, { exec, repository }));
    return approvals.get(card);
  };
  const closing = new Map();
  for (const job of jobs) {
    const { contexts, outcomes } = job.lifecycle;
    if (job.phase !== 'deliver' || !contexts.deliver || !contexts.build || outcomes.build?.disposition !== 'built' || outcomes.deliver) continue;
    const item = byCard.get(job.descriptor.card);
    const root = readJobRoot(job);
    const metadata = approval(job.descriptor.card);
    if (root !== undefined && metadata.issue.state !== 'CLOSED' && item?.content.state !== 'CLOSED' && !boardConfig.TERMINAL_STATUSES.includes(item?.status)) continue;
    const claim = verifyClaimOwner(job.descriptor, metadata, item);
    readClosingBytes(job);
    job.files = readPreparedFiles(job.descriptor);
    job.claimCreatedAt = Date.parse(claim.createdAt);
    job.worktreeKey = root?.normalize('NFC').toLowerCase();
    closing.set(job.descriptor.card, job);
  }
  return { board, closing, approval };
}

function readActualPaths({ card, worktree, base }, git, mainTip, closing = false) {
  const readGit = (args) => git(['-C', worktree, ...args]);
  try {
    readGit(['merge-base', '--is-ancestor', base, mainTip]);
  } catch (error) {
    if (error.status !== 1 && closing && !readJobRoot({ descriptor: { worktree } })) throw error;
    throw new Error(`card ${card} original-base ancestry to origin/main is unavailable: ${error.message}`);
  }
  return [
    ['diff', '--name-only', '--no-renames', '-z', `${mainTip}...HEAD`],
    ['diff', '--name-only', '--no-renames', '-z'],
    ['diff', '--name-only', '--no-renames', '-z', '--cached'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ].flatMap((args) => readPathList(readGit(args), card));
}

function verifyRunJobs(jobs, runStart, readers, retry, facts) {
  const { exec, git, mainTip } = readers;
  if (retry) for (const job of jobs) Object.assign(job, readPreparedReference(job.reference, runStart, job.phase !== undefined));
  const { board, closing, approval } = facts ?? readClosingJobs(jobs, runStart, readers);
  if (retry && !closing.has(retry.card)) throw retry.error;
  let inventory;
  try {
    inventory = readRunInventory(exec, git, undefined, closing, board);
  } catch (error) {
    const owner = jobs.find((job) => job.phase === 'deliver' && job.descriptor.card === error.inventoryCard);
    if (!retry && owner) return verifyRunJobs(jobs, runStart, readers, { card: owner.descriptor.card, error });
    throw error;
  }
  for (const job of jobs) {
    if (closing.has(job.descriptor.card)) continue;
    try {
      Object.assign(job, hydratePreparedJob(job));
    } catch (error) {
      // Only this job's original plan/review/root hydration can attribute an ENOENT transition.
      if (!retry && job.phase === 'deliver' && error.code === 'ENOENT') return verifyRunJobs(jobs, runStart, readers, { card: job.descriptor.card, error });
      throw error;
    }
    const metadata = approval(job.descriptor.card);
    let claim;
    let changed;
    try {
      claim = verifyClaimedJob(job.descriptor, { runStart, metadata, item: inventory.byCard.get(job.descriptor.card), inventory: inventory.worktrees, git });
      changed = readActualPaths(job.descriptor, git, mainTip, job.phase === 'deliver');
    } catch (error) {
      if (!retry && job.phase === 'deliver' && error.status !== 1
        && (error.code === 'ENOENT' || Number.isInteger(error.status)) && readJobRoot(job) === undefined) {
        return verifyRunJobs(jobs, runStart, readers, { card: job.descriptor.card, error });
      }
      throw error;
    }
    for (const path of changed) {
      const file = admissionFootprint(path, job.descriptor.worktree, job.descriptor.card);
      if (!job.files.some((planned) => file === planned || file.startsWith(planned + '/'))) throw new Error(`card ${job.descriptor.card} changed ${path} outside its reviewed footprint`);
    }
    job.claimCreatedAt = Date.parse(claim.createdAt);
    const { contexts, outcomes } = job.lifecycle;
    job.inactive = !!contexts.prepare && outcomes.prepare?.disposition === 'prepared'
      && !contexts.build && !contexts.deliver && !outcomes.build && !outcomes.deliver
      && !inventory.heldCards.has(job.descriptor.card) && changed.length === 0;
  }
  const keys = jobs.map((job) => job.worktreeKey).filter((key) => key !== undefined);
  if (new Set(keys).size !== keys.length) throw new Error('duplicate or aliased job worktree');
  const identities = new Map(jobs.map((job) => [job.descriptor.card, job]));
  for (const entry of inventory.worktrees) {
    if (!/^job\/[1-9]\d*$/.test(entry.branch ?? '')) continue;
    const owner = identities.get(Number(entry.branch.slice('job/'.length)));
    if (owner && (owner.worktreeKey !== entry.key || owner.descriptor.branch !== entry.branch)) {
      throw new Error(`Git job ${entry.branch} ownership differs from its reviewed reservation`);
    }
  }
  return { inventory, closing };
}

// The request names evidence, never the inventory or a precomputed admission verdict.
export function inspectAdmission(request, { root, exec, git }) {
  try {
    admissionFields(request, ['runStart', 'phase', 'candidate', 'reservations'], 'admission request');
    if (!runTime(request.runStart) || !['build', 'deliver'].includes(request.phase) || !Array.isArray(request.reservations)) throw new Error('admission request has no valid runStart, phase or reservations');
    if (typeof exec !== 'function' || typeof git !== 'function' || !root) throw new Error('authoritative admission readers are unavailable');
    if (boardConfig.TRACKER && boardConfig.TRACKER !== 'github') throw new Error('pre-approved admission requires GitHub issue ownership');
    const candidate = readPreparedReference(request.candidate, request.runStart);
    const reservations = request.reservations.map((reference) => readPreparedReference(reference, request.runStart, true));
    const jobs = [candidate, ...reservations];
    validateJobIdentities(jobs);
    const repositoryName = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;
    const repository = admissionRepository(exec, git);
    const mainTip = readMainTip(git);
    const { inventory: { byCard, currentCards }, closing } = verifyRunJobs(jobs, request.runStart, { exec, git, repository, mainTip });
    const identities = new Map(jobs.map((job) => [job.descriptor.card, job]));
    if (request.phase === 'build' && !candidate.inactive) throw new Error(`card ${candidate.descriptor.card} has no verified inactive prepared state for build`);
    if (request.phase === 'deliver' && (!candidate.lifecycle.contexts.build || candidate.lifecycle.outcomes.build?.disposition !== 'built')) {
      throw new Error(`card ${candidate.descriptor.card} delivery requires matching retained build context and completed built outcome`);
    }
    if (closing.size) return { decision: 'wait', reasons: [...closing.keys()].map((card) => `card ${card} delivery closeout is settling; admission waits`) };
    const reasons = [...currentCards].filter((card) => !identities.has(card))
      .map((card) => `current job ${card} has no reviewed reservation or complete footprint; admission waits`);
    reasons.push(...prerequisiteReasons(candidate, byCard, repositoryName, exec).reasons);
    const binding = jobs.filter((job) => !job.inactive);
    for (const reserved of reservations) {
      const conflicts = conflictReasons(candidate, reserved);
      if (!conflicts.length) continue;
      if (!reserved.inactive) {
        reasons.push(...conflicts);
        continue;
      }
      if (request.phase === 'deliver') continue;
      const eligibility = prerequisiteReasons(reserved, byCard, repositoryName, exec);
      if (eligibility.unreadable) {
        reasons.push(...eligibility.reasons);
        continue;
      }
      if (eligibility.reasons.length || binding.some((job) => conflictReasons(reserved, job).length)) continue;
      if (reserved.claimCreatedAt < candidate.claimCreatedAt
        || (reserved.claimCreatedAt === candidate.claimCreatedAt && reserved.descriptor.card < candidate.descriptor.card)) reasons.push(...conflicts);
    }
    return { decision: reasons.length ? 'wait' : 'allow', reasons };
  } catch (error) {
    return { decision: 'unavailable', reasons: [error.message] };
  }
}

export const CARD_PROMPT = 'Continue the product manager run.';
export const PRE_APPROVED_CARD_PROMPT = 'Select and claim one eligible pre-approved job. Do not plan, build, or deliver.';
export const END_PROMPT_PREFIX = 'End the product manager run: ';
export const GUARD_WITNESS = 'Command blocked by PreToolUse hook: Blocked: git commit';
export const PUBLISH_WITNESS = 'Command blocked by PreToolUse hook: Blocked: a product manager run session';
export const PRE_APPROVED_WITNESS = 'Command blocked by PreToolUse hook: Blocked: a pre-approved run session';

// Product manager result lines match the whole last line: `built 1` followed by more text is no result.
const BUILT = /^Run result: built \S+$/;
const PARKED = /^Run result: parked \S+: \S.*$/;
const STOP = /^Run result: stop \S+: \S.*$/;
const KINDS = {
  'product-manager': {
    cardPrompt: CARD_PROMPT,
    endPrefix: END_PROMPT_PREFIX,
    witness: PUBLISH_WITNESS,
    resultLines: { built: BUILT, parked: PARKED, split: /^Run result: split \S+ into \S.*$/, stop: STOP },
  },
  'pre-approved': {
    endPrefix: 'End the pre-approved run: ',
  },
};

export function sessionArgv(outputFile, prompt) {
  return [
    'exec',
    '--sandbox', 'workspace-write',
    '-c', 'approval_policy=on-request',
    '-c', 'approvals_reviewer=auto_review',
    '--json',
    '--output-last-message', outputFile,
    prompt,
  ];
}

export function readRunResult(text) {
  const line = text.trimEnd().split(/\r?\n/).pop();
  const match = Object.entries(KINDS['product-manager'].resultLines).find(([, pattern]) => pattern.test(line));
  return { kind: match ? match[0] : 'none', line };
}

// A file that is missing or unreadable counts as empty.
function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const failure = ({ managedFailure, spawnError, exitCode }) => managedFailure ?? spawnError ?? (exitCode === 0 ? undefined : `exited with ${exitCode}`);

// Names the first refusal the runtime log lacks, or undefined when it holds both.
function missingRefusal(log, witness) {
  if (!log.includes(GUARD_WITNESS)) return 'guard refusal';
  return log.includes(witness) ? undefined : 'publish refusal';
}

// Identity is display-only metadata. Never follow links or read more than the fixed sidecar limit.
function readCardIdentity(file) {
  let descriptor;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 130) return { kind: 'unavailable' };
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 130 || opened.dev !== before.dev || opened.ino !== before.ino) return { kind: 'unavailable' };
    const buffer = Buffer.alloc(131);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > 130) return { kind: 'unavailable' };
    const text = buffer.subarray(0, length).toString('latin1');
    const value = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
    return value.length >= 1 && value.length <= 128 && !/[^\x21-\x7e]/.test(value)
      ? { kind: 'valid', value } : { kind: 'unavailable' };
  } catch (error) {
    return { kind: error.code === 'ENOENT' ? 'missing' : 'unavailable' };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function cancellationReason(session, name, identityFile, guardEvidence) {
  let label = name === 'end' ? 'End session' : 'Card session';
  let identityDetail = '';
  if (name !== 'end') {
    const identity = session.terminationFailure ? { kind: 'unavailable' } : readCardIdentity(identityFile);
    if (identity.kind === 'valid') label = `Card ${identity.value}`;
    else if (identity.kind === 'missing') {
      label = 'Card selection';
      identityDetail = '; no identity was recorded';
    } else identityDetail = '; card identity unavailable';
  }
  return cancellationMessage(session, label, identityDetail, guardEvidence);
}

function cancellationMessage(session, label, identityDetail, guardEvidence) {
  const termination = session.terminationFailure
    ? `; termination unverified for PID ${session.pid}: ${session.terminationFailure}` : '';
  const guard = guardEvidence ? `; ${guardEvidence}` : '';
  const disposition = `interrupted by ${session.interrupted}`;
  const lifetime = session.managedStop?.disposition === 'verified-local'
    ? 'exact native unit and its local processes stopped; external effects unverified'
    : session.managedStop?.reason ?? 'descendant termination unverified; detached tools may still be running';
  return `${label} ${disposition}${identityDetail}${termination}${guard}; ${lifetime}`;
}

const PHASE_PROMPTS = {
  select: PRE_APPROVED_CARD_PROMPT,
  prepare: 'Prepare this exact pre-approved job. Do not build or deliver.',
  build: 'Build and verify this exact prepared job. Do not publish or deliver.',
  deliver: 'Deliver this exact built job. Do not select or build another job.',
};
const SELECTION_FIELDS = ['runStart', 'card', 'claimUrl', 'priorClaimUrls', 'branch', 'worktree', 'base'];
const PREPARED_REFERENCE_FIELDS = ['descriptorPath', 'descriptorHash', 'planHash', 'reviewRecordPath'];
const GUARD_RECOVERY = 'Check it as "Before intake" in the resume skill says.';

function validateSelection(selection, runStart) {
  admissionFields(selection, SELECTION_FIELDS, 'selected job');
  if (selection.runStart !== runStart || !cardNumber(selection.card) || selection.branch !== `job/${selection.card}`
    || typeof selection.claimUrl !== 'string' || !/^https:\/\/\S+#issuecomment-[1-9]\d*$/.test(selection.claimUrl)
    || !Array.isArray(selection.priorClaimUrls) || selection.priorClaimUrls.some((url) => typeof url !== 'string' || !/^https:\/\/\S+$/.test(url))
    || new Set(selection.priorClaimUrls).size !== selection.priorClaimUrls.length || !COMMIT.test(selection.base)) {
    throw new Error('selected job has an invalid or repeated identity');
  }
  admissionPath(selection.worktree, 'selected worktree');
}

function readPhaseContext(context, runStart) {
  const phase = context?.phase;
  if (!['prepare', 'build', 'deliver'].includes(phase)) throw new Error('prepared context has no valid phase');
  admissionFields(context, ['phase', ...SELECTION_FIELDS, ...(phase === 'prepare' ? [] : PREPARED_REFERENCE_FIELDS)], 'prepared context');
  const selection = Object.fromEntries(SELECTION_FIELDS.map((field) => [field, context[field]]));
  validateSelection(selection, runStart);
  let job;
  if (phase !== 'prepare') {
    const reference = Object.fromEntries(PREPARED_REFERENCE_FIELDS.map((field) => [field, context[field]]));
    job = readPreparedJob(reference, runStart);
    for (const field of SELECTION_FIELDS) {
      if (JSON.stringify(job.descriptor[field]) !== JSON.stringify(selection[field])) throw new Error(`prepared context ${field} differs from its reviewed descriptor`);
    }
  }
  return { selection, job };
}

function verifyEvidenceDirectory(directory, jobWorktrees) {
  const key = canonicalWorktreeKey(directory);
  if (!Array.isArray(jobWorktrees) || jobWorktrees.length === 0) throw new Error('complete Git worktree inventory is unavailable for evidence location');
  for (const worktree of jobWorktrees) {
    let rootKey;
    try {
      rootKey = canonicalWorktreeKey(worktree);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (key === rootKey || key.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep)) {
      throw new Error(`phase evidence directory is inside an inventory worktree: ${worktree}`);
    }
  }
}

function readPhaseOutcome(context, directory, phase, disposition) {
  const record = admissionJson(join(directory, `job-${context.card}-${phase}.outcome.json`), `${phase} outcome`).value;
  admissionFields(record, ['runStart', 'card', 'claimUrl', 'phase', 'disposition', 'reason'], `${phase} outcome`);
  const completed = phase === 'prepare' ? ['prepared'] : phase === 'build' ? ['built'] : ['merged', 'awaiting-push'];
  if (record.runStart !== context.runStart || record.card !== context.card || record.claimUrl !== context.claimUrl
    || record.phase !== phase || ![...completed, 'parked', 'stopped', 'failed', 'budget-exhausted', 'timed-out', 'interrupted'].includes(record.disposition)
    || (disposition !== undefined && record.disposition !== disposition) || typeof record.reason !== 'string' || !record.reason.trim()) {
    throw new Error(`card ${context.card} has no matching completed ${disposition ?? phase} outcome`);
  }
  return record;
}

export function retainPreparedContext(context, logBase, jobWorktrees) {
  admissionPath(logBase, 'phase log base');
  const { job } = readPhaseContext(context, context.runStart);
  const directory = dirname(logBase);
  if (basename(logBase) !== `job-${context.card}-${context.phase}`
    || (context.phase !== 'prepare' && directory !== dirname(context.descriptorPath))) {
    throw new Error('prepared context does not match the fixed phase output identity');
  }
  verifyEvidenceDirectory(directory, jobWorktrees);
  for (const suffix of ['.context.json', '.outcome.json', '.json', '.jsonl', '.stderr.log', '.txt', '.card']) {
    try {
      lstatSync(logBase + suffix);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`refusing existing phase evidence: ${logBase + suffix}`);
  }
  if (context.phase === 'build') readPhaseOutcome(context, directory, 'prepare', 'prepared');
  if (context.phase === 'deliver') {
    readPhaseOutcome(context, directory, 'build', 'built');
    const retained = admissionJson(join(directory, `job-${context.card}-build.context.json`), 'retained build context').value;
    admissionFields(retained, Object.keys(context), 'retained build context');
    for (const field of Object.keys(context)) {
      const expected = field === 'phase' ? 'build' : context[field];
      if (JSON.stringify(retained[field]) !== JSON.stringify(expected)) throw new Error(`retained build context ${field} differs from delivery identity`);
    }
  }
  if (job) for (const [name, bytes] of [['plan', job.planBytes], ['review', job.reviewBytes]]) {
    const path = join(directory, `job-${context.card}.${name}.snapshot.md`);
    try {
      if (!admissionBytes(path, `${name} snapshot`).equals(bytes)) throw new Error(`${name} snapshot differs from accepted evidence for card ${context.card}`);
    } catch (error) {
      if (error.code !== 'ENOENT' || context.phase !== 'build') throw error;
      writeFileSync(path, bytes, { flag: 'wx' });
    }
  }
  writeFileSync(logBase + '.context.json', JSON.stringify(context) + '\n', { flag: 'wx' });
}

export function verifyPreparedContext(context, { runStart, exec, git }) {
  const { selection } = readPhaseContext(context, runStart);
  const verified = verifyClaimContext(selection, { runStart, exec, git });
  return { prompt: `${PHASE_PROMPTS[context.phase]}\n${JSON.stringify(context)}`, ...verified };
}

export function prepareAppPhase(logBase, { claimCreatedAt, admissionFile, readConnection, root, exec, git }) {
  const context = admissionJson(`${logBase}.request.json`, 'app phase request').value;
  const phase = context?.phase;
  if (!['prepare', 'build', 'deliver'].includes(phase)) throw new Error('prepared context has no valid phase');
  if ((phase === 'prepare') !== (admissionFile === undefined)) return null;

  const worktree = admissionPath(context.worktree, 'selected worktree');
  const binding = readConnection(worktree);
  if (binding?.kind !== 'pre-approved' || binding.runStart !== context.runStart || binding.card !== context.card || binding.worktree !== worktree) {
    throw new Error('the app connection does not match the selected pre-approved job');
  }
  requirePreApprovedRun({ git });
  const verified = verifyPreparedContext(context, { runStart: binding.runStart, exec, git });
  if (verified.claimCreatedAt !== claimCreatedAt) throw new Error('the original claim time no longer matches the current claim');

  if (phase === 'prepare') {
    for (const later of ['build', 'deliver']) for (const suffix of ['.context.json', '.outcome.json']) {
      const path = join(dirname(logBase), `job-${context.card}-${later}${suffix}`);
      if (lstatSync(path, { throwIfNoEntry: false })) throw new Error('later app phase evidence already exists');
    }
  } else {
    const request = admissionJson(admissionFile, 'app admission request').value;
    if (request?.runStart !== binding.runStart || request.phase !== phase ||
        PREPARED_REFERENCE_FIELDS.some((field) => request.candidate?.[field] !== context[field])) {
      throw new Error('the admission request does not match the prepared phase and reviewed candidate');
    }
    const decision = inspectAdmission(request, { root, exec, git });
    if (decision.decision !== 'allow') return decision;
  }

  retainPreparedContext(context, logBase, verified.jobWorktrees);
  return { decision: 'allow', prompt: verified.prompt, contextPath: `${logBase}.context.json` };
}

function verifyClaimContext(selection, { runStart, exec, git }) {
  const repository = admissionRepository(exec, git);
  const metadata = readApproval(selection.card, { exec, repository });
  const item = fetchBoard(exec).find((entry) => entry.content.__typename === 'Issue' && entry.content.number === selection.card);
  const inventory = readWorktreeRecords(git);
  const claim = verifyClaimedJob(selection, { runStart, metadata, item, inventory, git });
  return { claimCreatedAt: Date.parse(claim.createdAt), jobWorktrees: inventory.map((entry) => entry.path) };
}

const WHOLE_JOB_PROMPT = 'Continue this exact pre-approved Codex job.';
const WHOLE_JOB_FIELDS = ['version', 'card', 'intentPath', 'owner', 'grant', 'stopped', 'parkedFiles', 'delivery'];
const localResource = (label) => /^local:[a-z0-9_][a-z0-9_./:-]*$/.test(label) && !label.includes('://');
const claimComments = (metadata) => metadata.issue.comments.nodes.filter(({ body }) => body.trimStart().startsWith('Claim:'));
const jobSelection = (descriptor) => Object.fromEntries(SELECTION_FIELDS.map((field) => [field, descriptor[field]]));
const firstLine = (body) => body.trimStart().split(/[\r\n]/, 1)[0].trimEnd();
const heldJobComment = (body, card, prefix) => firstLine(body).startsWith(prefix)
  && new RegExp(`Job: job/${card} on \\S+\\.$`).test(firstLine(body));

function wholeRecords(store) {
  const records = store.records();
  const owners = [];
  for (const [card, record] of records) {
    admissionFields(record, WHOLE_JOB_FIELDS, `whole-job store record for card ${card}`);
    admissionPath(record.intentPath, 'whole-job intent');
    if (record.owner !== null) {
      validateSelection(record.owner, record.owner.runStart);
      owners.push(record.owner);
    }
    const normalizedFiles = (files) => Array.isArray(files) && new Set(files).size === files.length
      && files.every((path) => admissionFootprint(path) === path);
    if (record.version !== 1 || record.card !== card || (record.owner && record.owner.card !== card)
      || typeof record.delivery !== 'boolean' || (record.delivery && !record.grant)
      || (record.stopped !== null && (!record.owner || record.grant)) || !normalizedFiles(record.parkedFiles)
      || (record.parkedFiles.length && (!record.owner || record.grant))) {
      throw new Error(`whole-job store record for card ${card} has an inconsistent state`);
    }
    if (record.grant !== null) {
      admissionFields(record.grant, ['reference', 'files', 'resources'], 'whole-job grant');
      const { reference, files, resources } = record.grant;
      admissionFields(reference, PREPARED_REFERENCE_FIELDS, 'whole-job grant reference');
      if (!record.owner || !normalizedFiles(files) || !Array.isArray(resources) || new Set(resources).size !== resources.length
        || !resources.every((label) => typeof label === 'string' && localResource(label))) {
        throw new Error(`whole-job store record for card ${card} has an invalid grant`);
      }
    }
  }
  if ([...records.values()].filter((record) => record.delivery).length > 1
    || new Set([...records.values()].map((record) => record.intentPath)).size !== records.size
    || new Set(owners.map(({ claimUrl }) => claimUrl)).size !== owners.length
    || new Set(owners.map(({ worktree }) => worktree.normalize('NFC').toLowerCase())).size !== owners.length) {
    throw new Error('whole-job store has duplicate authority');
  }
  return records;
}

function wholeFacts(exec, git, cards) {
  if (boardConfig.TRACKER && boardConfig.TRACKER !== 'github') throw new Error('pre-approved admission requires GitHub issue ownership');
  const repository = admissionRepository(exec, git);
  const board = fetchBoard(exec);
  if (board.some(isContentUnresolved)) throw new Error('whole-job board inventory has unresolved content');
  const open = board.filter((item) => item.content.__typename === 'Issue' && item.content.state === 'OPEN'
    && !boardConfig.TERMINAL_STATUSES.includes(item.status));
  const details = fetchCardDetails(exec, open.map((item) => item.content.number));
  const approvals = new Map([...new Set(cards(open))].map((card) => {
    try { return [card, readApproval(card, { exec, repository })]; }
    catch (error) { return [card, error]; }
  }));
  return { board, details, approvals, repository };
}

function wholeInventory(facts, records, git) {
  const closing = new Map([...records].filter(([, record]) => record.delivery));
  return readRunInventory(undefined, git, undefined, closing, facts.board, facts.details);
}

function wholeOwner(attempt, owner, facts, inventory, git) {
  const { card, runStart, base, priorClaimUrls } = attempt.intent;
  const metadata = facts.approvals.get(card);
  if (metadata instanceof Error) throw metadata;
  const item = inventory.byCard.get(card);
  const branch = `job/${card}`;
  const entries = inventory.worktrees.filter((entry) => entry.branch === branch);
  const [claim, successor] = claimComments(metadata).filter(({ url }) => !priorClaimUrls.includes(url));
  if (successor) throw new Error(`card ${card} has a successor claim after the registered attempt`);
  if (!claim || Date.parse(claim.createdAt) < Date.parse(runStart) || entries.length !== 1) {
    throw new Error(`card ${card} lacks a matching authenticated first claim and worktree`);
  }
  const selection = { card, runStart, base, priorClaimUrls, claimUrl: claim.url, branch, worktree: realpathSync(entries[0].path) };
  validateSelection(selection, runStart);
  if (owner && !isDeepStrictEqual(selection, owner)) throw new Error(`card ${card} ownership differs from the registered attempt`);
  verifyClaimedJob(selection, { runStart, metadata, item, inventory: inventory.worktrees, git });
  return selection;
}

function wholeDelta(owner, git, mainTip) {
  return [...new Set(readActualPaths(owner, git, mainTip).map((path) => admissionFootprint(path, owner.worktree, owner.card)))].sort();
}

function wholeAttempt(record, store) {
  const attempt = store.attempt(record.intentPath);
  if (attempt.intent.card !== record.card) throw new Error(`card ${record.card} launch intent has a mismatched card`);
  return attempt;
}

function wholeCaller(records, store, reference, descriptor, identity) {
  const record = records.get(descriptor?.card);
  if (!record || record.stopped !== null || !identity.invocationId || !identity.cgroup) throw new Error('caller native identity has no active registered attempt');
  const attempt = wholeAttempt(record, store);
  const start = attempt.start();
  if (!start || start.invocationId !== identity.invocationId || start.cgroup !== identity.cgroup || attempt.stop()) {
    throw new Error('caller native identity differs from the registered worker');
  }
  if (reference.descriptorPath !== join(attempt.folder, `job-${record.card}.prepared.json`)
    || realpathSync(identity.cwd) !== descriptor.worktree || !isDeepStrictEqual(jobSelection(descriptor), {
      ...jobSelection(descriptor), card: record.card, runStart: attempt.intent.runStart, base: attempt.intent.base, priorClaimUrls: attempt.intent.priorClaimUrls,
    })) throw new Error(`card ${record.card} reviewed evidence differs from the registered launch and checkout`);
  if (readText(join(attempt.folder, 'run-end.txt'))) throw new Error('the launch coordinator stopped granting new authority');
  const missing = missingRefusal(readText(join(attempt.folder, `job-${record.card}.stderr.log`)), PRE_APPROVED_WITNESS);
  if (missing) throw new Error(`card ${record.card} has no verified ${missing}; ${GUARD_RECOVERY}`);
  return { record, attempt };
}

function wholePeer(record, facts, inventory, store, git, mainTip) {
  const { card, grant, stopped } = record;
  try {
    const attempt = wholeAttempt(record, store);
    const start = attempt.start();
    const stop = attempt.stop();
    if (!start || (stop && !isDeepStrictEqual(start, stop))) throw new Error('matching native start and stop evidence unavailable');
    if (stopped !== null && !isDeepStrictEqual(stop, stopped)) throw new Error('matching native stop evidence unavailable');
    if (stopped === null && readText(join(attempt.folder, 'run-end.txt'))) throw new Error('the launch coordinator stopped without settling this job');
    const closing = record.delivery && grant && (inventory.byCard.get(card)?.content.state !== 'OPEN'
      || !inventory.worktrees.some((entry) => entry.branch === `job/${card}` && entry.key));
    const owner = closing ? record.owner : wholeOwner(attempt, record.owner, facts, inventory, git);
    if (grant) {
      // Closeout can remove the original checkout evidence while the grant still binds.
      const prepared = closing ? readPreparedReference(grant.reference, attempt.intent.runStart)
        : readPreparedJob(grant.reference, attempt.intent.runStart);
      const files = prepared.files ?? prepared.descriptor.plannedFiles.map((path) => admissionFootprint(path));
      if (!isDeepStrictEqual(jobSelection(prepared.descriptor), owner) || !isDeepStrictEqual(prepared.resources, grant.resources)
        || !isDeepStrictEqual(files, grant.files)) throw new Error('reviewed evidence differs from the held grant');
      if (!closing) {
        const outside = wholeDelta(owner, git, mainTip).find((path) => !files.some((planned) => path === planned || path.startsWith(planned + '/')));
        if (outside) throw new Error(`changed ${outside} outside its reviewed footprint`);
      }
      return { ...prepared, ...grant, live: true };
    }
    if (!isDeepStrictEqual(wholeDelta(owner, git, mainTip), record.parkedFiles)) throw new Error('actual paths differ from the reserved parked paths');
    if (stop && stopped === null) throw new Error('native stop has not settled');
    return { descriptor: { card, scopeComplete: true }, files: record.parkedFiles, resources: [], live: false };
  } catch (error) {
    return { unknown: `current job ${card} is an unknown writer: ${error.message}; admission waits` };
  }
}

export async function admitWholeJob(phase, requestPath, { identity, store, output, exec, git }) {
  const reference = admissionJson(requestPath, 'whole-job admission request').value;
  admissionFields(reference, PREPARED_REFERENCE_FIELDS, 'whole-job admission request');
  const descriptor = admissionJson(reference.descriptorPath, 'prepared descriptor').value;
  let revision = 0;
  let wake;
  let watchError;
  const changed = () => { revision += 1; wake?.(); };
  let watcher;
  try {
    watcher = store.watch(changed);
    watcher.on('error', (error) => { watchError = error; changed(); });
  } catch (error) { watchError = error; }
  let reported = false;
  try {
    while (true) {
      const before = revision;
      const snapshot = await store.locked(() => {
        const records = wholeRecords(store);
        wholeCaller(records, store, reference, descriptor, identity);
        return records;
      });
      const facts = wholeFacts(exec, git, () => snapshot.keys());
      const prepared = readPreparedReference(reference, descriptor.runStart);
      const prerequisites = prerequisiteReasons(prepared, new Map(facts.board.map((item) => [item.content.number, item])), facts.repository.nameWithOwner, exec).reasons;
      const answer = await store.locked(() => {
        const records = wholeRecords(store);
        if (!isDeepStrictEqual(snapshot, records)) return undefined;
        const { record, attempt } = wholeCaller(records, store, reference, descriptor, identity);
        requirePreApprovedRun({ git });
        const inventory = wholeInventory(facts, records, git);
        const mainTip = readMainTip(git);
        const candidate = hydratePreparedJob(readPreparedReference(reference, attempt.intent.runStart));
        const owner = wholeOwner(attempt, jobSelection(candidate.descriptor), facts, inventory, git);
        if (record.owner && !isDeepStrictEqual(owner, record.owner)) throw new Error(`card ${record.card} claim changed since registration`);
        const actual = wholeDelta(owner, git, mainTip);
        const grant = { reference, files: candidate.files, resources: candidate.resources };
        if ((record.grant && !isDeepStrictEqual(record.grant, grant)) || (phase === 'deliver' && !record.grant)) {
          throw new Error(`card ${record.card} has no matching reviewed build grant`);
        }
        if (!record.grant && !isDeepStrictEqual(actual, record.parkedFiles)) throw new Error(`card ${record.card} actual paths changed before build admission`);
        const reasons = [...prerequisites, ...candidate.resources.filter((label) => !localResource(label))
          .map((label) => `card ${record.card} resource ${label} has no verified host-local isolation`)];
        for (const path of actual) {
          if (!candidate.files.some((planned) => path === planned || path.startsWith(planned + '/'))) reasons.push(`card ${record.card} changed ${path} outside its reviewed footprint`);
        }
        const live = [];
        const peers = new Set([...inventory.currentCards, ...[...records.values()].filter((entry) => entry.grant).map(({ card }) => card)]);
        peers.delete(record.card);
        for (const card of peers) {
          const peer = records.get(card);
          if (!peer) {
            reasons.push(`current job ${card} is an unknown writer with no registered reservation; admission waits`);
            continue;
          }
          const held = wholePeer(peer, facts, inventory, store, git, mainTip);
          if (held.unknown) {
            reasons.push(held.unknown);
            continue;
          }
          // A verified prebuild or stopped peer with no paths holds no scope.
          if (held.live || held.files.length) (held.live ? live : reasons).push(...conflictReasons(candidate, held));
          if (phase === 'deliver' && peer.delivery) live.push(`card ${record.card} waits for card ${card} delivery lane`);
        }
        if (phase === 'deliver' && mainTip !== owner.base) {
          const paths = readPathList(git(['diff', '--name-only', '--no-renames', '-z', owner.base, mainTip]), record.card);
          const main = { descriptor: { card: 'origin/main', scopeComplete: true }, resources: [], files: paths.map((path) => admissionFootprint(path)) };
          reasons.push(...conflictReasons({ ...candidate, descriptor: { ...candidate.descriptor, scopeComplete: true } }, main));
        }
        if (reasons.length) return { decision: 'wait', reasons: [...new Set([...reasons, ...live])] };
        if (live.length) return { waiting: [...new Set(live)] };
        if (!record.grant || (phase === 'deliver' && !record.delivery)) store.write(record.card, { ...record, owner, grant,
          parkedFiles: [], delivery: phase === 'deliver' });
        return { decision: 'allow', reasons: [] };
      });
      if (!answer) continue;
      if (!answer.waiting) return answer;
      if (watchError) return { decision: 'wait', reasons: [...answer.waiting, `whole-job authority watch unavailable: ${watchError.message}`] };
      if (!reported) {
        output.error(answer.waiting.join('\n'));
        reported = true;
      }
      if (revision === before) await new Promise((resolve) => { wake = resolve; });
      wake = undefined;
    }
  } finally { watcher?.close(); }
}

async function runPreApprovedSession({ folder, root, startSession }, name, prompt, intentPath) {
  const logs = join(folder, name);
  let result;
  try {
    result = await startSession({ argv: sessionArgv(`${logs}.txt`, prompt), root, logs, ...(intentPath && { intentPath }) });
  } catch (error) {
    result = { spawnError: error.message };
  }
  return { ...result, message: readText(`${logs}.txt`), missing: missingRefusal(readText(`${logs}.stderr.log`), PRE_APPROVED_WITNESS) };
}

function writePreApprovedOutcome(folder, name, runStart, card, claimUrl, phase, disposition, reason) {
  const record = { runStart, card, claimUrl, phase, disposition, reason };
  writeFileSync(join(folder, `${name}.outcome.json`), JSON.stringify(record) + '\n', { flag: 'wx' });
}

function preApprovedEndFailure(end) {
  return failure(end) ?? (end.missing && `it did not show the ${end.missing} in its runtime log; ${GUARD_RECOVERY}`)
    ?? (end.message.trim() ? undefined : 'it left a blank message');
}

function wholeCandidates(facts, runStart, diagnostics) {
  const candidates = [];
  for (const item of pickable(facts.board)) {
    const card = normalizeItem(item);
    if (card.state !== 'OPEN' || !cardNumber(card.number) || isEpic(card) || card.assignees.length || card.openBlockers.length
      || card.closingPullRequests.length || facts.details.get(card.number)?.comments?.some((body) => firstLine(body).startsWith('Needs owner:'))) continue;
    const metadata = facts.approvals.get(card.number);
    if (metadata instanceof Error) {
      diagnostics.add(`Card ${card.number} approval unavailable: ${metadata.message}`);
      continue;
    }
    const approval = judgeApproval(card.number, metadata, { before: runStart, run: true });
    if (!approval.startsWith('approved ')) {
      diagnostics.add(approval);
      continue;
    }
    candidates.push({ card: card.number, approvedAt: Date.parse(approval.split(' ')[2]), priorClaimUrls: claimComments(metadata).map(({ url }) => url) });
  }
  return candidates.sort((a, b) => a.approvedAt - b.approvedAt || a.card - b.card);
}

function wholeReturn(card, record, facts, inventory, store, git, mainTip) {
  if (!record?.stopped || !record.owner || record.grant || record.delivery) throw new Error(`card ${card} has no verified stopped managed job to return`);
  const attempt = wholeAttempt(record, store);
  const peer = wholePeer(record, facts, inventory, store, git, mainTip);
  if (peer.unknown) throw new Error(peer.unknown);
  const { folder, intent } = attempt;
  const { value: prior } = admissionJson(join(folder, `job-${card}.outcome.json`), `card ${card} prior settled outcome`);
  admissionFields(prior, ['runStart', 'card', 'claimUrl', 'phase', 'disposition', 'reason'], 'prior settled outcome');
  if (prior.card !== card || prior.runStart !== intent.runStart || prior.claimUrl !== record.owner.claimUrl
    || prior.phase !== 'job' || !['parked', 'stopped'].includes(prior.disposition) || typeof prior.reason !== 'string' || !prior.reason.trim()) {
    throw new Error(`card ${card} has no matching prior settled outcome`);
  }
  const metadata = facts.approvals.get(card);
  const returned = metadata.issue.comments.nodes.some((comment) => comment.author?.login === metadata.login && heldJobComment(comment.body, card, 'Returned:'));
  if (!returned || metadata.issue.comments.nodes.some(({ body }) => firstLine(body).startsWith('Needs owner:'))) {
    throw new Error(`card ${card} has no authenticated owner return for its exact job`);
  }
  return { card, priorClaimUrls: intent.priorClaimUrls, base: intent.base, runStart: intent.runStart };
}

function settleWholeRecord(card, intentPath, disposition, result, { facts, store, git }) {
  const records = wholeRecords(store);
  const record = records.get(card);
  if (record?.intentPath !== intentPath || record.stopped !== null) throw new Error(`card ${card} launch registration changed before settlement`);
  const attempt = wholeAttempt(record, store);
  const { managedStop } = result;
  const start = attempt.start();
  const stop = attempt.stop();
  if (managedStop?.disposition !== 'verified-local' || managedStop.intentPath !== intentPath || !start
    || !isDeepStrictEqual(start, stop) || !isDeepStrictEqual(stop, managedStop.proof)) throw new Error('managed local stop proof is unavailable');
  const item = facts.board.find((entry) => entry.content.__typename === 'Issue' && entry.content.number === card);
  const inventory = wholeInventory(facts, records, git);
  const entries = inventory.worktrees.filter((entry) => entry.branch === `job/${card}`);
  const metadata = facts.approvals.get(card);
  if (metadata instanceof Error) throw metadata;
  const newClaims = claimComments(metadata).filter(({ url }) => !attempt.intent.priorClaimUrls.includes(url));
  if (disposition === 'merged') {
    if (!record.delivery || !record.owner || metadata.issue.state !== 'CLOSED' || item?.content.state !== 'CLOSED'
      || !boardConfig.TERMINAL_STATUSES.includes(item.status) || entries.length || readJobRoot({ descriptor: record.owner }) !== undefined
      || newClaims[0]?.url !== record.owner.claimUrl || newClaims[0]?.author?.login !== metadata.login) {
      throw new Error(`card ${card} merge and exact worktree closeout are not confirmed`);
    }
    store.remove(card);
    return record.owner;
  }
  if (disposition === 'stopped' && !record.owner && !newClaims.length && !entries.length && !inventory.currentCards.has(card)) {
    store.remove(card);
    return null;
  }
  const owner = wholeOwner(attempt, record.owner, facts, inventory, git);
  if (disposition === 'awaiting-push' && (!record.grant || item.status !== 'Awaiting push')) throw new Error(`card ${card} owner-waiting state is not confirmed`);
  if (disposition === 'parked' && (item.status !== 'Backlog' || !metadata.issue.comments.nodes.some((comment) =>
    comment.author?.login === metadata.login && heldJobComment(comment.body, card, 'Needs owner:')))) {
    throw new Error(`card ${card} parked ownership is not confirmed`);
  }
  const parkedFiles = wholeDelta(owner, git, readMainTip(git));
  store.write(card, { ...record, owner, stopped: stop, grant: null, parkedFiles, delivery: false });
  return owner;
}

export async function runWholeJobs({ startSession, notify, root, folder, output, runStart, continueCard, store, exec, git, createIntent }) {
  const pending = new Set();
  const launched = new Set();
  const diagnostics = new Set();
  let safetyStop = false;
  let workflowStop = false;
  const saveDiagnostic = () => writeFileSync(join(folder, 'run-end.txt'), `${[...diagnostics].join('\n')}\n`);
  const stop = (reason) => {
    safetyStop = true;
    diagnostics.add(reason);
    output.error(`${reason}. Results: ${folder}`);
    try { saveDiagnostic(); }
    catch (error) { output.error(`Run diagnostic unavailable: ${error.message}. Results: ${folder}`); }
  };
  const session = (name, prompt, intentPath) => runPreApprovedSession({ folder, root, startSession }, name, prompt, intentPath);
  async function outcome(name, cutoff, card, claimUrl, phase, disposition, reason, queue = true) {
    let written = false;
    try {
      writePreApprovedOutcome(folder, name, cutoff, card, claimUrl, phase, disposition, reason);
      written = true;
    } catch (error) { stop(`Incomplete outcome evidence for ${name}: ${error.message}`); }
    try { if (queue || !written) await notify?.({ folder, name }); }
    catch (error) { stop(`Owner attention for ${name} could not be queued: ${error.message}`); return false; }
    return written;
  }
  async function runJob({ card, base, intentPath, cutoff, priorOwner }) {
    const name = `job-${card}`;
    let owner = priorOwner;
    let disposition = 'failed';
    let reason;
    try {
      const context = { card, runStart: cutoff, base, results: folder, mode: continueCard === card ? 'resume' : 'start' };
      const result = await session(name, `${WHOLE_JOB_PROMPT}\n${JSON.stringify(context)}`, intentPath);
      if (result.interrupted) {
        disposition = 'interrupted';
        reason = cancellationMessage(result, `Card ${card}`, '', result.missing ? `guard refusal was not verified; ${GUARD_RECOVERY}` : '');
        stop(reason);
      } else {
        const unavailable = failure(result) ?? (result.missing && `missing ${result.missing}; ${GUARD_RECOVERY}`);
        if (unavailable) throw new Error(unavailable);
        const line = result.message.trimEnd().split(/\r?\n/).at(-1);
        const complete = new RegExp(`^Run result: (merged|built) ${card}$`).exec(line)?.[1];
        const paused = new RegExp(`^Run result: (parked|stop) ${card}: \\S.*$`).exec(line)?.[1];
        const reported = complete ?? paused;
        if (!reported) throw new Error('worker ended without its exact job result');
        const settled = { merged: 'merged', built: 'awaiting-push', parked: 'parked', stop: 'stopped' }[reported];
        const facts = wholeFacts(exec, git, () => [card]);
        owner = await store.locked(() => settleWholeRecord(card, intentPath, settled, result, { facts, store, git }));
        disposition = settled;
        reason = paused ? line : `Card ${card}: ${disposition}`;
        if (disposition === 'stopped') workflowStop = true;
        diagnostics.add(reason);
      }
    } catch (error) {
      reason = `Card ${card} unavailable: ${error.message}`;
      stop(reason);
    }
    await outcome(name, cutoff, card, owner?.claimUrl ?? null, 'job', disposition, reason);
  }
  try {
    if (!runTime(runStart)) throw new Error('pre-approved run requires a valid runStart');
    let exactPending = continueCard !== undefined;
    while (!safetyStop && !workflowStop) {
      if (continueCard === undefined || exactPending) {
        const facts = wholeFacts(exec, git, (open) => exactPending ? [continueCard] : pickable(open).map((item) => item.content.number));
        const candidates = exactPending ? [{ card: continueCard }] : wholeCandidates(facts, runStart, diagnostics);
        for (const candidate of candidates) {
          if (safetyStop || workflowStop) break;
          if (launched.has(candidate.card)) continue;
          const launch = await store.locked(() => {
            const records = wholeRecords(store);
            const inventory = wholeInventory(facts, records, git);
            verifyEvidenceDirectory(folder, inventory.worktrees.map(({ path }) => path));
            requirePreApprovedRun({ git });
            const mainTip = readMainTip(git);
            const { card } = candidate;
            const old = records.get(card);
            if (!exactPending && (old || inventory.currentCards.has(card))) return undefined;
            const returned = exactPending ? wholeReturn(card, old, facts, inventory, store, git, mainTip) : undefined;
            const base = returned?.base ?? mainTip;
            const cutoff = returned?.runStart ?? runStart;
            const priorClaimUrls = returned?.priorClaimUrls ?? candidate.priorClaimUrls;
            const intentPath = createIntent({ card, base, priorClaimUrls }, cutoff);
            const record = { version: 1, card, intentPath, owner: old?.owner ?? null, grant: null,
              stopped: null, parkedFiles: old?.parkedFiles ?? [], delivery: false };
            store.write(card, record);
            return { card, base, cutoff, intentPath, priorOwner: record.owner };
          });
          if (!launch) continue;
          launched.add(launch.card);
          const work = runJob(launch);
          pending.add(work);
          work.then(() => pending.delete(work), () => pending.delete(work));
        }
        exactPending = false;
      }
      if (!pending.size) break;
      await Promise.race(pending);
    }
  } catch (error) { stop(`Whole-job coordination unavailable: ${error.message}`); }
  await Promise.all(pending);
  saveDiagnostic();
  if (safetyStop) return 1;
  const end = await session('end', KINDS['pre-approved'].endPrefix + folder);
  const endFailure = end.interrupted ? cancellationReason(end, 'end', join(folder, 'end.card'), end.missing ? 'guard refusal was not verified' : '')
    : preApprovedEndFailure(end);
  if (endFailure) {
    stop(`The end session did not deliver its summary: ${endFailure}`);
    await outcome('end', runStart, null, null, 'end', end.interrupted ? 'interrupted' : 'failed', endFailure);
    return 1;
  }
  if (!await outcome('end', runStart, null, null, 'end', 'summarized', 'The end session delivered a validated run summary', false)) return 1;
  output.log(end.message.trimEnd());
  return 0;
}

async function runPreApproved({ startSession, notify, root, folder, output, runStart, exec, git, inspect }) {
  const reservations = new Map();
  const pending = new Set();
  const settled = new Set();
  const diagnostics = [];
  let safetyStop = false;
  let workflowStopReason;
  let exhausted = false;
  let selecting = 0;
  let delivering = false;
  const stop = (reason) => {
    safetyStop = true;
    diagnostics.push(reason);
    output.error(`${reason}. Results: ${folder}`);
  };
  const saveDiagnostic = () => writeFileSync(join(folder, 'run-end.txt'),
    `${diagnostics.join('\n')}\nRetained reservations: ${[...reservations.keys()].sort((a, b) => a - b).join(',') || 'none'}\n`);
  async function attention(name) {
    try {
      await notify?.({ folder, name });
      return true;
    } catch (error) {
      stop(`Owner attention for ${name} could not be queued: ${error.message ?? String(error)}`);
      return false;
    }
  }
  async function outcome(name, phase, job, disposition, reason, queue = true) {
    let recorded = false;
    try {
      if (settled.has(name)) throw new Error(`phase ${name} already settled`);
      settled.add(name);
      writePreApprovedOutcome(folder, name, runStart, job?.selection.card ?? null, job?.selection.claimUrl ?? null, phase, disposition, reason);
      recorded = true;
    } catch (error) {
      stop(`Incomplete outcome evidence for ${name}: ${error.message}`);
    }
    const queued = queue || !recorded ? await attention(name) : true;
    return recorded && queued;
  }
  const session = (name, prompt) => runPreApprovedSession({ folder, root, startSession }, name, prompt);
  function selected(name, message) {
    const selection = admissionJson(join(folder, `${name}.selected.json`), 'selected job').value;
    validateSelection(selection, runStart);
    if (message.trimEnd().split(/\r?\n/).at(-1) !== `Run result: selected ${selection.card}` || reservations.has(selection.card)) throw new Error('selected job has an invalid or repeated identity');
    const { claimCreatedAt } = verifyClaimContext(selection, { runStart, exec, git });
    const worktreeKey = canonicalWorktreeKey(selection.worktree);
    return { selection, claimCreatedAt, worktreeKey, state: 'selected', phase: 'prepare', notifying: false };
  }
  function prepareReference(job) {
    const descriptorPath = join(folder, `job-${job.selection.card}.prepared.json`);
    const reviewRecordPath = join(folder, `job-${job.selection.card}.reviewed.json`);
    const descriptor = admissionJson(descriptorPath, 'prepared descriptor');
    const record = admissionJson(reviewRecordPath, 'accepted review record').value;
    for (const field of SELECTION_FIELDS) {
      if (JSON.stringify(descriptor.value[field]) !== JSON.stringify(job.selection[field])) throw new Error(`prepared ${field} differs from selected card ${job.selection.card}`);
    }
    if (record.descriptorHash !== sha256(descriptor.bytes) || !HASH.test(record.planHash)) throw new Error(`prepared review hashes are unavailable for card ${job.selection.card}`);
    job.reference = { descriptorPath, descriptorHash: record.descriptorHash, planHash: record.planHash, reviewRecordPath };
  }
  function closingProbe() {
    if (![...reservations.values()].some((job) => job.state === 'deliver')) return undefined;
    const jobs = [...reservations.values()].filter((job) => job.reference !== undefined)
      .map((job) => readPreparedReference({ ...job.reference, phase: job.phase }, runStart, true));
    validateJobIdentities(jobs);
    const repository = admissionRepository(exec, git);
    const readers = { exec, git, repository, mainTip: readMainTip(git) };
    const facts = readClosingJobs(jobs, runStart, readers);
    // Ordinary OPEN delivery is not an admission attempt; closing waits still validate every other job.
    if (!facts.closing.size) return undefined;
    return verifyRunJobs(jobs, runStart, readers, undefined, facts);
  }
  function admission(job, phaseName) {
    const others = [...reservations.values()].filter((entry) => entry !== job);
    const unknown = others.filter((entry) => entry.reference === undefined);
    const answer = inspect({ runStart, phase: phaseName, candidate: job.reference,
      reservations: others.filter((entry) => entry.reference !== undefined).map((entry) => ({ ...entry.reference, phase: entry.phase })) }, { root, exec, git });
    if (answer.decision === 'unavailable') stop(answer.reasons.join('; '));
    else {
      for (const reason of [...answer.reasons, ...unknown.map((entry) => `current job ${entry.selection.card} has no accepted prepared descriptor or complete footprint; admission waits`)]) {
        if (!diagnostics.includes(reason)) diagnostics.push(reason);
      }
    }
    return answer.decision === 'allow' && unknown.length === 0;
  }
  function verifyDelivery(job, disposition) {
    const item = fetchBoard(exec).find((entry) => entry.content.__typename === 'Issue' && entry.content.number === job.selection.card);
    if (disposition === 'merged') {
      if (item?.content.state !== 'CLOSED' || !boardConfig.TERMINAL_STATUSES.includes(item.status)
        || readWorktreeInventory(git).some((entry) => entry.key === job.worktreeKey)) {
        throw new Error(`card ${job.selection.card} merge and closeout are not confirmed`);
      }
    } else if (item?.content.state !== 'OPEN' || item.status !== 'Awaiting push') throw new Error(`card ${job.selection.card} owner-waiting state is not confirmed`);
  }
  async function phase(job, phaseName) {
    const card = job.selection.card;
    const name = `job-${card}-${phaseName}`;
    job.state = phaseName;
    let disposition = 'failed';
    let reason;
    try {
      const verified = verifyClaimContext(job.selection, { runStart, exec, git });
      if (verified.claimCreatedAt !== job.claimCreatedAt) throw new Error(`initial claim timestamp changed for card ${card}`);
      const context = { phase: phaseName, ...job.selection, ...(phaseName === 'prepare' ? {} : job.reference) };
      retainPreparedContext(context, join(folder, name), verified.jobWorktrees);
      job.phase = phaseName;
      const result = await session(name, `${PHASE_PROMPTS[phaseName]}\n${JSON.stringify(context)}`);
      if (result.interrupted) {
        disposition = 'interrupted';
        reason = cancellationMessage(result, `Card ${card} ${phaseName}`, '', result.missing ? `guard refusal was not verified; ${GUARD_RECOVERY}` : '');
        stop(reason);
      } else if (!result.spawnError && result.missing) {
        reason = `Card ${card} ${phaseName} did not show the ${result.missing} in its runtime log; ${GUARD_RECOVERY}`;
        stop(reason);
      } else if (failure(result)) reason = `Card ${card} ${phaseName} ${failure(result)}`;
      else {
        const line = result.message.trimEnd().split(/\r?\n/).at(-1);
        const match = /^Run result: (prepared|built|merged|parked|stop) ([1-9]\d*)(?:: \S.*)?$/.exec(line);
        const allowed = phaseName === 'prepare' ? ['prepared', 'parked', 'stop'] : phaseName === 'build' ? ['built', 'parked', 'stop'] : ['merged', 'built', 'parked', 'stop'];
        if (!match || Number(match[2]) !== card || !allowed.includes(match[1])) throw new Error(`Card ${card} ${phaseName} ended without its exact phase result`);
        disposition = match[1] === 'stop' ? 'stopped' : match[1] === 'built' && phaseName === 'deliver' ? 'awaiting-push' : match[1];
        if (phaseName === 'prepare' && disposition === 'prepared') prepareReference(job);
        if (phaseName === 'deliver' && ['merged', 'awaiting-push'].includes(disposition)) verifyDelivery(job, disposition);
        if (disposition === 'stopped') {
          reason = line;
          workflowStopReason ??= reason;
          diagnostics.push(reason);
        } else reason = `Card ${card} ${phaseName}: ${disposition}`;
      }
    } catch (error) {
      reason = `Card ${card} ${phaseName} unavailable: ${error.message}`;
      disposition = 'failed';
      stop(reason);
    }
    job.state = disposition;
    job.notifying = true;
    const accounted = await outcome(name, phaseName, job, disposition, reason);
    if (disposition === 'merged' && accounted) reservations.delete(card);
    if (phaseName === 'deliver') delivering = false;
    job.notifying = false;
  }
  function launch(job, phaseName) {
    if (phaseName === 'deliver') delivering = true;
    const work = phase(job, phaseName).catch((error) => stop(`Phase evidence unavailable: ${error.message}`));
    pending.add(work);
    work.finally(() => pending.delete(work));
  }
  let initialRecords;
  try {
    if (!runTime(runStart) || typeof exec !== 'function' || typeof git !== 'function') throw new Error('pre-approved run requires authoritative readers and a valid runStart');
    initialRecords = readWorktreeRecords(git);
    verifyEvidenceDirectory(folder, initialRecords.map((entry) => entry.path));
  } catch (error) {
    output.error(`Pre-approved evidence location unavailable: ${error.message}`);
    return 1;
  }
  try {
    while (!safetyStop && !workflowStopReason) {
      if ([...reservations.values()].some((job) => job.notifying)) {
        await Promise.race(pending);
        continue;
      }
      if (closingProbe()?.closing.size) {
        await Promise.race(pending);
        continue;
      }
      let progressed = false;
      let closing = false;
      let resumed = false;
      for (const job of reservations.values()) {
        if (job.notifying) continue;
        if (job.state === 'selected') {
          if (closingProbe()?.closing.size) {
            closing = true;
            break;
          }
          await phase(job, 'prepare');
          resumed = true;
          break;
        }
        if (job.state === 'built' && !delivering && admission(job, 'deliver')) {
          launch(job, 'deliver');
          progressed = true;
          if (closingProbe()?.closing.size) {
            closing = true;
            break;
          }
        } else if (job.state === 'prepared' && admission(job, 'build')) {
          launch(job, 'build');
          progressed = true;
        }
        if (safetyStop || workflowStopReason) break;
      }
      if (safetyStop || workflowStopReason) break;
      if (resumed) continue;
      if (closing) {
        await Promise.race(pending);
        continue;
      }
      if (!exhausted) {
        const records = initialRecords;
        initialRecords = undefined;
        try {
          const probe = closingProbe();
          if (probe?.closing.size) {
            await Promise.race(pending);
            continue;
          }
          readRunInventory(exec, git, records);
        } catch (error) {
          const reason = `Selection was not started: current job inventory unavailable: ${error.message}`;
          stop(reason);
          await outcome(`select-${++selecting}`, 'select', null, 'failed', reason);
          break;
        }
        const name = `select-${++selecting}`;
        const result = await session(name, `${PHASE_PROMPTS.select}\n${JSON.stringify({ runStart })}`);
        let job;
        let disposition = 'failed';
        let reason;
        try {
          if (result.interrupted) {
            disposition = 'interrupted';
            reason = cancellationReason(result, name, join(folder, `${name}.card`), result.missing ? `guard refusal was not verified; ${GUARD_RECOVERY}` : '');
            stop(reason);
          } else if (failure(result) || result.missing) throw new Error(failure(result) ?? `missing ${result.missing}; ${GUARD_RECOVERY}`);
          else if (/^Run result: stop none: \S.*$/.test(result.message.trimEnd().split(/\r?\n/).at(-1))) {
            exhausted = true;
            disposition = 'stopped';
            reason = 'Selection found no further eligible pre-approved job';
          } else {
            job = selected(name, result.message);
            reservations.set(job.selection.card, job);
            disposition = 'selected';
            reason = `Selected card ${job.selection.card} with verified claim ownership`;
          }
        } catch (error) {
          reason = `Selection unavailable: ${error.message}`;
          stop(reason);
        }
        await outcome(name, 'select', job, disposition, reason);
        if (job && !safetyStop && !workflowStopReason && !closingProbe()?.closing.size) await phase(job, 'prepare');
        continue;
      }
      if (progressed) continue;
      if (!pending.size) break;
      await Promise.race(pending);
    }
  } catch (error) {
    stop(`Pre-approved coordination unavailable: ${error.message}`);
  }
  await Promise.all(pending);
  saveDiagnostic();
  if (safetyStop) return 1;
  const end = await session('end', KINDS['pre-approved'].endPrefix + folder);
  if (end.interrupted) {
    const reason = cancellationReason(end, 'end', join(folder, 'end.card'), end.missing ? `guard refusal was not verified; ${GUARD_RECOVERY}` : '');
    stop(reason);
    await outcome('end', 'end', null, 'interrupted', reason);
    saveDiagnostic();
    return 1;
  }
  const endFailure = preApprovedEndFailure(end);
  if (endFailure) {
    const reason = `The end session did not deliver its summary: ${endFailure}`;
    output.error(`${reason}. Results: ${folder}`);
    await outcome('end', 'end', null, 'failed', reason);
    return 1;
  }
  if (!await outcome('end', 'end', null, 'summarized', 'The end session delivered a validated run summary', false)) return 1;
  output.log(end.message.trimEnd());
  return 0;
}

export async function runRun({ startSession, notify, root, folder, output, kind = 'product-manager', runStart, exec, git, inspectAdmission: inspect = inspectAdmission }) {
  if (kind === 'pre-approved') return runPreApproved({ startSession, notify, root, folder, output, runStart, exec, git, inspect });
  const { cardPrompt, endPrefix, witness } = KINDS[kind];
  async function runSession(name, prompt) {
    const outputFile = join(folder, `${name}.txt`);
    const logs = join(folder, name);
    const outcome = await startSession({ argv: sessionArgv(outputFile, prompt), root, logs });
    return { ...outcome, message: readText(outputFile), missing: missingRefusal(readText(`${logs}.stderr.log`), witness) };
  }

  async function queueAttention(name) {
    try {
      await notify?.({ folder, name });
      return true;
    } catch (error) {
      const reason = `Owner attention for ${name} could not be queued: ${error.message ?? String(error)}`;
      const endFile = join(folder, 'run-end.txt');
      writeFileSync(endFile, `${readText(endFile)}${reason}\n`);
      output.error(`${reason}. No further session was started. Results: ${folder}`);
      return false;
    }
  }

  async function finishCancellation(session, name) {
    const reason = cancellationReason(session, name, join(folder, `${name}.card`), session.missing ? 'guard refusal was not verified' : '');
    writeFileSync(join(folder, 'run-end.txt'), `${reason}\n`);
    output.error(`${reason}. No further model session was started. Results: ${folder}`);
    await queueAttention(name);
    return 1;
  }

  let ended;
  for (let n = 1; ; n += 1) {
    const session = await runSession(`card-${n}`, cardPrompt);
    if (session.interrupted) return finishCancellation(session, `card-${n}`);
    if (!session.spawnError && session.missing) {
      ended = `Card session ${n} did not show the ${session.missing} in its runtime log`;
      writeFileSync(join(folder, 'run-end.txt'), `${ended}\n`);
      output.error(`${ended}, so the guard may be off and no further session was started. Check it as "Before intake" in the resume skill says. Results: ${folder}`);
      await queueAttention(`card-${n}`);
      return 1;
    }
    const { kind: result, line } = readRunResult(session.message);
    const reason = failure(session)
      ?? (result === 'stop' ? `stopped: ${line}` : result === 'none' ? 'ended without a Run result line' : undefined);
    if (reason) {
      ended = `Card session ${n} ${reason}`;
      writeFileSync(join(folder, 'run-end.txt'), `${ended}\n`);
    }
    if (!await queueAttention(`card-${n}`)) return 1;
    if (reason) break;
    output.log(`Card session ${n} finished: ${result}; the guard refusal was shown`);
  }

  const end = await runSession('end', endPrefix + folder);
  if (end.interrupted) return finishCancellation(end, 'end');
  const endFailure = failure(end)
    ?? (end.missing && `it did not show the ${end.missing} in its runtime log`)
    ?? (end.message.trim() ? undefined : 'it left a blank message');
  if (endFailure) {
    output.error(`The run ended (${ended}) but the end session did not deliver its summary: ${endFailure}. Results: ${folder}`);
    await queueAttention('end');
    return 1;
  }
  output.log(end.message.trimEnd());
  return 0;
}
