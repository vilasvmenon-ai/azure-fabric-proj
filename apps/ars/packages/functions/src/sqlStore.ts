import { randomUUID } from 'node:crypto';

import sql from 'mssql';

import { buildAuditRow, GENESIS_HASH, type AuditContext, type AuditDraft, type AuditRow } from './audit.js';
import type { FaultInjection } from './config.js';
import { qualified, SERVER_ONLY_LOCK, TABLES } from './sqlNames.js';
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
} from './store.js';

/**
 * Store implementation for the app's own Rayfin SQL database, connected as the
 * Fabric App's application identity with the Rayfin-issued `ctx.Tokens.Sql`
 * token (docs: functions/connections/add-fabric-resource.md, "SQL databases").
 * All statements are parameterised.
 */
export type SqlConnectionAuth =
  /** Deployed and dev: Rayfin-issued app-identity token (ctx.Tokens.Sql). */
  | { kind: 'entraToken'; token: string }
  /** Local Docker stack only (environment 'local', enforced by config.ts). */
  | { kind: 'sqlLogin'; user: string; password: string; trustServerCertificate: boolean };

export interface SqlStoreOptions {
  server: string;
  port: number;
  database: string;
  schema: string;
  auth: SqlConnectionAuth;
  appId: string;
  auditContext: AuditContext;
  /** Dev-only fault injection (D-44). */
  fault: FaultInjection;
}

type Param = [name: string, type: sql.ISqlType | (() => sql.ISqlType), value: unknown];
type Executor = sql.ConnectionPool | sql.Transaction;

const NV = (n: number) => sql.NVarChar(n);
const UID = sql.UniqueIdentifier;
const DT = sql.DateTime2(7);

export class SqlStore implements Store {
  private constructor(
    private readonly pool: sql.ConnectionPool,
    private readonly opts: SqlStoreOptions
  ) {}

  static async connect(opts: SqlStoreOptions): Promise<SqlStore> {
    const auth = opts.auth;
    const pool = new sql.ConnectionPool({
      server: opts.server,
      port: opts.port,
      database: opts.database,
      options: { encrypt: true, trustServerCertificate: auth.kind === 'sqlLogin' && auth.trustServerCertificate },
      authentication:
        auth.kind === 'entraToken'
          ? { type: 'azure-active-directory-access-token', options: { token: auth.token } }
          : { type: 'default', options: { userName: auth.user, password: auth.password } },
      pool: { max: 2, min: 0, idleTimeoutMillis: 10_000 },
      connectionTimeout: 15_000,
      requestTimeout: 15_000,
    });
    await pool.connect();
    return new SqlStore(pool, opts);
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private t(name: keyof typeof TABLES): string {
    return qualified(this.opts.schema, TABLES[name]);
  }

  private async q<T = Record<string, unknown>>(exec: Executor, text: string, params: Param[] = []): Promise<sql.IResult<T>> {
    const request = new sql.Request(exec as sql.ConnectionPool);
    for (const [name, type, value] of params) request.input(name, type, value);
    return request.query<T>(text);
  }

  private async inTx<T>(work: (tx: sql.Transaction) => Promise<T>): Promise<T> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // The original error is the useful one.
      }
      throw err;
    }
  }

  /** Inserts one chained audit event inside `tx`. Any failure becomes AuditWriteError. */
  private async insertAudit(tx: sql.Transaction, draft: AuditDraft, injectable: boolean): Promise<void> {
    try {
      if (injectable && this.opts.fault === 'auditWrite') {
        throw new Error('Injected audit write failure (dev fault injection)');
      }
      const last = await this.q<{ seq: number; event_hash: string }>(
        tx,
        `SELECT TOP 1 seq, event_hash FROM ${this.t('AuditEvent')} WITH (UPDLOCK, HOLDLOCK) ORDER BY seq DESC`
      );
      const prev = last.recordset[0];
      const row = buildAuditRow(
        draft,
        this.opts.auditContext,
        prev ? prev.seq + 1 : 1,
        prev ? prev.event_hash : GENESIS_HASH,
        randomUUID(),
        new Date()
      );
      await this.q(
        tx,
        `INSERT INTO ${this.t('AuditEvent')}
          (id, seq, org_id, project_id, app_id, environment, actor_sub, actor_email, action, object_type, object_id,
           outcome, correlation_id, release_version, agent_ref, prompt_contract_version, details_json, prev_hash, event_hash,
           occurred_at, server_lock)
         VALUES (@id, @seq, @org_id, @project_id, @app_id, @environment, @actor_sub, @actor_email, @action, @object_type, @object_id,
           @outcome, @correlation_id, @release_version, @agent_ref, @prompt_contract_version, @details_json, @prev_hash, @event_hash,
           @occurred_at, @server_lock)`,
        [
          ['id', UID, row.id],
          ['seq', sql.Int, row.seq],
          ['org_id', NV(100), row.org_id],
          ['project_id', NV(100), row.project_id],
          ['app_id', NV(100), row.app_id],
          ['environment', NV(20), row.environment],
          ['actor_sub', NV(200), row.actor_sub],
          ['actor_email', NV(320), row.actor_email],
          ['action', NV(100), row.action],
          ['object_type', NV(50), row.object_type],
          ['object_id', NV(100), row.object_id],
          ['outcome', NV(20), row.outcome],
          ['correlation_id', NV(64), row.correlation_id],
          ['release_version', NV(50), row.release_version],
          ['agent_ref', NV(300), row.agent_ref],
          ['prompt_contract_version', NV(100), row.prompt_contract_version],
          ['details_json', NV(2000), row.details_json],
          ['prev_hash', NV(64), row.prev_hash],
          ['event_hash', NV(64), row.event_hash],
          ['occurred_at', DT, row.occurred_at],
          ['server_lock', NV(40), SERVER_ONLY_LOCK],
        ]
      );
    } catch (err) {
      throw new AuditWriteError(err instanceof Error ? err.message : 'Audit write failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Membership
  // ---------------------------------------------------------------------------

  private membershipSelect(): string {
    return `SELECT id, app_id, user_email, user_sub, role, status, reason, granted_by_email, granted_by_sub, granted_at,
                   revoked_by_email, revoked_at, updated_at FROM ${this.t('AppMembership')}`;
  }

  async listActiveMembershipsByEmail(email: string): Promise<MembershipRow[]> {
    const r = await this.q<MembershipRow>(this.pool, `${this.membershipSelect()} WHERE app_id = @app AND user_email = @email AND status = 'active'`, [
      ['app', NV(100), this.opts.appId],
      ['email', NV(320), email],
    ]);
    return r.recordset.map(normMembership);
  }

  async listMembershipsByEmail(email: string): Promise<MembershipRow[]> {
    const r = await this.q<MembershipRow>(this.pool, `${this.membershipSelect()} WHERE app_id = @app AND user_email = @email`, [
      ['app', NV(100), this.opts.appId],
      ['email', NV(320), email],
    ]);
    return r.recordset.map(normMembership);
  }

  async bindMembershipSub(ids: string[], sub: string, now: Date, audit: AuditDraft): Promise<void> {
    await this.inTx(async (tx) => {
      for (const id of ids) {
        await this.q(tx, `UPDATE ${this.t('AppMembership')} SET user_sub = @sub, updated_at = @now WHERE id = @id AND user_sub IS NULL`, [
          ['sub', NV(200), sub],
          ['now', DT, now],
          ['id', UID, id],
        ]);
      }
      await this.insertAudit(tx, audit, false);
    });
  }

  async countActiveAdmins(): Promise<number> {
    const r = await this.q<{ n: number }>(this.pool, `SELECT COUNT(*) AS n FROM ${this.t('AppMembership')} WHERE app_id = @app AND role = 'app_admin' AND status = 'active'`, [
      ['app', NV(100), this.opts.appId],
    ]);
    return r.recordset[0]?.n ?? 0;
  }

  async listMemberships(): Promise<MembershipRow[]> {
    const r = await this.q<MembershipRow>(this.pool, `${this.membershipSelect()} WHERE app_id = @app ORDER BY user_email, role, granted_at`, [
      ['app', NV(100), this.opts.appId],
    ]);
    return r.recordset.map(normMembership);
  }

  async getMembership(id: string): Promise<MembershipRow | null> {
    const r = await this.q<MembershipRow>(this.pool, `${this.membershipSelect()} WHERE app_id = @app AND id = @id`, [
      ['app', NV(100), this.opts.appId],
      ['id', UID, id],
    ]);
    return r.recordset[0] ? normMembership(r.recordset[0]) : null;
  }

  async insertMembership(row: MembershipRow, reactivateOwnerSub: string | null, audit: AuditDraft): Promise<void> {
    await this.inTx(async (tx) => {
      await this.q(
        tx,
        `INSERT INTO ${this.t('AppMembership')}
          (id, app_id, user_email, user_sub, role, status, reason, granted_by_email, granted_by_sub, granted_at, revoked_by_email, revoked_at, updated_at, server_lock)
         VALUES (@id, @app_id, @user_email, @user_sub, @role, @status, @reason, @granted_by_email, @granted_by_sub, @granted_at, NULL, NULL, @updated_at, @lock)`,
        [
          ['id', UID, row.id],
          ['app_id', NV(100), row.app_id],
          ['user_email', NV(320), row.user_email],
          ['user_sub', NV(200), row.user_sub],
          ['role', NV(30), row.role],
          ['status', NV(10), row.status],
          ['reason', NV(500), row.reason],
          ['granted_by_email', NV(320), row.granted_by_email],
          ['granted_by_sub', NV(200), row.granted_by_sub],
          ['granted_at', DT, row.granted_at],
          ['updated_at', DT, row.updated_at],
          ['lock', NV(40), SERVER_ONLY_LOCK],
        ]
      );
      if (reactivateOwnerSub) await this.setOwnerStatus(tx, reactivateOwnerSub, 'active', row.updated_at);
      await this.insertAudit(tx, audit, false);
    });
  }

  async revokeMembership(id: string, revokedByEmail: string, now: Date, revokeOwnerSub: string | null, audit: AuditDraft): Promise<void> {
    await this.inTx(async (tx) => {
      await this.q(
        tx,
        `UPDATE ${this.t('AppMembership')} SET status = 'revoked', revoked_by_email = @by, revoked_at = @now, updated_at = @now
         WHERE id = @id AND app_id = @app AND status = 'active'`,
        [
          ['by', NV(320), revokedByEmail],
          ['now', DT, now],
          ['id', UID, id],
          ['app', NV(100), this.opts.appId],
        ]
      );
      if (revokeOwnerSub) await this.setOwnerStatus(tx, revokeOwnerSub, 'revoked', now);
      await this.insertAudit(tx, audit, false);
    });
  }

  private async setOwnerStatus(tx: sql.Transaction, sub: string, status: 'active' | 'revoked', now: Date): Promise<void> {
    await this.q(tx, `UPDATE ${this.t('AddressRequest')} SET owner_status = @s, updated_at = @now WHERE app_id = @app AND creator_sub = @sub`, [
      ['s', NV(10), status],
      ['now', DT, now],
      ['app', NV(100), this.opts.appId],
      ['sub', NV(200), sub],
    ]);
    await this.q(tx, `UPDATE ${this.t('AddressResult')} SET owner_status = @s WHERE app_id = @app AND creator_sub = @sub`, [
      ['s', NV(10), status],
      ['app', NV(100), this.opts.appId],
      ['sub', NV(200), sub],
    ]);
  }

  // ---------------------------------------------------------------------------
  // Address requests
  // ---------------------------------------------------------------------------

  private requestSelect(): string {
    return `SELECT id, app_id, creator_sub, creator_email, client_request_id, request_key, original_address, input_sha256,
                   processing_status, review_status, decision, current_fields_json, version, owner_status, correlation_id,
                   error_code, created_at, updated_at FROM ${this.t('AddressRequest')}`;
  }

  async findRequestByKey(requestKey: string): Promise<RequestRow | null> {
    const r = await this.q<RequestRow>(this.pool, `${this.requestSelect()} WHERE app_id = @app AND request_key = @key`, [
      ['app', NV(100), this.opts.appId],
      ['key', NV(240), requestKey],
    ]);
    return r.recordset[0] ? normRequest(r.recordset[0]) : null;
  }

  async getRequest(id: string): Promise<RequestRow | null> {
    const r = await this.q<RequestRow>(this.pool, `${this.requestSelect()} WHERE app_id = @app AND id = @id`, [
      ['app', NV(100), this.opts.appId],
      ['id', UID, id],
    ]);
    return r.recordset[0] ? normRequest(r.recordset[0]) : null;
  }

  async insertRequest(row: RequestRow, audit: AuditDraft): Promise<void> {
    try {
      await this.inTx(async (tx) => {
        await this.q(
          tx,
          `INSERT INTO ${this.t('AddressRequest')}
            (id, app_id, creator_sub, creator_email, client_request_id, request_key, original_address, input_sha256,
             processing_status, review_status, decision, current_fields_json, version, owner_status, correlation_id, error_code, created_at, updated_at)
           VALUES (@id, @app_id, @creator_sub, @creator_email, @client_request_id, @request_key, @original_address, @input_sha256,
             @processing_status, @review_status, @decision, NULL, @version, @owner_status, @correlation_id, NULL, @created_at, @updated_at)`,
          [
            ['id', UID, row.id],
            ['app_id', NV(100), row.app_id],
            ['creator_sub', NV(200), row.creator_sub],
            ['creator_email', NV(320), row.creator_email],
            ['client_request_id', NV(36), row.client_request_id],
            ['request_key', NV(240), row.request_key],
            ['original_address', NV(2000), row.original_address],
            ['input_sha256', NV(64), row.input_sha256],
            ['processing_status', NV(30), row.processing_status],
            ['review_status', NV(30), row.review_status],
            ['decision', NV(30), row.decision],
            ['version', sql.Int, row.version],
            ['owner_status', NV(10), row.owner_status],
            ['correlation_id', NV(64), row.correlation_id],
            ['created_at', DT, row.created_at],
            ['updated_at', DT, row.updated_at],
          ]
        );
        await this.insertAudit(tx, audit, false);
      });
    } catch (err) {
      // 2627/2601: unique constraint / unique index violation.
      const n = (err as { number?: number; originalError?: { info?: { number?: number } } }).number;
      if (n === 2627 || n === 2601) throw new DuplicateKeyError();
      throw err;
    }
  }

  async claimForProcessing(id: string, from: RequestRow['processing_status'][], staleBefore: Date, now: Date): Promise<boolean> {
    const names = from.map((_, i) => `@s${i}`).join(', ');
    const params: Param[] = from.map((s, i) => [`s${i}`, NV(30), s] as Param);
    const r = await this.q(
      this.pool,
      `UPDATE ${this.t('AddressRequest')} SET processing_status = 'PROCESSING', error_code = NULL, updated_at = @now
       WHERE id = @id AND app_id = @app AND (processing_status IN (${names}) OR (processing_status = 'PROCESSING' AND updated_at < @stale))`,
      [...params, ['now', DT, now], ['id', UID, id], ['app', NV(100), this.opts.appId], ['stale', DT, staleBefore]]
    );
    return (r.rowsAffected[0] ?? 0) === 1;
  }

  async completeProcessing(args: CompleteProcessingArgs): Promise<void> {
    const { result: res } = args;
    await this.inTx(async (tx) => {
      if (this.opts.fault === 'storageWrite') {
        throw new Error('Injected storage write failure (dev fault injection)');
      }
      await this.q(
        tx,
        `INSERT INTO ${this.t('AddressResult')}
          (id, request_id, app_id, creator_sub, owner_status, validation_outcome, validation_errors_json, fields_json, evidence_json,
           notes_json, decision, agent_name, agent_version_label, prompt_contract_version, response_id, model, raw_output_sha256,
           raw_output_excerpt, ai_latency_ms, processing_ms, usage_json, created_at)
         VALUES (@id, @request_id, @app_id, @creator_sub, @owner_status, @validation_outcome, @validation_errors_json, @fields_json, @evidence_json,
           @notes_json, @decision, @agent_name, @agent_version_label, @prompt_contract_version, @response_id, @model, @raw_output_sha256,
           @raw_output_excerpt, @ai_latency_ms, @processing_ms, @usage_json, @created_at)`,
        [
          ['id', UID, res.id],
          ['request_id', UID, res.request_id],
          ['app_id', NV(100), res.app_id],
          ['creator_sub', NV(200), res.creator_sub],
          ['owner_status', NV(10), res.owner_status],
          ['validation_outcome', NV(10), res.validation_outcome],
          ['validation_errors_json', NV(2000), res.validation_errors_json],
          ['fields_json', NV(2000), res.fields_json],
          ['evidence_json', NV(2000), res.evidence_json],
          ['notes_json', NV(4000), res.notes_json],
          ['decision', NV(30), res.decision],
          ['agent_name', NV(200), res.agent_name],
          ['agent_version_label', NV(50), res.agent_version_label],
          ['prompt_contract_version', NV(100), res.prompt_contract_version],
          ['response_id', NV(200), res.response_id],
          ['model', NV(200), res.model],
          ['raw_output_sha256', NV(64), res.raw_output_sha256],
          ['raw_output_excerpt', NV(4000), res.raw_output_excerpt],
          ['ai_latency_ms', sql.Int, res.ai_latency_ms],
          ['processing_ms', sql.Int, res.processing_ms],
          ['usage_json', NV(500), res.usage_json],
          ['created_at', DT, res.created_at],
        ]
      );
      const upd = await this.q(
        tx,
        `UPDATE ${this.t('AddressRequest')}
           SET processing_status = @ps, decision = @decision, current_fields_json = @cf, review_status = 'PENDING',
               version = version + 1, error_code = NULL, updated_at = @now
         WHERE id = @id AND app_id = @app AND processing_status = 'PROCESSING'`,
        [
          ['ps', NV(30), args.processingStatus],
          ['decision', NV(30), args.decision],
          ['cf', NV(2000), args.currentFieldsJson],
          ['now', DT, args.now],
          ['id', UID, args.requestId],
          ['app', NV(100), this.opts.appId],
        ]
      );
      if ((upd.rowsAffected[0] ?? 0) !== 1) {
        throw new Error('Request is no longer in PROCESSING state');
      }
      await this.insertAudit(tx, args.audit, true);
    });
  }

  async failProcessing(id: string, status: RequestRow['processing_status'], errorCode: string, now: Date, audit: AuditDraft | null): Promise<void> {
    await this.inTx(async (tx) => {
      await this.q(tx, `UPDATE ${this.t('AddressRequest')} SET processing_status = @s, error_code = @code, updated_at = @now WHERE id = @id AND app_id = @app`, [
        ['s', NV(30), status],
        ['code', NV(40), errorCode],
        ['now', DT, now],
        ['id', UID, id],
        ['app', NV(100), this.opts.appId],
      ]);
      if (audit) await this.insertAudit(tx, audit, false);
    });
  }

  async getLatestResult(requestId: string): Promise<ResultRow | null> {
    const r = await this.q<ResultRow>(
      this.pool,
      `SELECT TOP 1 id, request_id, app_id, creator_sub, owner_status, validation_outcome, validation_errors_json, fields_json,
              evidence_json, notes_json, decision, agent_name, agent_version_label, prompt_contract_version, response_id, model,
              raw_output_sha256, raw_output_excerpt, ai_latency_ms, processing_ms, usage_json, created_at
       FROM ${this.t('AddressResult')} WHERE app_id = @app AND request_id = @rid ORDER BY created_at DESC`,
      [
        ['app', NV(100), this.opts.appId],
        ['rid', UID, requestId],
      ]
    );
    return r.recordset[0] ? normResult(r.recordset[0]) : null;
  }

  async listReviews(requestId: string): Promise<ReviewRow[]> {
    const r = await this.q<ReviewRow>(
      this.pool,
      `SELECT id, request_id, app_id, reviewer_sub, reviewer_email, decision, comments, changed_fields_json, record_version, created_at
       FROM ${this.t('ReviewHistory')} WHERE app_id = @app AND request_id = @rid ORDER BY record_version ASC, created_at ASC`,
      [
        ['app', NV(100), this.opts.appId],
        ['rid', UID, requestId],
      ]
    );
    return r.recordset.map((row) => ({ ...row, id: lc(row.id), request_id: lc(row.request_id) }));
  }

  async listRequests(filter: RequestFilter, offset: number, limit: number): Promise<RequestRow[]> {
    const where = ['app_id = @app'];
    const params: Param[] = [['app', NV(100), this.opts.appId]];
    if (filter.creatorSub) {
      where.push('creator_sub = @sub');
      params.push(['sub', NV(200), filter.creatorSub]);
    }
    if (filter.processingStatus) {
      where.push('processing_status = @ps');
      params.push(['ps', NV(30), filter.processingStatus]);
    }
    if (filter.reviewStatus) {
      where.push('review_status = @rs');
      params.push(['rs', NV(30), filter.reviewStatus]);
    }
    params.push(['offset', sql.Int, offset], ['limit', sql.Int, limit]);
    const r = await this.q<RequestRow>(
      this.pool,
      `${this.requestSelect()} WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      params
    );
    return r.recordset.map(normRequest);
  }

  async applyReview(args: ApplyReviewArgs): Promise<ApplyReviewOutcome> {
    return this.inTx(async (tx) => {
      const upd = await this.q(
        tx,
        `UPDATE ${this.t('AddressRequest')}
           SET current_fields_json = @cf, review_status = @rs, version = version + 1, updated_at = @now
         WHERE id = @id AND app_id = @app AND version = @expected`,
        [
          ['cf', NV(2000), args.currentFieldsJson],
          ['rs', NV(30), args.reviewStatus],
          ['now', DT, args.now],
          ['id', UID, args.requestId],
          ['app', NV(100), this.opts.appId],
          ['expected', sql.Int, args.expectedVersion],
        ]
      );
      if ((upd.rowsAffected[0] ?? 0) !== 1) {
        const cur = await this.q<{ version: number }>(tx, `SELECT version FROM ${this.t('AddressRequest')} WHERE id = @id AND app_id = @app`, [
          ['id', UID, args.requestId],
          ['app', NV(100), this.opts.appId],
        ]);
        return { ok: false as const, currentVersion: cur.recordset[0]?.version ?? null };
      }
      const rv = args.review;
      await this.q(
        tx,
        `INSERT INTO ${this.t('ReviewHistory')}
          (id, request_id, app_id, reviewer_sub, reviewer_email, decision, comments, changed_fields_json, record_version, created_at, server_lock)
         VALUES (@id, @rid, @app, @sub, @email, @decision, @comments, @changed, @ver, @at, @lock)`,
        [
          ['id', UID, rv.id],
          ['rid', UID, rv.request_id],
          ['app', NV(100), rv.app_id],
          ['sub', NV(200), rv.reviewer_sub],
          ['email', NV(320), rv.reviewer_email],
          ['decision', NV(30), rv.decision],
          ['comments', NV(2000), rv.comments],
          ['changed', NV(2000), rv.changed_fields_json],
          ['ver', sql.Int, rv.record_version],
          ['at', DT, rv.created_at],
          ['lock', NV(40), SERVER_ONLY_LOCK],
        ]
      );
      await this.insertAudit(tx, args.audit, true);
      return { ok: true as const, newVersion: args.expectedVersion + 1 };
    });
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  async appendAudit(audit: AuditDraft): Promise<void> {
    await this.inTx((tx) => this.insertAudit(tx, audit, false));
  }

  private auditSelect(): string {
    return `SELECT id, seq, org_id, project_id, app_id, environment, actor_sub, actor_email, action, object_type, object_id, outcome,
                   correlation_id, release_version, agent_ref, prompt_contract_version, details_json, prev_hash, event_hash, occurred_at
            FROM ${this.t('AuditEvent')}`;
  }

  async searchAudit(filter: AuditFilter, offset: number, limit: number): Promise<AuditRow[]> {
    const where: string[] = ['1 = 1'];
    const params: Param[] = [];
    if (filter.actorEmail) {
      where.push('actor_email = @actor');
      params.push(['actor', NV(320), filter.actorEmail]);
    }
    if (filter.action) {
      where.push('action = @action');
      params.push(['action', NV(100), filter.action]);
    }
    if (filter.outcome) {
      where.push('outcome = @outcome');
      params.push(['outcome', NV(20), filter.outcome]);
    }
    if (filter.correlationId) {
      where.push('correlation_id = @cid');
      params.push(['cid', NV(64), filter.correlationId]);
    }
    if (filter.fromUtc) {
      where.push('occurred_at >= @from');
      params.push(['from', DT, filter.fromUtc]);
    }
    if (filter.toUtc) {
      where.push('occurred_at < @to');
      params.push(['to', DT, filter.toUtc]);
    }
    params.push(['offset', sql.Int, offset], ['limit', sql.Int, limit]);
    const r = await this.q<AuditRow>(
      this.pool,
      `${this.auditSelect()} WHERE ${where.join(' AND ')} ORDER BY seq DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      params
    );
    return r.recordset.map(normAudit);
  }

  async readAuditFrom(fromSeq: number, limit: number): Promise<AuditRow[]> {
    const r = await this.q<AuditRow>(this.pool, `${this.auditSelect()} WHERE seq >= @from ORDER BY seq ASC OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`, [
      ['from', sql.Int, fromSeq],
      ['limit', sql.Int, limit],
    ]);
    return r.recordset.map(normAudit);
  }

  // ---------------------------------------------------------------------------
  // Configuration and seed data
  // ---------------------------------------------------------------------------

  async upsertAppConfig(row: AppConfigRow, audit: AuditDraft): Promise<void> {
    await this.inTx(async (tx) => {
      const params: Param[] = [
        ['id', UID, row.id],
        ['org', NV(100), row.org_id],
        ['proj', NV(100), row.project_id],
        ['app', NV(100), row.app_id],
        ['env', NV(10), row.environment],
        ['ai', NV(2000), row.allowed_ai_config_json],
        ['ver', NV(50), row.active_version],
        ['owner', NV(320), row.owner_email],
        ['at', DT, row.updated_at],
        ['lock', NV(40), SERVER_ONLY_LOCK],
      ];
      const upd = await this.q(
        tx,
        `UPDATE ${this.t('AppConfig')} SET org_id=@org, project_id=@proj, app_id=@app, environment=@env, allowed_ai_config_json=@ai,
           active_version=@ver, owner_email=@owner, updated_at=@at WHERE id=@id`,
        params
      );
      if ((upd.rowsAffected[0] ?? 0) === 0) {
        await this.q(
          tx,
          `INSERT INTO ${this.t('AppConfig')} (id, org_id, project_id, app_id, environment, allowed_ai_config_json, active_version, owner_email, server_lock, updated_at)
           VALUES (@id, @org, @proj, @app, @env, @ai, @ver, @owner, @lock, @at)`,
          params
        );
      }
      await this.insertAudit(tx, audit, false);
    });
  }

  async upsertSamples(rows: SampleRow[], audit: AuditDraft): Promise<number> {
    return this.inTx(async (tx) => {
      for (const s of rows) {
        const params: Param[] = [
          ['id', UID, s.id],
          ['app', NV(100), s.app_id],
          ['label', NV(200), s.label],
          ['address', NV(2000), s.address],
          ['expected', NV(1000), s.expected_json],
          ['ord', sql.Int, s.sort_order],
        ];
        const upd = await this.q(
          tx,
          `UPDATE ${this.t('SampleAddress')} SET app_id=@app, label=@label, address=@address, expected_json=@expected, sort_order=@ord WHERE id=@id`,
          params
        );
        if ((upd.rowsAffected[0] ?? 0) === 0) {
          await this.q(
            tx,
            `INSERT INTO ${this.t('SampleAddress')} (id, app_id, label, address, expected_json, sort_order) VALUES (@id, @app, @label, @address, @expected, @ord)`,
            params
          );
        }
      }
      await this.insertAudit(tx, audit, false);
      return rows.length;
    });
  }

  async listSamples(): Promise<SampleRow[]> {
    const r = await this.q<SampleRow>(this.pool, `SELECT id, app_id, label, address, expected_json, sort_order FROM ${this.t('SampleAddress')} WHERE app_id = @app ORDER BY sort_order`, [
      ['app', NV(100), this.opts.appId],
    ]);
    return r.recordset.map((s) => ({ ...s, id: lc(s.id) }));
  }

  async getSample(id: string): Promise<SampleRow | null> {
    const r = await this.q<SampleRow>(this.pool, `SELECT id, app_id, label, address, expected_json, sort_order FROM ${this.t('SampleAddress')} WHERE app_id = @app AND id = @id`, [
      ['app', NV(100), this.opts.appId],
      ['id', UID, id],
    ]);
    return r.recordset[0] ? { ...r.recordset[0], id: lc(r.recordset[0].id) } : null;
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  async schemaCheck(expected: Record<string, readonly string[]>): Promise<SchemaCheckRow[]> {
    const r = await this.q<{ TABLE_NAME: string; COLUMN_NAME: string }>(
      this.pool,
      `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema`,
      [['schema', NV(128), this.opts.schema]]
    );
    const actual = new Map<string, Set<string>>();
    for (const row of r.recordset) {
      const set = actual.get(row.TABLE_NAME) ?? new Set<string>();
      set.add(row.COLUMN_NAME);
      actual.set(row.TABLE_NAME, set);
    }
    return Object.entries(expected).map(([entity, columns]) => {
      const table = TABLES[entity as keyof typeof TABLES] ?? entity;
      const present = actual.get(table);
      return {
        table,
        present: Boolean(present),
        missingColumns: present ? columns.filter((c) => !present.has(c)) : [...columns],
      };
    });
  }
}

// mssql returns UNIQUEIDENTIFIER values in upper case; the app uses lower case.
const lc = (v: string | null): string => (v ?? '').toLowerCase();

function normMembership(r: MembershipRow): MembershipRow {
  return { ...r, id: lc(r.id) };
}

function normRequest(r: RequestRow): RequestRow {
  return { ...r, id: lc(r.id) };
}

function normResult(r: ResultRow): ResultRow {
  return { ...r, id: lc(r.id), request_id: lc(r.request_id) };
}

function normAudit(r: AuditRow): AuditRow {
  return { ...r, id: lc(r.id) };
}
