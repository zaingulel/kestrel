// Admission and native app phase checks bind a job to its live claim and reviewed identity.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchBoard, fetchCardDetails, normalizeItem } from './board.mjs';
import { isEpic } from './board-rules.mjs';
import { cardIneligibility, COMMIT_TEXT, readCard, readOrigin, originRepository, requireMergeOnEvidence } from './merge-evidence.mjs';
import { parseWorktreeList } from './closeout-cleanup.mjs';
import * as boardConfig from './board-config.mjs';

/** @typedef {NodeJS.ErrnoException & { inventoryCard?: number }} InventoryError */

const [, READY] = boardConfig.PICKABLE_STATUSES;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = new RegExp(`^${COMMIT_TEXT}$`);
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
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') break;
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

export function checkedOriginRepository({ git, exec, changedMessage }) {
  const origin = readOrigin({ git });
  const repository = originRepository({ git, exec, origin });
  if (readOrigin({ git }) !== origin) throw new Error(changedMessage);
  return { origin, repository };
}

function admissionRepository(exec, git) {
  const repositoryName = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;
  const { repository } = checkedOriginRepository({ git, exec, changedMessage: 'admission origin changed during repository preparation' });
  if (repository.nameWithOwner !== repositoryName) throw new Error('origin repository differs from the configured board repository');
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
      if (/** @type {InventoryError} */ (error).code !== 'ENOENT' || !owner) {
        if (/** @type {InventoryError} */ (error).code === 'ENOENT') {
          /** @type {InventoryError} */ (error).inventoryCard = Number(match?.[1]);
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
    if (!cardNumber(card) || !COMMIT.test(entry.head ?? '') || !item
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

// A claimed job needs no approval record: its card open and not a proposal, its claim, worktree, branch and HEAD its own.
function verifyClaimedJob(selection, { metadata, item, inventory, git }) {
  const ineligible = cardIneligibility(metadata.issue);
  if (ineligible) throw new Error(`card ${selection.card} cannot be delivered: ${ineligible}`);
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

// A reserved reference may carry its own job's `runStart`, which then replaces `runStart` for that job's checks.
function readPreparedReference(reference, runStart, reserved = false) {
  const ownStart = reserved && typeof reference === 'object' && reference !== null && Object.hasOwn(reference, 'runStart');
  admissionFields(reference, ['descriptorPath', 'descriptorHash', 'planHash', 'reviewRecordPath', ...(reserved ? ['phase'] : []), ...(ownStart ? ['runStart'] : [])], 'job reference');
  if (ownStart) {
    if (!runTime(reference.runStart)) throw new Error('reservation runStart is unavailable');
    runStart = reference.runStart;
  }
  if (!HASH.test(reference.descriptorHash) || !HASH.test(reference.planHash)) throw new Error('job reference hashes must be lowercase SHA256');
  if (reserved && !['prepare', 'build', 'deliver'].includes(reference.phase)) throw new Error('reservation phase is unavailable');
  const prepared = admissionJson(reference.descriptorPath, 'prepared descriptor');
  const descriptor = prepared.value;
  admissionFields(descriptor, ['runStart', 'card', 'claimUrl', 'priorClaimUrls', 'branch', 'worktree', 'base', 'planPath', 'planHash', 'plannedFiles', 'prerequisites', 'exclusiveResources'], 'prepared descriptor');
  validateSelection(Object.fromEntries(SELECTION_FIELDS.map((field) => [field, descriptor[field]])), runStart);
  if (!Array.isArray(descriptor.plannedFiles)
    || !Array.isArray(descriptor.prerequisites) || !Array.isArray(descriptor.exclusiveResources)) {
    throw new Error('prepared descriptor has invalid scope declarations');
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

function readJobLifecycle(job) {
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
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
    try {
      outcomes[phase] = readPhaseOutcome(selection, directory, phase);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
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
    throw new Error(`origin/main commit is unavailable: ${/** @type {Error} */ (error).message}`);
  }
  if (!COMMIT.test(mainTip)) throw new Error('origin/main did not resolve to a full commit hash');
  return mainTip;
}

function readJobRoot(job) {
  try {
    return realpathSync(job.descriptor.worktree);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
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
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
  }
}

function readClosingJobs(jobs, { exec, repository }) {
  for (const job of jobs) {
    job.lifecycle = readJobLifecycle(job);
    job.inactive = false;
  }
  const board = fetchBoard(exec);
  const byCard = new Map(board.filter((item) => item.content.__typename === 'Issue').map((item) => [item.content.number, item]));
  const approvals = new Map();
  const approval = (card) => {
    if (!approvals.has(card)) approvals.set(card, readCard(card, { exec, repository }));
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
    if (/** @type {NodeJS.ErrnoException & { status?: number | null }} */ (error).status !== 1 && closing && !readJobRoot({ descriptor: { worktree } })) throw error;
    throw new Error(`card ${card} original-base ancestry to origin/main is unavailable: ${/** @type {Error} */ (error).message}`);
  }
  return [
    ['diff', '--name-only', '--no-renames', '-z', `${mainTip}...HEAD`],
    ['diff', '--name-only', '--no-renames', '-z'],
    ['diff', '--name-only', '--no-renames', '-z', '--cached'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ].flatMap((args) => readPathList(readGit(args), card));
}

function verifyRunJobs(jobs, readers, retry, facts) {
  const { exec, git, mainTip } = readers;
  if (retry) for (const job of jobs) Object.assign(job, readPreparedReference(job.reference, job.descriptor.runStart, job.phase !== undefined));
  const { board, closing, approval } = facts ?? readClosingJobs(jobs, readers);
  if (retry && !closing.has(retry.card)) throw retry.error;
  let inventory;
  try {
    inventory = readRunInventory(exec, git, undefined, closing, board);
  } catch (error) {
    const owner = jobs.find((job) => job.phase === 'deliver' && job.descriptor.card === /** @type {InventoryError} */ (error).inventoryCard);
    if (!retry && owner) return verifyRunJobs(jobs, readers, { card: owner.descriptor.card, error });
    throw error;
  }
  for (const job of jobs) {
    if (closing.has(job.descriptor.card)) continue;
    try {
      Object.assign(job, hydratePreparedJob(job));
    } catch (error) {
      // Only this job's original plan/review/root hydration can attribute an ENOENT transition.
      if (!retry && job.phase === 'deliver' && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return verifyRunJobs(jobs, readers, { card: job.descriptor.card, error });
      throw error;
    }
    const metadata = approval(job.descriptor.card);
    let claim;
    let changed;
    try {
      claim = verifyClaimedJob(job.descriptor, { metadata, item: inventory.byCard.get(job.descriptor.card), inventory: inventory.worktrees, git });
      changed = readActualPaths(job.descriptor, git, mainTip, job.phase === 'deliver');
    } catch (error) {
      if (!retry && job.phase === 'deliver' && /** @type {NodeJS.ErrnoException & { status?: number | null }} */ (error).status !== 1
        && (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' || Number.isInteger(/** @type {NodeJS.ErrnoException & { status?: number | null }} */ (error).status)) && readJobRoot(job) === undefined) {
        return verifyRunJobs(jobs, readers, { card: job.descriptor.card, error });
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
    if (/** @type {Record<string, unknown>} */ (boardConfig).TRACKER && /** @type {Record<string, unknown>} */ (boardConfig).TRACKER !== 'github') throw new Error('pre-approved admission requires GitHub issue ownership');
    const candidate = readPreparedReference(request.candidate, request.runStart);
    const reservations = request.reservations.map((reference) => readPreparedReference(reference, request.runStart, true));
    const jobs = [candidate, ...reservations];
    validateJobIdentities(jobs);
    const repositoryName = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;
    const repository = admissionRepository(exec, git);
    const mainTip = readMainTip(git);
    const { inventory: { byCard, currentCards }, closing } = verifyRunJobs(jobs, { exec, git, repository, mainTip });
    const identities = new Map(jobs.map((job) => [job.descriptor.card, job]));
    if (request.phase === 'build' && !candidate.inactive) throw new Error(`card ${candidate.descriptor.card} has no verified inactive prepared state for build`);
    if (request.phase === 'deliver' && (!candidate.lifecycle.contexts.build || candidate.lifecycle.outcomes.build?.disposition !== 'built')) {
      throw new Error(`card ${candidate.descriptor.card} delivery requires matching retained build context and completed built outcome`);
    }
    if (closing.size) return { decision: 'wait', reasons: [...closing.keys()].map((card) => `card ${card} delivery closeout is settling; admission waits`) };
    const reasons = candidate.resources.length ? [...currentCards].filter((card) => !identities.has(card))
      .map((card) => `current job ${card} has no reviewed reservation or complete footprint; admission waits`) : [];
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
    return { decision: 'unavailable', reasons: [/** @type {Error} */ (error).message] };
  }
}

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATE_LINE = /^(?:Waiting version|Changes asked|Parked): /;

// A card's two newest revisions, newest first, each `diff` the revision's whole text.
const STATE_HISTORY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    issue(number: $number) { userContentEdits(first: 2) { nodes { diff } } }
  }
}`;

// The configured board repository, as the approval read takes it.
export function configuredRepository(exec) {
  const nameWithOwner = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;
  const repository = JSON.parse(exec(['repo', 'view', nameWithOwner, '--json', 'id,nameWithOwner']));
  if (typeof repository?.id !== 'string' || repository.nameWithOwner !== nameWithOwner) throw new Error(`the repository ${nameWithOwner} cannot be read`);
  return repository;
}

// `body` with every state line dropped and its end trimmed, ending with `line` unless `line` is null.
export function withLine(body, line) {
  const kept = body.split('\n').filter((text) => !STATE_LINE.test(text)).join('\n').trimEnd();
  if (line === null) return kept;
  return `${kept ? `${kept}\n` : ''}${line}`;
}

// The last state line of `body`, or null where it has none.
export const lastStateLine = (body) => body.split('\n').findLast((text) => STATE_LINE.test(text)) ?? null;

// The two newest revisions of card's body in `repository`, `[newest, previous]`, each the revision's whole text, read
// from its edit history; a history that is unreadable or holds fewer than two revisions is refused.
export function bodyRevisions(card, { exec, repository }) {
  const [owner, name] = repository.nameWithOwner.split('/');
  const reply = JSON.parse(exec(['api', 'graphql', '-f', `query=${STATE_HISTORY_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${card}`]));
  const nodes = reply?.data?.repository?.issue?.userContentEdits?.nodes;
  if (!Array.isArray(nodes) || nodes.length < 2 || !nodes.slice(0, 2).every((node) => typeof node?.diff === 'string')) {
    throw new Error(`unreadable edit history for card ${card} in ${repository.nameWithOwner}`);
  }
  return [nodes[0].diff, nodes[1].diff];
}

// The whole card read: the card's state, title and body, and its comments oldest first, each with its text, author,
// last edit and address, 100 to a page.
const WHOLE_CARD_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    id
    issue(number: $number) {
      state
      title
      body
      comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { author { login } lastEditedAt url body } }
    }
  }
}`;

// Whether a page of the whole card read is the shape it asks for: text state, title and body; each comment with
// text, an address, an author that is gone or has a login, and an edit time or none; and a cursor wherever another
// page follows.
const isWholeCardPage = (issue) => typeof issue?.state === 'string' && typeof issue.title === 'string' && typeof issue.body === 'string'
  && typeof issue.comments?.pageInfo?.hasNextPage === 'boolean' && Array.isArray(issue.comments.nodes)
  && issue.comments.nodes.every((node) => typeof node?.body === 'string' && typeof node.url === 'string'
    && (node.author === null || typeof node.author?.login === 'string') && (node.lastEditedAt === null || typeof node.lastEditedAt === 'string'))
  && (!issue.comments.pageInfo.hasNextPage || (typeof issue.comments.pageInfo.endCursor === 'string' && issue.comments.pageInfo.endCursor !== ''));

// Card `card` of `repository` with every comment, `{ state, title, body, comments }`: the first page's state, title and
// body, and every comment the card has, oldest first, read a page at a time. Throws one line where a reply answers for
// another repository or is not the shape asked for.
export function readWholeCard(card, { exec, repository }) {
  const [owner, name] = repository.nameWithOwner.split('/');
  const comments = [];
  let first;
  let after = null;
  do {
    const args = ['-f', `query=${WHOLE_CARD_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${card}`,
      ...(after === null ? [] : ['-f', `after=${after}`])];
    const answered = JSON.parse(exec(['api', 'graphql', ...args]))?.data?.repository;
    if (answered?.id !== repository.id) {
      throw new Error(`the card read answered for repository ${JSON.stringify(answered?.id)}, not origin's ${repository.nameWithOwner}`);
    }
    if (!isWholeCardPage(answered.issue)) throw new Error(`unreadable card read for card ${card} in ${repository.nameWithOwner}`);
    first ??= answered.issue;
    const { pageInfo, nodes } = answered.issue.comments;
    comments.push(...nodes);
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after !== null);
  return { state: first.state, title: first.title, body: first.body, comments };
}

// The one writer of a card's state line: a body edit that drops every earlier state line and ends the body with
// `line`, or with no state line where `line` is null, built from the body `readWholeCard` reads. A body already ending
// that way is not edited, since GitHub records no revision for an edit that changes nothing. The issue API offers no
// precondition, so after each edit the card's edit history shows which revision it replaced; one that is not the body
// the edit was built from is an owner edit that landed in between, and the line is written again over that revision, at
// most three writes in all. A card read `readWholeCard` refuses, a body that is not text among them, is refused before
// any write, and a history that is unreadable or whose newest revision is not the text just written is refused after it.
export function writeStateLine(card, line, { exec }) {
  const repository = configuredRepository(exec);
  let replaced = readWholeCard(card, { exec, repository }).body;
  let written = withLine(replaced, line);
  for (let writes = 0; written !== replaced; writes += 1) {
    if (writes === 3) throw new Error(`card ${card} was edited during each of three state line writes, so its state line is written over an edit that now survives only in the card's edit history`);
    exec(['api', '-X', 'PATCH', `repos/${repository.nameWithOwner}/issues/${card}`, '-f', `body=${written}`]);
    const [newest, previous] = bodyRevisions(card, { exec, repository });
    if (newest !== written) throw new Error(`the newest revision of card ${card} is not its state line write`);
    if (previous === replaced) break;
    replaced = written;
    written = withLine(previous, line);
  }
}

const PHASE_PROMPTS = {
  prepare: 'Prepare this exact pre-approved job. Do not build or deliver.',
  build: 'Build and verify this exact prepared job. Do not publish or deliver.',
  deliver: 'Deliver this exact built job. Do not select or build another job.',
};
const SELECTION_FIELDS = ['runStart', 'card', 'claimUrl', 'priorClaimUrls', 'branch', 'worktree', 'base'];
const PREPARED_REFERENCE_FIELDS = ['descriptorPath', 'descriptorHash', 'planHash', 'reviewRecordPath'];

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
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
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
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
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
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT' || context.phase !== 'build') throw error;
      writeFileSync(path, bytes, { flag: 'wx' });
    }
  }
  writeFileSync(logBase + '.context.json', JSON.stringify(context) + '\n', { flag: 'wx' });
}

export function verifyPreparedContext(context, { runStart, exec, git }) {
  const { selection } = readPhaseContext(context, runStart);
  const verified = verifyClaimContext(selection, { exec, git });
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
  requireMergeOnEvidence({ git });
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

function verifyClaimContext(selection, { exec, git }) {
  const repository = admissionRepository(exec, git);
  const metadata = readCard(selection.card, { exec, repository });
  const item = fetchBoard(exec).find((entry) => entry.content.__typename === 'Issue' && entry.content.number === selection.card);
  const inventory = readWorktreeRecords(git);
  const claim = verifyClaimedJob(selection, { metadata, item, inventory, git });
  return { claimCreatedAt: Date.parse(claim.createdAt), jobWorktrees: inventory.map((entry) => entry.path) };
}

// Whether `card`, a board item as normalizeItem reads it, is a `Ready` card a run may take on the board's own facts: open,
// numbered, no epic, unassigned, with no open blocker and no closing pull request.
export const readyOnBoard = (card) => card.status === READY && card.state === 'OPEN' && cardNumber(card.number) && !isEpic(card)
  && !card.assignees.length && !card.openBlockers.length && !card.closingPullRequests.length;

export function managedPath(path) {
  return typeof path === 'string' && isAbsolute(path) && normalize(path) === path && !CONTROL.test(path);
}

export function readManagedRecord(path, limit = 16 * 1024) {
  const privateFile = (entry) => entry.isFile() && entry.nlink === 1 && entry.uid === /** @type {() => number} */ (process.getuid)()
    && (entry.mode & 0o7777) === 0o600 && entry.size <= limit;
  const entry = lstatSync(path);
  if (!privateFile(entry)) throw new Error('invalid private managed record');
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(file);
    if (!privateFile(opened) || opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error('managed record identity changed');
    const bytes = Buffer.alloc(opened.size + 1);
    const length = readSync(file, bytes, 0, bytes.length, 0);
    if (length !== opened.size) throw new Error('managed record changed during read');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)));
  } finally {
    closeSync(file);
  }
}

export const MAX_CAP = 16;
export function isCanonicalLeadFolder(folder) {
  const stat = lstatSync(folder);
  return stat.isDirectory() && stat.uid === /** @type {() => number} */ (process.getuid)() && (stat.mode & 0o7777) === 0o700 && realpathSync(folder) === folder;
}
