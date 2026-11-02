import type { AddressFields } from '@rayfin-app/shared';

import { COUNTRIES } from '../src/contract.js';
import type { RuntimeConfig } from '../src/config.js';

/** Build the agent output the existing agent is expected to return for a sample. */
export function agentOutputFor(address: string, expected: AddressFields, notes: string[] = []): string {
  const evidence: AddressFields = { ...expected };
  if (expected.country) {
    const aliases = [...COUNTRIES[expected.country]].sort((a, b) => b.length - a.length);
    evidence.country = aliases.find((a) => new RegExp(`(?<!\\w)${a}(?!\\w)`).test(address)) ?? null;
  }
  return JSON.stringify({ fields: expected, evidence, notes });
}

export function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    orgId: 'ionova',
    projectId: 'ai-lab',
    appId: 'ars',
    appName: 'Address Structuring Lab',
    environment: 'dev',
    release: '1.0.0-test',
    ownerEmail: 'owner@ionova.test',
    foundry: {
      projectEndpoint: 'https://example-resource.services.ai.azure.com/api/projects/address-lab',
      agentName: 'address-structuring-lab',
      agentVersionLabel: null,
      apiVersion: 'v1',
      timeoutMs: 60_000,
      maxRetries: 1,
      totalBudgetMs: 150_000,
      auth: 'servicePrincipal',
      servicePrincipal: { tenantId: '26919914-5baa-4bb7-b4c8-c39efb7fa94e', clientId: '11111111-2222-4333-8444-555555555555' },
    },
    sql: { server: 'example.database.fabric.microsoft.com', port: 1433, database: 'db', schema: 'dbo', auth: 'entraToken', user: null, trustServerCertificate: false },
    bootstrapAdminEmails: ['admin@ionova.test'],
    superUserEmails: ['admin@ionova.test'],
    faultInjection: 'none',
    ...overrides,
  };
}
