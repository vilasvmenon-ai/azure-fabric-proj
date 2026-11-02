/**
 * Structured operational telemetry (LOG-01). One JSON line per event, written
 * with console.log so it lands in the Functions invocation logs.
 *
 * Callers must pass only safe values: no tokens, no address text, no provider
 * bodies. `redact` is a last line of defence for accidental string fields.
 */
export type TelemetryFields = Record<string, string | number | boolean | null | undefined>;

const FORBIDDEN_KEYS = /token|authorization|secret|password|address|prompt|body/i;

export function redact(fields: TelemetryFields): TelemetryFields {
  const out: TelemetryFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = FORBIDDEN_KEYS.test(key) ? '[redacted]' : value;
  }
  return out;
}

export function logEvent(evt: string, fields: TelemetryFields): void {
  console.log(JSON.stringify({ evt, ts: new Date().toISOString(), ...redact(fields) }));
}
