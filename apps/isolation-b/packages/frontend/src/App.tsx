import { APP_B_ID, type IsolationNoteRecord } from '@rayfin-app/shared';
import { useCallback, useEffect, useState } from 'react';

import { getRayfinClient } from '@/lib/rayfin-client';

type Loaded = { ok: true; notes: IsolationNoteRecord[] } | { ok: false; message: string };

async function fetchNotes(): Promise<Loaded> {
  try {
    const client = await getRayfinClient();
    const notes = await client.data.IsolationNote.select(['id', 'title', 'app_id', 'created_at', 'owner_id'])
      .orderBy({ created_at: 'desc' })
      .first(50)
      .execute();
    return { ok: true, notes };
  } catch {
    return { ok: false, message: 'Notes could not be loaded. You may not have access to this app.' };
  }
}

/**
 * App B — isolation test app (PRD "Minimum demonstration"). It is a separate
 * Fabric App item with its own database and sign-in. Its business scope is out
 * of PRD scope: it only stores owner-scoped test notes so separation tests can
 * prove that App A users, data and APIs do not reach App B.
 */
function App() {
  const [result, setResult] = useState<Loaded | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  const reload = useCallback(() => fetchNotes().then(setResult), []);

  useEffect(() => {
    let cancelled = false;
    void fetchNotes().then((r) => !cancelled && setResult(r));
    void getRayfinClient().then((c) => {
      const session = c.auth.getSession();
      if (!cancelled) setEmail(session.user?.email ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const add = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const client = await getRayfinClient();
      const session = client.auth.getSession();
      if (!session.isAuthenticated || !session.user) throw new Error('Not signed in.');
      await client.data.IsolationNote.create({ title: value.slice(0, 200), app_id: APP_B_ID, created_at: new Date(), owner_id: session.user.id });
      setTitle('');
      await reload();
    } catch {
      setResult({ ok: false, message: 'The note could not be saved.' });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    const client = await getRayfinClient();
    await client.auth.signOut();
    window.location.reload();
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">ionova · ai-lab</p>
            <h1 className="text-lg font-semibold">
              App B — isolation test <span className="ml-1 rounded bg-muted px-2 py-0.5 text-xs uppercase">dev</span>
            </h1>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span>{email}</span>
            <button type="button" className="rounded-lg border border-border px-3 py-1.5 hover:bg-accent" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <p className="mb-4 text-sm text-muted-foreground">Separate Fabric App item, database and access list. Used only to prove isolation from the Address Structuring Lab.</p>
        <form
          className="mb-6 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label htmlFor="title" className="sr-only">
            Note
          </label>
          <input id="title" maxLength={200} className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button type="submit" disabled={busy || !title.trim()} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
            Add test note
          </button>
        </form>
        {!result && <p role="status">Loading…</p>}
        {result && !result.ok && (
          <p role="alert" className="text-sm text-destructive">
            {result.message}
          </p>
        )}
        {result?.ok && (
          <ul className="space-y-2">
            {result.notes.length === 0 && <li className="text-sm text-muted-foreground">No notes yet.</li>}
            {result.notes.map((n) => (
              <li key={n.id} className="rounded border border-border p-2 text-sm">
                {n.title} <span className="text-xs text-muted-foreground">{new Date(n.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

export default App;
