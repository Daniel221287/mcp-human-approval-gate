import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server.mjs';
import { sandboxNoteEffect } from '../src/effects.mjs';

const TEXT = 'Release checklist v1: tests green, notes written.';

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gate-http-'));
  const app = await start({ port: 0, effect: sandboxNoteEffect(dir) });
  const base = `http://127.0.0.1:${app.http.address().port}`;
  try {
    await fn({ app, base, dir });
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function agent(base) {
  let id = 0;
  const rpc = async (method, params = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    });
    const raw = await res.text();
    assert.equal(res.status, 200, raw.slice(0, 300));
    const json = (res.headers.get('content-type') || '').includes('text/event-stream')
      ? (raw.split(/\r?\n/).find((line) => line.startsWith('data: ')) || '').slice(6)
      : raw;
    const body = JSON.parse(json);
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return body.result;
  };
  const tool = (name, args) => rpc('tools/call', { name, arguments: args });
  const init = () => rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'gate-test-agent', version: '0.1.0' } });
  return { rpc, tool, init };
}

async function human(base, token, path, body = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { 'X-Human-Token': token }) },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

const parse = (result) => JSON.parse(result.content[0].text);

test('MCP exposes prepare, status and execute, and there is no approve tool', async () => {
  await withServer(async ({ base }) => {
    const a = agent(base);
    const init = await a.init();
    assert.equal(init.protocolVersion, '2025-11-25');
    const { tools } = await a.rpc('tools/list');
    assert.deepEqual(tools.map((t) => t.name).sort(), ['approval_execute', 'approval_prepare', 'approval_status']);
  });
});

test('full flow: agent prepares, human approves the exact preview, agent runs it once, replay refused', async () => {
  await withServer(async ({ app, base, dir }) => {
    const a = agent(base);
    await a.init();
    const prepared = await a.tool('approval_prepare', { text: TEXT, note: 'release checklist' });
    assert.equal(prepared.isError, undefined);
    const p = parse(prepared);
    assert.equal(p.state, 'PREVIEW_READY');
    assert.equal(p.requested_by, 'mcp_agent');
    const args = { id: p.id, preview_sha256: p.preview_sha256 };

    const early = await a.tool('approval_execute', args);
    assert.equal(early.isError, true);
    assert.match(early.content[0].text, /EXACT_PREVIEW_APPROVAL_REQUIRED/);
    assert.deepEqual(await readdir(dir), []);

    const pending = await human(base, app.humanToken, '/human/pending');
    assert.equal(pending.status, 200);
    assert.deepEqual(pending.data.requests.map((r) => r.id), [p.id]);
    assert.equal(pending.data.requests[0].preview.payload.text, TEXT);

    const wrong = await human(base, app.humanToken, '/human/approve', { id: p.id, preview_sha256: 'f'.repeat(64) });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.data.error, 'PREVIEW_HASH_MISMATCH');
    const approved = await human(base, app.humanToken, '/human/approve', args);
    assert.equal(approved.status, 200);
    assert.equal(approved.data.state, 'APPROVED_BY_HUMAN');
    assert.deepEqual((await human(base, app.humanToken, '/human/pending')).data.requests, []);

    const run = await a.tool('approval_execute', args);
    assert.equal(run.isError, undefined);
    const done = parse(run);
    assert.equal(done.state, 'SUCCEEDED_VERIFIED');
    assert.equal(done.result.verified, true);
    assert.equal(await readFile(join(dir, done.result.detail.file), 'utf8'), TEXT);

    const again = await a.tool('approval_execute', args);
    assert.equal(again.isError, true);
    assert.match(again.content[0].text, /ALREADY_EXECUTED_NO_REPLAY/);
    assert.equal((await readdir(dir)).length, 1);

    const status = parse(await a.tool('approval_status', { id: p.id }));
    assert.equal(status.recovery, 'COMPLETED_NO_REPLAY');
    assert.equal(status.retry_allowed, false);
  });
});

test('the human channel needs the per-start token, so the agent cannot approve over HTTP', async () => {
  await withServer(async ({ app, base }) => {
    const a = agent(base);
    await a.init();
    const p = parse(await a.tool('approval_prepare', { text: TEXT }));
    for (const token of [undefined, '', 'wrong-token', `${app.humanToken}x`]) {
      const tried = await human(base, token, '/human/approve', { id: p.id, preview_sha256: p.preview_sha256 });
      assert.equal(tried.status, 401);
      assert.equal(tried.data.error, 'HUMAN_TOKEN_REQUIRED');
    }
    assert.equal(app.gate.view(p.id).state, 'PREVIEW_READY');
  });
});

test('a request revoked by the human is never executed', async () => {
  await withServer(async ({ app, base, dir }) => {
    const a = agent(base);
    await a.init();
    const p = parse(await a.tool('approval_prepare', { text: TEXT }));
    const revoked = await human(base, app.humanToken, '/human/revoke', { id: p.id });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.state, 'REVOKED_BEFORE_EFFECT');
    const run = await a.tool('approval_execute', { id: p.id, preview_sha256: p.preview_sha256 });
    assert.equal(run.isError, true);
    assert.match(run.content[0].text, /EXACT_PREVIEW_APPROVAL_REQUIRED/);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('loopback guards: foreign Origin and foreign Host refused, page served with CSP', async () => {
  await withServer(async ({ app, base }) => {
    const foreign = await fetch(`${base}/`, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(foreign.status, 403);
    const rebound = await new Promise((ok, no) => {
      const req = request({ host: '127.0.0.1', port: app.http.address().port, path: '/', headers: { Host: 'attacker.example' } }, (res) => { res.resume(); ok(res.statusCode); });
      req.on('error', no);
      req.end();
    });
    assert.equal(rebound, 403);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await page.text(), /Agent requests waiting for you/);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
  });
});

test('the server refuses to listen on anything but loopback', async () => {
  await assert.rejects(start({ port: 0, host: '0.0.0.0' }), /LOOPBACK_ONLY/);
});
