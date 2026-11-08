// codex-hook-adapters.test.mjs — the Codex payload adapters both Codex hooks depend on,
// including the fail-open decision for an encrypted dispatch body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
