import type {
  AddressFieldName,
  AddressFields,
  CheckResult,
  ExtractionDecision,
} from '@rayfin-app/shared';

/**
 * The existing Foundry agent's request/response contract, preserved from the
 * supplied reference integration (ReferenceCode/address-structuring-lab,
 * service.py + agent_instructions.txt). The agent itself is not modified;
 * this module only builds its input and validates its output (AI-04, DEL-05).
 */
export const PROMPT_CONTRACT_VERSION = 'ars-reference-v3:fields-evidence-notes';

export const FIELD_NAMES: readonly AddressFieldName[] = [
  'building',
  'street',
  'town',
  'region',
  'postcode',
  'country',
];

/** Supported countries and accepted aliases, mirroring the agent instructions. */
export const COUNTRIES: Record<string, readonly string[]> = {
  IN: ['India', 'IN'],
  AE: ['United Arab Emirates', 'UAE', 'AE'],
  NL: ['Netherlands', 'NL'],
  GB: ['United Kingdom', 'UK', 'Great Britain', 'GB'],
  US: ['United States', 'United States of America', 'USA', 'US'],
};

export const MAX_ADDRESS_LENGTH = 2000;
export const MAX_RAW_OUTPUT_LENGTH = 16_000;

/**
 * Python `json.dumps` string encoding with its defaults (ensure_ascii=True),
 * so the request text is byte-for-byte what the reference sent.
 */
export function pythonJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/** Exactly the reference's input: 'Extract components from this address data:\n' + json.dumps({'address': address}). */
export function buildAgentInput(address: string): string {
  return 'Extract components from this address data:\n' + `{"address": ${pythonJsonString(address)}}`;
}

export interface AgentOutput {
  fields: AddressFields;
  evidence: AddressFields;
  notes: string[];
}

export type ParseOutcome =
  | { ok: true; value: AgentOutput }
  | { ok: false; errors: string[]; partial: Partial<AgentOutput> | null };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = (needle: string, haystack: string) =>
  new RegExp(`(?<!\\w)${escapeRe(needle)}(?!\\w)`, 'u').test(haystack);

function sameKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

/**
 * Port of the reference `parse_result` rules. Returns every structural problem
 * it can find rather than stopping at the first, so reviewers see why output
 * was flagged.
 */
export function parseAgentOutput(raw: unknown, address: string): ParseOutcome {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_RAW_OUTPUT_LENGTH) {
    return { ok: false, errors: ['The agent returned an empty or oversized response.'], partial: null };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['The agent did not return valid JSON.'], partial: null };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !sameKeys(data as Record<string, unknown>, ['fields', 'evidence', 'notes'])) {
    return { ok: false, errors: ['The agent response does not match the JSON contract (fields, evidence, notes).'], partial: null };
  }
  const obj = data as Record<string, unknown>;
  const errors: string[] = [];

  for (const section of ['fields', 'evidence'] as const) {
    const value = obj[section];
    if (!value || typeof value !== 'object' || Array.isArray(value) || !sameKeys(value as Record<string, unknown>, FIELD_NAMES)) {
      errors.push(`The agent returned invalid ${section}.`);
      continue;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null && (typeof v !== 'string' || !v.trim() || v.length > 2000)) {
        errors.push(`The agent returned an invalid value in ${section}.${k}.`);
      }
    }
  }
  const notes = obj.notes;
  if (!Array.isArray(notes) || notes.length > 20 || notes.some((n) => typeof n !== 'string' || n.length > 1000)) {
    errors.push('The agent returned invalid notes.');
  }
  if (errors.length) {
    return { ok: false, errors, partial: null };
  }

  const fields = obj.fields as AddressFields;
  const evidence = obj.evidence as AddressFields;
  for (const name of FIELD_NAMES) {
    const value = fields[name];
    const ev = evidence[name];
    if (value === null) {
      if (ev !== null) errors.push(`${name}: null fields must have null evidence.`);
      continue;
    }
    if (!ev || !address.includes(ev)) {
      errors.push(`${name}: supporting text was not found in the input.`);
      continue;
    }
    if (name === 'country') {
      const aliases = COUNTRIES[value];
      if (!aliases || !aliases.some((a) => a.toLowerCase() === ev.toLowerCase())) {
        errors.push('country: value does not match an explicitly supported country name/code.');
      } else if (!wholeWord(ev, address)) {
        errors.push('country: evidence must be a complete name or code.');
      }
    } else if (value !== ev) {
      errors.push(`${name}: only values copied from the input are accepted.`);
    }
  }
  const value: AgentOutput = { fields, evidence, notes: notes as string[] };
  return errors.length ? { ok: false, errors, partial: value } : { ok: true, value };
}

/** Local application checks (not ARS rules): town and supported country present. */
export function evaluateChecks(fields: AddressFields | null): { decision: ExtractionDecision; checks: CheckResult[] } {
  if (!fields) {
    return { decision: 'NONE', checks: [] };
  }
  const checks: CheckResult[] = [
    { name: 'Town supplied', passed: Boolean(fields.town) },
    { name: 'Supported country explicitly supplied', passed: Boolean(fields.country) },
    { name: 'Extracted values supported by input text', passed: true },
  ];
  const missing = !fields.town || !fields.country;
  return { decision: missing ? 'NEEDS_REVIEW' : 'FIELDS_PRESENT', checks };
}

/** Validate reviewer field edits: known fields, bounded strings, supported country codes. */
export function validateFieldEdits(edits: unknown): { ok: true; value: Partial<AddressFields> } | { ok: false; errors: Record<string, string> } {
  if (edits === undefined || edits === null) return { ok: true, value: {} };
  if (typeof edits !== 'object' || Array.isArray(edits)) return { ok: false, errors: { fieldEdits: 'Must be an object.' } };
  const errors: Record<string, string> = {};
  const value: Partial<AddressFields> = {};
  for (const [key, v] of Object.entries(edits as Record<string, unknown>)) {
    if (!FIELD_NAMES.includes(key as AddressFieldName)) {
      errors[key] = 'Unknown field.';
      continue;
    }
    if (v === null || v === '') {
      value[key as AddressFieldName] = null;
      continue;
    }
    if (typeof v !== 'string' || v.trim().length > 200) {
      errors[key] = 'Must be text of at most 200 characters, or empty.';
      continue;
    }
    if (key === 'country' && !COUNTRIES[v.trim()]) {
      errors[key] = `Use one of ${Object.keys(COUNTRIES).join(', ')}.`;
      continue;
    }
    value[key as AddressFieldName] = v.trim();
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}
