// codex-hook-adapters.test.mjs — the Codex payload adapters both Codex hooks depend on,
// including the fail-open decision for an encrypted dispatch body, and the real Codex guard's
// reading of the run session mark. Recurring cost of the guard cases: three Node starts.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { gitEnvironment } from './factory-sync.mjs';
import { codexCommandForGuard, codexCwdForGuard, codexHandoffForGuard, isOpaqueDispatchMessage } from './codex-hook-adapters.mjs';

test('codexCommandForGuard prefers cmd, falls back to command, else empty', () => {
  assert.equal(codexCommandForGuard({ cmd: 'git push --force' }), 'git push --force');
  assert.equal(codexCommandForGuard({ command: 'git status' }), 'git status');
  assert.equal(codexCommandForGuard({ cmd: 'a', command: 'b' }), 'a');
  assert.equal(codexCommandForGuard({}), '');
  assert.equal(codexCommandForGuard(null), '');
});

test('codexCwdForGuard prefers the command workdir, falls back to the session cwd, else empty', () => {
  assert.equal(codexCwdForGuard({ cwd: '/repo', tool_input: { workdir: '/repo/.claude/worktrees/1' } }), '/repo/.claude/worktrees/1');
  assert.equal(codexCwdForGuard({ cwd: '/repo', tool_input: { cmd: 'git status' } }), '/repo');
  assert.equal(codexCwdForGuard({}), '');
  assert.equal(codexCwdForGuard(null), '');
});

test('codexHandoffForGuard maps the Codex dispatch shape onto the shared handoff shape', () => {
  assert.deepEqual(codexHandoffForGuard({ agent_type: 'builder', message: 'Slice: x' }), { subagent_type: 'builder', prompt: 'Slice: x' });
  assert.deepEqual(codexHandoffForGuard(undefined), { subagent_type: undefined, prompt: undefined });
});

test('isOpaqueDispatchMessage accepts only a full Fernet-shaped token', () => {
  // A real Fernet token: version byte, timestamp, IV, ciphertext, and HMAC, base64url, ≥ 57 bytes.
  const opaque = `gAAAAA${'A'.repeat(100)}`;
  assert.equal(isOpaqueDispatchMessage(opaque), true);
  // A short lookalike must NOT skip validation.
  assert.equal(isOpaqueDispatchMessage('gAAAAABshort'), false);
  // A filled handoff template is never opaque.
  assert.equal(isOpaqueDispatchMessage('Slice: cycle time card\nClaim: renders unavailable copy\n'), false);
  assert.equal(isOpaqueDispatchMessage(42), false);
  assert.equal(isOpaqueDispatchMessage(undefined), false);
});

// The real Codex guard in its own process. An undefined env value leaves a variable out even when the
// suite itself runs inside a run session.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const runGuard = (input, env) => spawnSync(process.execPath, [resolve(ROOT, '.codex/hooks/block-unsafe-git.mjs')], {
  input,
  encoding: 'utf8',
  env: { ...gitEnvironment(), ...env },
});

test('ANTI-REGRESSION: the Codex guard refuses git push with the run session mark and passes it without', () => {
  const input = JSON.stringify({ cwd: ROOT, tool_input: { command: 'git push origin job/1' } });
  const guard = (mark) => runGuard(input, { PRODUCT_MANAGER_RUN_SESSION: mark });

  const marked = guard('1');
  assert.equal(marked.status, 2, marked.stderr);
  assert.ok(marked.stderr.includes('Blocked: a product manager run session'), marked.stderr);

  const unmarked = guard(undefined);
  assert.equal(unmarked.status, 0, unmarked.stderr);
  assert.equal(unmarked.stderr, '');
});

// Recurring cost: one Node start. It reaches neither git nor gh: an unreadable payload is refused before any read.
test('ANTI-REGRESSION: the Codex guard refuses a call whose hook payload is unreadable under the pre-approved mark', () => {
  const marks = (mark) => ({ GH_REPO: undefined, GH_HOST: undefined, PRODUCT_MANAGER_RUN_SESSION: undefined, PRE_APPROVED_RUN_SESSION: mark });

  const unreadable = runGuard('this is not json', marks('2026-11-04T12:00:00Z'));
  assert.equal(unreadable.status, 2, unreadable.stderr);
  assert.ok(unreadable.stderr.includes('a pre-approved run session'), unreadable.stderr);
});
