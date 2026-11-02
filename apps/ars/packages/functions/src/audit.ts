import { createHash } from 'node:crypto';

/**
 * Audit event construction and hash-chain verification (AUD-02, AUD-03).
 * Pure functions; the store decides `seq` and `prev_hash` inside the same
 * transaction that inserts the event.
 */
export const GENESIS_HASH = '0'.repeat(64);

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILURE';

/** What callers supply. Never include address text or tokens in `details`. */
export interface AuditDraft {
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: AuditOutcome;
  actorSub: string | null;
  actorEmail: string | null;
  correlationId: string;
  details?: Record<string, unknown>;
  agentRef?: string | null;
  promptContractVersion?: string | null;
}

/** The fully populated row as stored. */
export interface AuditRow {
  id: string;
  seq: number;
  org_id: string;
  project_id: string;
  app_id: string;
  environment: string;
  actor_sub: string | null;
  actor_email: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  outcome: AuditOutcome;
  correlation_id: string;
  release_version: string;
  agent_ref: string | null;
  prompt_contract_version: string | null;
  details_json: string | null;
  prev_hash: string;
  event_hash: string;
  occurred_at: Date;
}

export interface AuditContext {
  orgId: string;
  projectId: string;
  appId: string;
  environment: string;
  release: string;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The hashed fields, in a fixed order. `occurred_at` is hashed as ISO-8601 at millisecond precision. */
export function canonicalAuditPayload(row: Omit<AuditRow, 'event_hash'>): string {
  return JSON.stringify([
    row.id,
    row.seq,
    row.org_id,
    row.project_id,
    row.app_id,
    row.environment,
    row.actor_sub,
    row.actor_email,
    row.action,
    row.object_type,
    row.object_id,
    row.outcome,
    row.correlation_id,
    row.release_version,
    row.agent_ref,
    row.prompt_contract_version,
    row.details_json,
    row.prev_hash,
    row.occurred_at.toISOString(),
  ]);
}

export function computeEventHash(row: Omit<AuditRow, 'event_hash'>): string {
  return sha256Hex(canonicalAuditPayload(row));
}

export function buildAuditRow(
  draft: AuditDraft,
  ctx: AuditContext,
  seq: number,
  prevHash: string,
  id: string,
  occurredAt: Date
): AuditRow {
  const details = draft.details ? JSON.stringify(draft.details) : null;
  if (details && details.length > 2000) {
    throw new Error('Audit details exceed 2000 characters');
  }
  // SQL DATETIME2 keeps more precision than JS Date; normalise to milliseconds.
  const occurred = new Date(Math.floor(occurredAt.getTime()));
  const base: Omit<AuditRow, 'event_hash'> = {
    id,
    seq,
    org_id: ctx.orgId,
    project_id: ctx.projectId,
    app_id: ctx.appId,
    environment: ctx.environment,
    actor_sub: draft.actorSub,
    actor_email: draft.actorEmail,
    action: draft.action,
    object_type: draft.objectType,
    object_id: draft.objectId,
    outcome: draft.outcome,
    correlation_id: draft.correlationId,
    release_version: ctx.release,
    agent_ref: draft.agentRef ?? null,
    prompt_contract_version: draft.promptContractVersion ?? null,
    details_json: details,
    prev_hash: prevHash,
    occurred_at: occurred,
  };
  return { ...base, event_hash: computeEventHash(base) };
}

export interface ChainVerification {
  intact: boolean;
  checked: number;
  firstBrokenSeq: number | null;
  reason: string | null;
}

/**
 * Verify rows ordered by seq ascending, starting at seq 1 (or continuing from
 * `expectedPrev` / `expectedSeq` when verifying in pages).
 */
export function verifyAuditChain(
  rows: AuditRow[],
  expectedPrev = GENESIS_HASH,
  expectedSeq = 1
): ChainVerification & { lastHash: string; nextSeq: number } {
  let prev = expectedPrev;
  let seq = expectedSeq;
  for (const row of rows) {
    if (row.seq !== seq) {
      return { intact: false, checked: seq - expectedSeq, firstBrokenSeq: seq, reason: `Missing or reordered event at seq ${seq}`, lastHash: prev, nextSeq: seq };
    }
    if (row.prev_hash !== prev) {
      return { intact: false, checked: seq - expectedSeq, firstBrokenSeq: row.seq, reason: 'prev_hash does not match the previous event', lastHash: prev, nextSeq: seq };
    }
    const { event_hash, ...rest } = row;
    if (computeEventHash(rest) !== event_hash) {
      return { intact: false, checked: seq - expectedSeq, firstBrokenSeq: row.seq, reason: 'event_hash does not match the event content', lastHash: prev, nextSeq: seq };
    }
    prev = event_hash;
    seq++;
  }
  return { intact: true, checked: seq - expectedSeq, firstBrokenSeq: null, reason: null, lastHash: prev, nextSeq: seq };
}
