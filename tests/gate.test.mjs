import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalGate, STATES } from '../src/gate.mjs';
import { sandboxNoteEffect } from '../src/effects.mjs';

const REQUEST = { action: 'note.create', payload: { text: 'Release checklist v1' }, note: 'agent asks', requestedBy: 'mcp_agent' };

function spyEffect(answer = async () => ({ verified: true, detail: 'ok' })) {
  const calls = [];
  const effect = async (preview) => { calls.push(preview); return answer(preview); };
  return { effect, calls };
}

const refusedWith = (code) => (error) => { assert.equal(error.code, code); return true; };

test('the agent cannot run anything before a human approves the exact preview', async () => {
  const gate = new ApprovalGate();
  const { effect, calls } = spyEffect();
  const r = gate.prepare(REQUEST);
  assert.equal(r.state, STATES.PREVIEW_READY);
  assert.match(r.preview_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(gate.pending().map((x) => x.id), [r.id]);
  await assert.rejects(gate.execute({ id: r.id, previewSha256: r.preview_sha256 }, effect), refusedWith('EXACT_PREVIEW_APPROVAL_REQUIRED'));
  assert.equal(calls.length, 0);
  assert.equal(gate.view(r.id).state, STATES.PREVIEW_READY);
});

test('a wrong preview hash cannot be approved, and approving does not run anything by itself', () => {
  const gate = new ApprovalGate();
  const r = gate.prepare(REQUEST);
  assert.throws(() => gate.approve({ id: r.id, previewSha256: '0'.repeat(64) }), refusedWith('PREVIEW_HASH_MISMATCH'));
  assert.equal(gate.view(r.id).state, STATES.PREVIEW_READY);
  const approved = gate.approve({ id: r.id, previewSha256: r.preview_sha256 });
  assert.equal(approved.state, STATES.APPROVED);
  assert.equal(approved.result, null);
  assert.deepEqual(gate.pending(), []);
  assert.throws(() => gate.approve({ id: r.id, previewSha256: r.preview_sha256 }), refusedWith('NOT_WAITING_FOR_APPROVAL'));
});

test('an approved request runs exactly once and a second call is refused (no replay)', async () => {
  const gate = new ApprovalGate();
  const { effect, calls } = spyEffect();
  const r = gate.prepare(REQUEST);
  gate.approve({ id: r.id, previewSha256: r.preview_sha256 });
  const done = await gate.execute({ id: r.id, previewSha256: r.preview_sha256 }, effect);
  assert.equal(done.state, STATES.SUCCEEDED);
  assert.deepEqual(done.result, { verified: true, detail: 'ok' });
  assert.deepEqual(calls, [{ action: 'note.create', payload: { text: 'Release checklist v1' }, note: 'agent asks' }]);
  await assert.rejects(gate.execute({ id: r.id, previewSha256: r.preview_sha256 }, effect), refusedWith('ALREADY_EXECUTED_NO_REPLAY'));
  assert.equal(calls.length, 1);
  const recovered = gate.recover({ id: r.id });
  assert.equal(recovered.recovery, 'COMPLETED_NO_REPLAY');
  assert.equal(recovered.retry_allowed, false);
});

test('a revoked request can never run', async () => {
  const gate = new ApprovalGate();
  const { effect, calls } = spyEffect();
  const before = gate.prepare(REQUEST);
  assert.equal(gate.revoke({ id: before.id }).state, STATES.REVOKED);
  const after = gate.prepare(REQUEST);
  gate.approve({ id: after.id, previewSha256: after.preview_sha256 });
  assert.equal(gate.revoke({ id: after.id }).state, STATES.REVOKED);
  for (const r of [before, after]) {
    await assert.rejects(gate.execute({ id: r.id, previewSha256: r.preview_sha256 }, effect), refusedWith('EXACT_PREVIEW_APPROVAL_REQUIRED'));
  }
  assert.equal(calls.length, 0);
  assert.throws(() => gate.revoke({ id: after.id }), refusedWith('NOTHING_TO_REVOKE'));
});

test('a failed or unverified effect is never retried automatically', async () => {
  const gate = new ApprovalGate();
  const crash = spyEffect(async () => { const e = new Error('DISK_FULL'); e.code = 'DISK_FULL'; throw e; });
  const a = gate.prepare(REQUEST);
  gate.approve({ id: a.id, previewSha256: a.preview_sha256 });
  await assert.rejects(gate.execute({ id: a.id, previewSha256: a.preview_sha256 }, crash.effect), refusedWith('DISK_FULL'));
  assert.equal(gate.view(a.id).state, STATES.FAILED);
  await assert.rejects(gate.execute({ id: a.id, previewSha256: a.preview_sha256 }, crash.effect), refusedWith('ALREADY_EXECUTED_NO_REPLAY'));
  assert.equal(crash.calls.length, 1);
  assert.equal(gate.recover({ id: a.id }).recovery, 'NO_AUTOMATIC_RETRY');

  const unverified = spyEffect(async () => ({ verified: false, detail: 'readback differs' }));
  const b = gate.prepare(REQUEST);
  gate.approve({ id: b.id, previewSha256: b.preview_sha256 });
  await assert.rejects(gate.execute({ id: b.id, previewSha256: b.preview_sha256 }, unverified.effect), refusedWith('READBACK_NOT_VERIFIED'));
  assert.equal(gate.view(b.id).state, STATES.FAILED);
  assert.deepEqual(gate.view(b.id).result, { verified: false, detail: 'readback differs' });
});

test('old requests and old approvals expire', async () => {
  let clock = 1_000;
  const gate = new ApprovalGate({ ttlMs: 1_000, now: () => clock });
  const { effect, calls } = spyEffect();
  const stale = gate.prepare(REQUEST);
  clock += 1_001;
  assert.throws(() => gate.approve({ id: stale.id, previewSha256: stale.preview_sha256 }), refusedWith('REQUEST_EXPIRED'));
  const late = gate.prepare(REQUEST);
  gate.approve({ id: late.id, previewSha256: late.preview_sha256 });
  clock += 1_001;
  await assert.rejects(gate.execute({ id: late.id, previewSha256: late.preview_sha256 }, effect), refusedWith('APPROVAL_EXPIRED'));
  assert.equal(calls.length, 0);
});

test('input limits: bad action names, oversized payloads, floods and unknown ids are refused', () => {
  const gate = new ApprovalGate({ maxPending: 2 });
  assert.throws(() => gate.prepare({ action: 'Rm -rf /' }), refusedWith('INVALID_ACTION'));
  assert.throws(() => gate.prepare({ action: 'note.create', payload: { text: 'x'.repeat(9000) } }), refusedWith('PAYLOAD_TOO_LARGE'));
  gate.prepare(REQUEST);
  gate.prepare(REQUEST);
  assert.throws(() => gate.prepare(REQUEST), refusedWith('TOO_MANY_PENDING_REQUESTS'));
  assert.throws(() => gate.view('missing'), refusedWith('REQUEST_NOT_FOUND'));
});

test('the example effect writes one new note in its own folder and verifies it by reading it back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-effect-'));
  try {
    const effect = sandboxNoteEffect(dir);
    const out = await effect({ action: 'note.create', payload: { text: 'Hello, approved by a human.' }, note: '' });
    assert.equal(out.verified, true);
    assert.deepEqual(await readdir(dir), [out.detail.file]);
    assert.equal(await readFile(join(dir, out.detail.file), 'utf8'), 'Hello, approved by a human.');
    assert.match(out.detail.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(effect({ action: 'file.delete', payload: {} }), refusedWith('UNSUPPORTED_ACTION'));
    assert.equal((await readdir(dir)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
