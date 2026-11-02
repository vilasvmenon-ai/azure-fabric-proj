/**
 * Browser-safe contracts for App B (isolation test app). Keep aligned with
 * the decorated entity in `@rayfin-app/data`.
 */
export type IsolationNoteRecord = {
  id: string;
  title: string;
  app_id: string;
  created_at: Date;
  owner_id: string;
};

export type UniversalAppSchema = {
  IsolationNote: IsolationNoteRecord;
};

export const APP_B_ID = 'isob';
