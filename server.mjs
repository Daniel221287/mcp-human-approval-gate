// MCP server (spec 2025-11-25, Streamable HTTP) + a local human approval page, loopback only.
// The agent gets three tools: prepare, status, execute. There is deliberately NO approve tool.
// The human channel (/human/*) requires a per-start token that is printed only in the server console.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { ApprovalGate } from './src/gate.mjs';
import { sandboxNoteEffect } from './src/effects.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SECURITY = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
});
const STATIC = Object.freeze({
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/page.js': ['public/page.js', 'text/javascript; charset=utf-8'],
  '/page.css': ['public/page.css', 'text/css; charset=utf-8']
});

function send(res, status, payload) {
  res.writeHead(status, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function httpError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) throw httpError('JSON_REQUIRED', 415);
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > 16384) throw httpError('REQUEST_TOO_LARGE', 413);
    parts.push(part);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { throw httpError('BAD_JSON', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError('BAD_JSON', 400);
  return value;
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({
  gate = new ApprovalGate(),
  effect = sandboxNoteEffect(resolve(here, 'sandbox')),
  humanToken = randomBytes(16).toString('hex')
} = {}) {
  const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const no = (error) => ({ isError: true, content: [{ type: 'text', text: String(error?.code || error?.message || 'REFUSED') }] });

  function tools() {
    const server = new McpServer({ name: 'mcp-human-approval-gate', version: '0.1.0' });
    server.registerTool('approval_prepare', {
      description: 'Prepare a note.create action as a preview. Nothing runs yet. A human must approve this exact preview on the local approval page; the agent cannot approve.',
      inputSchema: z.object({ text: z.string().min(1).max(2000), note: z.string().max(200).optional() })
    }, async ({ text, note }) => {
      try { return ok(gate.prepare({ action: 'note.create', payload: { text }, note, requestedBy: 'mcp_agent' })); } catch (error) { return no(error); }
    });
    server.registerTool('approval_status', {
      description: 'Read-only: the state of a prepared request and what happened. Never runs anything.',
      inputSchema: z.object({ id: z.string().uuid() })
    }, async ({ id }) => {
      try { return ok(gate.recover({ id })); } catch (error) { return no(error); }
    });
    server.registerTool('approval_execute', {
      description: 'Run a prepared request ONCE, only after a human approved this exact preview hash. Any second call is refused (no replay).',
      inputSchema: z.object({ id: z.string().uuid(), preview_sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    }, async ({ id, preview_sha256 }) => {
      try { return ok(await gate.execute({ id, previewSha256: preview_sha256 }, effect)); } catch (error) { return no(error); }
    });
    return server;
  }

  const handler = createMcpHandler(() => tools(), { responseMode: 'json' });
  const mcp = toNodeHandler(handler);
  const checkHost = localhostHostValidation();
  const checkOrigin = localhostOriginValidation();

  const http = createServer((req, res) => {
    if (!checkHost(req, res) || !checkOrigin(req, res)) return;
    (async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/mcp') return mcp(req, res);
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const data = await readFile(resolve(here, file));
        res.writeHead(200, { ...SECURITY, 'Content-Type': type });
        return res.end(data);
      }
      if (req.method === 'POST' && url.pathname.startsWith('/human/')) {
        if (!sameToken(req.headers['x-human-token'], humanToken)) return send(res, 401, { error: 'HUMAN_TOKEN_REQUIRED' });
        const body = await readJson(req);
        if (url.pathname === '/human/pending') return send(res, 200, { requests: gate.pending() });
        if (url.pathname === '/human/approve') return send(res, 200, gate.approve({ id: body.id, previewSha256: body.preview_sha256 }));
        if (url.pathname === '/human/revoke') return send(res, 200, gate.revoke({ id: body.id }));
        if (url.pathname === '/human/status') return send(res, 200, gate.recover({ id: body.id }));
      }
      return send(res, 404, { error: 'NOT_FOUND' });
    })().catch((error) => {
      if (res.headersSent) return res.destroy();
      const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(String(error?.code)) ? error.code : 'BAD_REQUEST';
      return send(res, Number(error?.status) || 400, { error: code });
    });
  });

  const close = async () => {
    await handler.close();
    await new Promise((ok) => http.close(ok));
  };
  return { http, gate, humanToken, close };
}

export async function start({ port = 4800, host = '127.0.0.1', ...options } = {}) {
  if (host !== '127.0.0.1') throw new Error('LOOPBACK_ONLY');
  const app = createApp(options);
  await new Promise((ok, no) => { app.http.once('error', no); app.http.listen(port, host, ok); });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await start({ port: Number(process.env.PORT || 4800) });
  const { port } = app.http.address();
  console.log(`MCP endpoint: http://127.0.0.1:${port}/mcp`);
  console.log(`Human page:   http://127.0.0.1:${port}/?t=${app.humanToken}`);
  console.log('Open the human page yourself. Do not give this link to the agent.');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => { await app.close(); process.exit(0); });
  }
}
