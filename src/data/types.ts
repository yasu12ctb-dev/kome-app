// 永続する状態の型（設計書 §2・§2.2）

export const KNOWN_DB_VERSION = 1;
export const KNOWN_SCHEMA_VERSION = 1;

/** 端末の日付（日本時間）の 'YYYY-MM-DD' */
export type Ymd = string;

export interface Receipt {
  id: string;
  date: Ymd;
  kg: number;
  priceYen: number | null;
  paid: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AppMeta {
  schemaVersion: number;
  deviceId: string;
  dataRevision: number;
}

export type BackupErrorKind = 'auth' | 'config' | 'conflict' | 'invalid' | 'network' | 'rate-limit';

export interface BackupConfig {
  owner: string;
  repo: string;
  branch: string;
  path: 'kome-backup.json';
}

export interface PendingPush {
  writeId: string;
  generation: string;
  revision: number;
  bodySha256: string;
  startedAt: string;
}

export interface Lineage {
  config: BackupConfig | null;
  generation: string;
  lastPushedSha: string | null;
  lastPushedRevision: number | null;
  lastPushedAt: string | null;
  pendingPush: PendingPush | null;
  errorKind: BackupErrorKind | null;
  retryAfter: string | null;
  lastErrorMessage: string | null;
}

/** 購入の記録（設計書 §10）。端末の中だけに置き、バックアップ・復元には含めない */
export interface Purchase {
  kg: number;
  date: Ymd;
  updatedAt: string;
}

export interface PreRestoreSnapshot {
  receipts: Receipt[];
  dataRevision: number;
  takenAt: string;
}
