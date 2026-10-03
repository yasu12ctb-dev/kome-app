import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { ensureLineage } from '../backup/lineage';
import { KNOWN_DB_VERSION, KNOWN_SCHEMA_VERSION, type AppMeta, type Lineage, type PreRestoreSnapshot, type Purchase, type Receipt } from './types';

// IndexedDB を開くのはこのファイルだけ（設計書 §3「変更の能力の持ち出し」）

export interface KomeSchema extends DBSchema {
  receipts: { key: string; value: Receipt };
  meta: { key: 'app' | 'backup' | 'preRestoreSnapshot' | 'purchase'; value: AppMeta | Lineage | PreRestoreSnapshot | Purchase };
  secrets: { key: 'githubToken'; value: string };
}

export type KomeDb = IDBPDatabase<KomeSchema>;

export type StopReason = 'newer-db-version' | 'newer-schema' | 'open-failed';

export type OpenDbResult = { kind: 'ok'; db: KomeDb } | { kind: 'stopped'; reason: StopReason; detail?: string };

export interface OpenDbOptions {
  dbName: string;
  newId: () => string;
  /** 別のタブが DB の版を上げようとしたとき（設計書 §3）。DB は閉じてから呼ぶ */
  onVersionChange?: () => void;
}

function errorName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
}

export async function openKomeDb(options: OpenDbOptions): Promise<OpenDbResult> {
  let db: KomeDb;
  try {
    db = await openDB<KomeSchema>(options.dbName, KNOWN_DB_VERSION, {
      upgrade(upgradeDb, oldVersion) {
        if (oldVersion < 1) {
          upgradeDb.createObjectStore('receipts', { keyPath: 'id' });
          upgradeDb.createObjectStore('meta');
          upgradeDb.createObjectStore('secrets');
        }
      },
      blocking() {
        db.close();
        options.onVersionChange?.();
      },
    });
  } catch (e) {
    // 新しいアプリで作った DB を古いアプリで開いた（I13）。読まない・書かない
    if (errorName(e) === 'VersionError') return { kind: 'stopped', reason: 'newer-db-version' };
    return { kind: 'stopped', reason: 'open-failed', detail: errorName(e) || String(e) };
  }

  // 初回の初期化と schemaVersion の確認（設計書 §6 手順 2・3）
  const tx = db.transaction('meta', 'readwrite');
  const app = (await tx.store.get('app')) as AppMeta | undefined;
  if (app !== undefined && app.schemaVersion > KNOWN_SCHEMA_VERSION) {
    await tx.done;
    db.close();
    return { kind: 'stopped', reason: 'newer-schema' };
  }
  if (app === undefined) {
    const initial: AppMeta = { schemaVersion: KNOWN_SCHEMA_VERSION, deviceId: options.newId(), dataRevision: 0 };
    await tx.store.put(initial, 'app');
  }
  await ensureLineage(tx.store, options.newId);
  await tx.done;
  return { kind: 'ok', db };
}
