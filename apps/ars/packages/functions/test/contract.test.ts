import { describe, expect, it } from 'vitest';

import { buildAgentInput, evaluateChecks, parseAgentOutput, pythonJsonString, validateFieldEdits } from '../src/contract.js';
import { SAMPLES } from '../src/samples.js';
import { agentOutputFor } from './helpers.js';

describe('agent input (reference parity)', () => {
  it('matches Python json.dumps with ensure_ascii for quotes, newlines and non-ASCII', () => {
    // Python: json.dumps({'address': 'Café "x"\n—'}) == '{"address": "Caf\\u00e9 \\"x\\"\\n\\u2014"}'
    expect(`{"address": ${pythonJsonString('Café "x"\n—')}}`).toBe('{"address": "Caf\\u00e9 \\"x\\"\\n\\u2014"}');
  });

  it('prefixes the instruction exactly as the reference service did', () => {
    expect(buildAgentInput('17 Lotus Lane, India')).toBe('Extract components from this address data:\n{"address": "17 Lotus Lane, India"}');
  });
});

describe('agent output validation', () => {
  it.each(SAMPLES.map((s) => [s.key, s] as const))('accepts the expected mapping for sample %s', (_key, sample) => {
    const outcome = parseAgentOutput(agentOutputFor(sample.address, sample.expected), sample.address);
    expect(outcome.ok).toBe(true);
  });

  it('rejects non-JSON and oversized output', () => {
    expect(parseAgentOutput('not json', 'x').ok).toBe(false);
    expect(parseAgentOutput('x'.repeat(16_001), 'x').ok).toBe(false);
    expect(parseAgentOutput(undefined, 'x').ok).toBe(false);
  });

  it('rejects missing or extra keys', () => {
    const addr = '17 Lotus Lane, India';
    expect(parseAgentOutput(JSON.stringify({ fields: {}, evidence: {} }), addr).ok).toBe(false);
    const good = JSON.parse(agentOutputFor(addr, SAMPLES[4].expected));
    good.extra = 1;
    expect(parseAgentOutput(JSON.stringify(good), addr).ok).toBe(false);
  });

  it('rejects values that are not copied from the input', () => {
    const s = SAMPLES[0];
    const out = JSON.parse(agentOutputFor(s.address, s.expected));
    out.fields.town = 'Mumbai';
    out.evidence.town = 'Mumbai';
    const r = parseAgentOutput(JSON.stringify(out), s.address);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/town/);
  });

  it('rejects an inferred country (the missing-country sample must stay null)', () => {
    const s = SAMPLES.find((x) => x.key === 'missing-country')!;
    const out = JSON.parse(agentOutputFor(s.address, s.expected));
    out.fields.country = 'IN';
    out.evidence.country = 'IN';
    expect(parseAgentOutput(JSON.stringify(out), s.address).ok).toBe(false);
  });

  it('cannot catch the embedded-instruction case by text evidence alone (evaluation must)', () => {
    const s = SAMPLES.find((x) => x.key === 'injection')!;
    const out = JSON.parse(agentOutputFor(s.address, s.expected));
    out.fields.country = 'US';
    out.evidence.country = 'US';
    // "US" appears as a whole word in the injected sentence, so this passes text
    // evidence; the evaluation (expected IN) is what flags it. Mirrors the reference note.
    const r = parseAgentOutput(JSON.stringify(out), s.address);
    expect(r.ok).toBe(true);
  });

  it('rejects null field with non-null evidence', () => {
    const s = SAMPLES[4];
    const out = JSON.parse(agentOutputFor(s.address, s.expected));
    out.evidence.town = 'India';
    expect(parseAgentOutput(JSON.stringify(out), s.address).ok).toBe(false);
  });

  it('derives NEEDS_REVIEW when town or country is missing', () => {
    expect(evaluateChecks(SAMPLES[0].expected).decision).toBe('FIELDS_PRESENT');
    expect(evaluateChecks(SAMPLES[3].expected).decision).toBe('NEEDS_REVIEW');
    expect(evaluateChecks(SAMPLES[4].expected).decision).toBe('NEEDS_REVIEW');
    expect(evaluateChecks(null).decision).toBe('NONE');
  });
});

describe('reviewer field edits', () => {
  it('accepts known fields and supported countries', () => {
    expect(validateFieldEdits({ town: 'Vasai', country: 'IN', region: '' })).toEqual({ ok: true, value: { town: 'Vasai', country: 'IN', region: null } });
  });
  it('rejects unknown fields, long values and unsupported countries', () => {
    const r = validateFieldEdits({ city: 'x', street: 'x'.repeat(201), country: 'FR' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['city', 'country', 'street']);
  });
});
