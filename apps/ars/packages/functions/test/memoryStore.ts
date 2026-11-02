/**
 * TEST DOUBLE — in-memory implementation of the Store interface.
 *
 * Used only by unit tests under test/. It is not part of the functions
 * build (tsconfig includes src/ only) and is never deployed (DEL-06).
 * It mimics the transactional contract of SqlStore: each method that takes
 * an AuditDraft applies all of its changes or none of them.
 */
import { randomUUID } from 'node:crypto';

import { buildAuditRow, GENESIS_HASH, type AuditContext, type AuditDraft, type AuditRow } from '../src/audit.js';
import {
  AuditWriteError,
  DuplicateKeyError,
  type AppConfigRow,
  type ApplyReviewArgs,
  type ApplyReviewOutcome,
  type AuditFilter,
  type CompleteProcessingArgs,
  type MembershipRow,
  type RequestFilter,
  type RequestRow,
  type ResultRow,
  type ReviewRow,
  type SampleRow,
  type SchemaCheckRow,
  type Store,
} from '../src/store.js';

interface State {
  memberships: MembershipRow[];
  requests: RequestRow[];
  results: ResultRow[];
  reviews: ReviewRow[];
  audit: AuditRow[];
  configs: AppConfigRow[];
  samples: SampleRow[];
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  state: State = { memberships: [], requests: [], results: [], reviews: [], audit: [], configs: [], samples: [] };
  /** Fail audit inserts made by business operations (complete/review). */
  failBusinessAudit = false;
  /** Fail every audit insert. */
  failAllAudit = false;
  /** Fail result persistence. */
  failStorage = false;

  constructor(private readonly ctx: AuditContext) {}

  private tx<T>(work: (s: State) => T): T {
    const draft = clone(this.state);
    const result = work(draft);
    this.state = draft;
    return result;
  }

  private audit(s: State, d: AuditDraft, business: boolean): void {
    if (this.failAllAudit || (business && this.failBusinessAudit)) throw new AuditWriteError('injected');
    const last = s.audit[s.audit.length - 1];
    s.audit.push(buildAuditRow(d, this.ctx, last ? last.seq + 1 : 1, last ? last.event_hash : GENESIS_HASH, randomUUID(), new Date()));
  }

  async listActiveMembershipsByEmail(email: string) {
    return clone(this.state.memberships.filter((m) => m.user_email === email && m.status === 'active'));
  }
  async listMembershipsByEmail(email: string) {
    return clone(this.state.memberships.filter((m) => m.user_email === email));
  }
  async bindMembershipSub(ids: string[], sub: string, now: Date, audit: AuditDraft) {
    this.tx((s) => {
      for (const m of s.memberships) if (ids.includes(m.id) && !m.user_sub) Object.assign(m, { user_sub: sub, updated_at: now });
      this.audit(s, audit, false);
    });
  }
  async countActiveAdmins() {
    return this.state.memberships.filter((m) => m.role === 'app_admin' && m.status === 'active').length;
  }
  async listMemberships() {
    return clone(this.state.memberships);
  }
  async getMembership(id: string) {
    return clone(this.state.memberships.find((m) => m.id === id) ?? null);
  }
  async insertMembership(row: MembershipRow, reactivateOwnerSub: string | null, audit: AuditDraft) {
    this.tx((s) => {
      s.memberships.push(clone(row));
      if (reactivateOwnerSub) this.setOwner(s, reactivateOwnerSub, 'active');
      this.audit(s, audit, false);
    });
  }
  async revokeMembership(id: string, by: string, now: Date, revokeOwnerSub: string | null, audit: AuditDraft) {
    this.tx((s) => {
      const m = s.memberships.find((x) => x.id === id && x.status === 'active');
      if (m) Object.assign(m, { status: 'revoked', revoked_by_email: by, revoked_at: now, updated_at: now });
      if (revokeOwnerSub) this.setOwner(s, revokeOwnerSub, 'revoked');
      this.audit(s, audit, false);
    });
  }
  private setOwner(s: State, sub: string, status: 'active' | 'revoked') {
    for (const r of s.requests) if (r.creator_sub === sub) r.owner_status = status;
    for (const r of s.results) if (r.creator_sub === sub) r.owner_status = status;
  }

  async findRequestByKey(key: string) {
    return clone(this.state.requests.find((r) => r.request_key === key) ?? null);
  }
  async getRequest(id: string) {
    return clone(this.state.requests.find((r) => r.id === id) ?? null);
  }
  async insertRequest(row: RequestRow, audit: AuditDraft) {
    if (this.state.requests.some((r) => r.request_key === row.request_key)) throw new DuplicateKeyError();
    this.tx((s) => {
      s.requests.push(clone(row));
      this.audit(s, audit, false);
    });
  }
  async claimForProcessing(id: string, from: RequestRow['processing_status'][], staleBefore: Date, now: Date) {
    const r = this.state.requests.find((x) => x.id === id);
    if (!r) return false;
    const ok = from.includes(r.processing_status) || (r.processing_status === 'PROCESSING' && r.updated_at < staleBefore);
    if (ok) Object.assign(r, { processing_status: 'PROCESSING', error_code: null, updated_at: now });
    return ok;
  }
  async completeProcessing(a: CompleteProcessingArgs) {
    this.tx((s) => {
      if (this.failStorage) throw new Error('injected storage failure');
      s.results.push(clone(a.result));
      const r = s.requests.find((x) => x.id === a.requestId && x.processing_status === 'PROCESSING');
      if (!r) throw new Error('not processing');
      Object.assign(r, {
        processing_status: a.processingStatus,
        decision: a.decision,
        current_fields_json: a.currentFieldsJson,
        review_status: 'PENDING',
        version: r.version + 1,
        error_code: null,
        updated_at: a.now,
      });
      this.audit(s, a.audit, true);
    });
  }
  async failProcessing(id: string, status: RequestRow['processing_status'], code: string, now: Date, audit: AuditDraft | null) {
    this.tx((s) => {
      const r = s.requests.find((x) => x.id === id);
      if (r) Object.assign(r, { processing_status: status, error_code: code, updated_at: now });
      if (audit) this.audit(s, audit, false);
    });
  }
  async getLatestResult(requestId: string) {
    const rows = this.state.results.filter((r) => r.request_id === requestId);
    return clone(rows[rows.length - 1] ?? null);
  }
  async listReviews(requestId: string) {
    return clone(this.state.reviews.filter((r) => r.request_id === requestId));
  }
  async listRequests(f: RequestFilter, offset: number, limit: number) {
    return clone(
      this.state.requests
        .filter((r) => (!f.creatorSub || r.creator_sub === f.creatorSub) && (!f.processingStatus || r.processing_status === f.processingStatus) && (!f.reviewStatus || r.review_status === f.reviewStatus))
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .slice(offset, offset + limit)
    );
  }
  async applyReview(a: ApplyReviewArgs): Promise<ApplyReviewOutcome> {
    return this.tx((s) => {
      const r = s.requests.find((x) => x.id === a.requestId);
      if (!r || r.version !== a.expectedVersion) return { ok: false as const, currentVersion: r?.version ?? null };
      Object.assign(r, { current_fields_json: a.currentFieldsJson, review_status: a.reviewStatus, version: r.version + 1, updated_at: a.now });
      s.reviews.push(clone(a.review));
      this.audit(s, a.audit, true);
      return { ok: true as const, newVersion: a.expectedVersion + 1 };
    });
  }

  async appendAudit(audit: AuditDraft) {
    this.tx((s) => this.audit(s, audit, false));
  }
  async searchAudit(f: AuditFilter, offset: number, limit: number) {
    return clone(
      [...this.state.audit]
        .reverse()
        .filter((e) => (!f.actorEmail || e.actor_email === f.actorEmail) && (!f.action || e.action === f.action) && (!f.outcome || e.outcome === f.outcome) && (!f.correlationId || e.correlation_id === f.correlationId))
        .slice(offset, offset + limit)
    );
  }
  async readAuditFrom(fromSeq: number, limit: number) {
    return clone(this.state.audit.filter((e) => e.seq >= fromSeq).slice(0, limit));
  }

  async upsertAppConfig(row: AppConfigRow, audit: AuditDraft) {
    this.tx((s) => {
      s.configs = s.configs.filter((c) => c.id !== row.id).concat(clone(row));
      this.audit(s, audit, false);
    });
  }
  async upsertSamples(rows: SampleRow[], audit: AuditDraft) {
    return this.tx((s) => {
      const ids = new Set(rows.map((r) => r.id));
      s.samples = s.samples.filter((x) => !ids.has(x.id)).concat(clone(rows));
      this.audit(s, audit, false);
      return rows.length;
    });
  }
  async listSamples() {
    return clone(this.state.samples);
  }
  async getSample(id: string) {
    return clone(this.state.samples.find((s) => s.id === id) ?? null);
  }
  async schemaCheck(expected: Record<string, readonly string[]>): Promise<SchemaCheckRow[]> {
    return Object.keys(expected).map((table) => ({ table, present: true, missingColumns: [] }));
  }
  async close() {}
}
