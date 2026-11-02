import { describe, expect, it, vi } from 'vitest';

import { agentResponsesUrl, extractOutputText, FoundryError, invokeAgent, type FoundryCallConfig } from '../src/foundry.js';

const cfg: FoundryCallConfig = {
  projectEndpoint: 'https://res.services.ai.azure.com/api/projects/address-lab',
  agentName: 'address-structuring-lab',
  apiVersion: 'v1',
  timeoutMs: 1000,
  maxRetries: 1,
  totalBudgetMs: 10_000,
};

const okBody = {
  id: 'resp_1',
  model: 'gpt-5-mini',
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('Foundry agent adapter', () => {
  it('builds the documented agent endpoint URL', () => {
    expect(agentResponsesUrl(cfg)).toBe(
      'https://res.services.ai.azure.com/api/projects/address-lab/agents/address-structuring-lab/endpoint/protocols/openai/responses?api-version=v1'
    );
  });

  it('sends a bearer token, store:false and no conversation; parses output and usage', async () => {
    const fetchImpl = vi.fn(async () => json(200, okBody));
    const r = await invokeAgent(cfg, 'tok', 'hello', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ outputText: '{"a":1}', responseId: 'resp_1', model: 'gpt-5-mini', attempts: 1, usage: { totalTokens: 15 } });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ input: [{ role: 'user', content: 'hello' }], store: false });
    expect(body.conversation).toBeUndefined();
  });

  it('retries once on 429 honouring Retry-After, then succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(429, {}, { 'retry-after': '1' })).mockResolvedValueOnce(json(200, okBody));
    const r = await invokeAgent(cfg, 't', 'x', { fetchImpl, sleep });
    expect(r.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('does not retry auth failures', async () => {
    const fetchImpl = vi.fn(async () => json(403, {}));
    await expect(invokeAgent(cfg, 't', 'x', { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'auth', status: 403, attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops after the bounded retry on 5xx', async () => {
    const fetchImpl = vi.fn(async () => json(503, {}));
    await expect(invokeAgent(cfg, 't', 'x', { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => undefined })).rejects.toMatchObject({ kind: 'unavailable', attempts: 2 });
  });

  it('reports a timeout when the call is aborted', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    );
    const err = await invokeAgent({ ...cfg, timeoutMs: 5, maxRetries: 0 }, 't', 'x', { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(FoundryError);
    expect(err.kind).toBe('timeout');
  });

  it('treats non-completed responses as incomplete', async () => {
    const fetchImpl = vi.fn(async () => json(200, { ...okBody, status: 'incomplete' }));
    await expect(invokeAgent(cfg, 't', 'x', { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'incomplete' });
  });

  it('extracts output_text from either the convenience field or the output array', () => {
    expect(extractOutputText({ output_text: 'a' })).toBe('a');
    expect(extractOutputText(okBody)).toBe('{"a":1}');
    expect(extractOutputText({ output: [] })).toBeNull();
  });
});
