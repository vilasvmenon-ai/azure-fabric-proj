import type { UniversalAppSchema } from '@rayfin-app/shared';

import { IsolationNote } from './IsolationNote.js';

/** App B data schema: one owner-scoped entity in App B's own SQL database. */
export type { UniversalAppSchema };
export { IsolationNote };

export const schema = [IsolationNote];
