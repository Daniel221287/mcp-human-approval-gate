// Human approval gate: an agent may PREPARE an action, only a human may APPROVE the exact preview,
// the agent may then EXECUTE it once. Unknown outcomes are never retried automatically.
import { createHash, randomUUID } from 'node:crypto';

export const STATES = Object.freeze({
  PREVIEW_READY: 'PREVIEW_READY',
  APPROVED: 'APPROVED_BY_HUMAN',
  SUCCEEDED: 'SUCCEEDED_VERIFIED',
  REVOKED: 'REVOKED_BEFORE_EFFECT',
  FAILED: 'FAILED_NO_RETRY'
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function refuse(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  throw error;
}

export class ApprovalGate {
  #items = new Map();

  constructor({ maxPending = 20, ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxPending = maxPending;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  prepare({ action, payload = null, note = '', requestedBy = 'agent' }) {
    if (typeof action !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/.test(action)) refuse('INVALID_ACTION');
    if (JSON.stringify(payload).length > 8192) refuse('PAYLOAD_TOO_LARGE', 413);
    const waiting = [...this.#items.values()].filter((row) => row.state === STATES.PREVIEW_READY).length;
    if (waiting >= this.maxPending) refuse('TOO_MANY_PENDING_REQUESTS', 429);
    const preview = { action, payload, note: String(note ?? '').slice(0, 200) };
    const id = randomUUID();
    this.#items.set(id, {
      id,
      preview,
      previewSha256: sha256(JSON.stringify(preview)),
      requestedBy: String(requestedBy).slice(0, 40),
      state: STATES.PREVIEW_READY,
      createdAt: this.now(),
      approvedAt: null,
      executions: 0,
      result: null
    });
    return this.view(id);
  }

  view(id) {
    const row = this.#get(id);
    return {
      id: row.id,
      state: row.state,
      requested_by: row.requestedBy,
      preview: structuredClone(row.preview),
      preview_sha256: row.previewSha256,
      result: row.result ? structuredClone(row.result) : null
    };
  }

  pending() {
    return [...this.#items.values()]
      .filter((row) => row.state === STATES.PREVIEW_READY)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => this.view(row.id));
  }

  // Human channel only. Never expose this as an agent tool.
  approve({ id, previewSha256 }) {
    const row = this.#get(id);
    if (row.state !== STATES.PREVIEW_READY) refuse('NOT_WAITING_FOR_APPROVAL', 409);
    if (previewSha256 !== row.previewSha256) refuse('PREVIEW_HASH_MISMATCH');
    if (this.now() - row.createdAt > this.ttlMs) refuse('REQUEST_EXPIRED', 410);
    row.state = STATES.APPROVED;
    row.approvedAt = this.now();
    return this.view(id);
  }

  revoke({ id }) {
    const row = this.#get(id);
    if (row.state !== STATES.PREVIEW_READY && row.state !== STATES.APPROVED) refuse('NOTHING_TO_REVOKE', 409);
    row.state = STATES.REVOKED;
    return this.view(id);
  }

  async execute({ id, previewSha256 }, effect) {
    const row = this.#get(id);
    if (row.executions > 0) refuse('ALREADY_EXECUTED_NO_REPLAY', 409);
    if (row.state !== STATES.APPROVED || previewSha256 !== row.previewSha256) refuse('EXACT_PREVIEW_APPROVAL_REQUIRED', 403);
    if (this.now() - row.approvedAt > this.ttlMs) refuse('APPROVAL_EXPIRED', 410);
    row.executions = 1; // reserved BEFORE the effect: a crash or timeout is never replayed
    let outcome;
    try {
      outcome = await effect(structuredClone(row.preview));
    } catch (error) {
      row.state = STATES.FAILED;
      row.result = { verified: false, detail: String(error?.code || error?.message || 'EFFECT_FAILED') };
      throw error;
    }
    if (!outcome || outcome.verified !== true) {
      row.state = STATES.FAILED;
      row.result = { verified: false, detail: outcome?.detail ?? null };
      refuse('READBACK_NOT_VERIFIED', 500);
    }
    row.state = STATES.SUCCEEDED;
    row.result = { verified: true, detail: outcome.detail ?? null };
    return this.view(id);
  }

  // Read-only reconciliation: tells the agent what happened, never runs anything again.
  recover({ id }) {
    const current = this.view(id);
    return { ...current, retry_allowed: false, recovery: current.state === STATES.SUCCEEDED ? 'COMPLETED_NO_REPLAY' : 'NO_AUTOMATIC_RETRY' };
  }

  #get(id) {
    const row = this.#items.get(id);
    if (!row) refuse('REQUEST_NOT_FOUND', 404);
    return row;
  }
}
