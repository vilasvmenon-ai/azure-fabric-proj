import type { AddressFields, ApiError } from '@rayfin-app/shared';
import type { ReactNode } from 'react';

import { FIELD_LABELS } from '@/lib/format';
import { cn } from '@/lib/utils';

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      {(title || actions) && (
        <div className="mb-4 flex items-center justify-between gap-4">
          {title ? <h2 className="text-base font-semibold text-card-foreground">{title}</h2> : <span />}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="py-6 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

/** Actionable, sanitized error with the correlation id for support (LOG-01). */
export function ErrorPanel({ error, correlationId, onRetry }: { error: ApiError; correlationId?: string; onRetry?: () => void }) {
  const hint: Partial<Record<ApiError['code'], string>> = {
    ACCESS_DENIED: 'If you need this access, ask the app administrator.',
    UNAUTHENTICATED: 'Sign out and sign in again.',
    CONFLICT: 'Reload to see the latest version.',
    AI_TIMEOUT: 'Your request was saved. Open it from My records and use Retry.',
    AI_UNAVAILABLE: 'Your request was saved. Use Retry later.',
    AUDIT_FAILURE: 'Nothing was reported as complete. Try again later or contact support.',
    STORAGE_FAILURE: 'Nothing was reported as complete. Try again later or contact support.',
    CONFIG: 'The app is not fully configured. Contact the project administrator.',
  };
  return (
    <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
      <p className="font-semibold text-destructive">{error.message}</p>
      {hint[error.code] && <p className="mt-1 text-foreground">{hint[error.code]}</p>}
      {error.fieldErrors && (
        <ul className="mt-2 list-disc pl-5 text-foreground">
          {Object.entries(error.fieldErrors).map(([k, v]) => (
            <li key={k}>
              <span className="font-medium">{k}</span>: {v}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Code {error.code}
        {correlationId ? (
          <>
            {' '}
            · Correlation ID <code className="select-all">{correlationId}</code>
          </>
        ) : null}
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          Try again
        </button>
      )}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  COMPLETED: 'bg-green-100 text-green-900',
  APPROVED: 'bg-green-100 text-green-900',
  FIELDS_PRESENT: 'bg-green-100 text-green-900',
  PENDING: 'bg-muted text-foreground',
  PROCESSING: 'bg-blue-100 text-blue-900',
  RECEIVED: 'bg-blue-100 text-blue-900',
  NEEDS_REVIEW: 'bg-amber-100 text-amber-900',
  NEEDS_CHANGES: 'bg-amber-100 text-amber-900',
  REJECTED: 'bg-red-100 text-red-900',
  SUCCESS: 'bg-green-100 text-green-900',
  DENIED: 'bg-amber-100 text-amber-900',
  FAILURE: 'bg-red-100 text-red-900',
};

export function StatusBadge({ value }: { value: string }) {
  const style = STATUS_STYLES[value] ?? (value.startsWith('FAILED') ? 'bg-red-100 text-red-900' : 'bg-muted text-foreground');
  return <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-medium', style)}>{value.replace(/_/g, ' ')}</span>;
}

export function Button({
  children,
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const styles = {
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    secondary: 'border border-border bg-background text-foreground hover:bg-accent',
    danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  };
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
        styles[variant],
        props.className
      )}
    >
      {children}
    </button>
  );
}

export function FieldTable({ fields, evidence, compare }: { fields: AddressFields | null; evidence?: AddressFields | null; compare?: AddressFields | null }) {
  if (!fields) return <p className="text-sm text-muted-foreground">No structured fields.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-border text-xs uppercase text-muted-foreground">
          <th scope="col" className="py-2 pr-4">Field</th>
          <th scope="col" className="py-2 pr-4">Value</th>
          {evidence !== undefined && <th scope="col" className="py-2 pr-4">Evidence in input</th>}
          {compare !== undefined && <th scope="col" className="py-2">Model output</th>}
        </tr>
      </thead>
      <tbody>
        {(Object.keys(FIELD_LABELS) as (keyof AddressFields)[]).map((k) => (
          <tr key={k} className="border-b border-border/60">
            <th scope="row" className="py-2 pr-4 font-medium">{FIELD_LABELS[k]}</th>
            <td className="py-2 pr-4">{fields[k] ?? <span className="text-muted-foreground">—</span>}</td>
            {evidence !== undefined && <td className="py-2 pr-4 text-muted-foreground">{evidence?.[k] ?? '—'}</td>}
            {compare !== undefined && (
              <td className={cn('py-2', compare?.[k] !== fields[k] && 'font-medium text-amber-800')}>{compare?.[k] ?? '—'}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
