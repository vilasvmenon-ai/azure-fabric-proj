/**
 * Server-side adapter for the EXISTING Foundry prompt agent (AI-01..AI-05).
 *
 * Invokes the agent by name through the Foundry (new) Agents API:
 *   POST {projectEndpoint}/agents/{agentName}/endpoint/protocols/openai/responses?api-version=v1
 * with the Rayfin-issued application token from `ctx.Tokens.AzureAI`.
 * The request uses `store: false` and no conversation, so no state is shared
 * between users or requests. Nothing here creates, updates or deletes agents.
 */

export interface FoundryCallConfig {
  projectEndpoint: string;
  agentName: string;
  apiVersion: string;
  timeoutMs: number;
  maxRetries: number;
  totalBudgetMs: number;
}

export interface FoundryInvokeResult {
  outputText: string;
  responseId: string | null;
  model: string | null;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  latencyMs: number;
  attempts: number;
}

export type FoundryFailureKind =
  | 'timeout'
  | 'throttled'
  | 'unavailable'
  | 'auth'
  | 'not_found'
  | 'bad_request'
  | 'incomplete'
  | 'bad_response';

export class FoundryError extends Error {
  constructor(
    readonly kind: FoundryFailureKind,
    readonly status: number | null,
    readonly attempts: number
  ) {
    super(`Foundry call failed (${kind}${status ? ` ${status}` : ''})`);
    this.name = 'FoundryError';
  }
}

export interface FoundryDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function agentResponsesUrl(cfg: Pick<FoundryCallConfig, 'projectEndpoint' | 'agentName' | 'apiVersion'>): string {
  const base = cfg.projectEndpoint.replace(/\/$/, '');
  return `${base}/agents/${encodeURIComponent(cfg.agentName)}/endpoint/protocols/openai/responses?api-version=${encodeURIComponent(cfg.apiVersion)}`;
}

/** Extract the assistant text from a Responses API payload. */
export function extractOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.output_text === 'string') return p.output_text;
  if (!Array.isArray(p.output)) return null;
  const parts: string[] = [];
  for (const item of p.output) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it.type !== 'message' || !Array.isArray(it.content)) continue;
    for (const c of it.content) {
      if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'output_text') {
        const text = (c as Record<string, unknown>).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  return parts.length ? parts.join('') : null;
}

const RETRYABLE = new Set<FoundryFailureKind>(['timeout', 'throttled', 'unavailable']);

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 20_000) : 2_000;
}

export async function invokeAgent(
  cfg: FoundryCallConfig,
  token: string,
  inputText: string,
  deps: FoundryDeps = {}
): Promise<FoundryInvokeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const url = agentResponsesUrl(cfg);
  const body = JSON.stringify({
    input: [{ role: 'user', content: inputText }],
    store: false,
  });

  let attempt = 0;
  for (;;) {
    attempt++;
    const remaining = cfg.totalBudgetMs - (now() - started);
    const perAttempt = Math.min(cfg.timeoutMs, remaining);
    if (perAttempt <= 0) throw new FoundryError('timeout', null, attempt - 1);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perAttempt);
    let kind: FoundryFailureKind;
    let status: number | null = null;
    let wait = 2_000;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      status = res.status;
      if (res.ok) {
        let payload: unknown;
        try {
          payload = await res.json();
        } catch {
          throw new FoundryError('bad_response', status, attempt);
        }
        const p = payload as Record<string, unknown>;
        if (p.status !== undefined && p.status !== null && p.status !== 'completed') {
          throw new FoundryError('incomplete', status, attempt);
        }
        const text = extractOutputText(payload);
        if (text === null) throw new FoundryError('bad_response', status, attempt);
        const usage = p.usage && typeof p.usage === 'object' ? (p.usage as Record<string, unknown>) : null;
        return {
          outputText: text,
          responseId: typeof p.id === 'string' ? p.id : null,
          model: typeof p.model === 'string' ? p.model : null,
          usage: usage
            ? {
                inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
                outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
                totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
              }
            : null,
          latencyMs: now() - started,
          attempts: attempt,
        };
      }
      if (status === 429) {
        kind = 'throttled';
        wait = retryAfterMs(res);
      } else if (status === 401 || status === 403) kind = 'auth';
      else if (status === 404) kind = 'not_found';
      else if (status >= 500) kind = 'unavailable';
      else kind = 'bad_request';
    } catch (err) {
      if (err instanceof FoundryError) throw err;
      kind = controller.signal.aborted ? 'timeout' : 'unavailable';
    } finally {
      clearTimeout(timer);
    }

    const canRetry = RETRYABLE.has(kind) && attempt <= cfg.maxRetries;
    const budgetLeft = cfg.totalBudgetMs - (now() - started);
    if (!canRetry || budgetLeft <= wait + 1_000) {
      throw new FoundryError(kind, status, attempt);
    }
    await sleep(wait);
  }
}
