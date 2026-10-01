import type { IDBPObjectStore } from 'idb';
import type { KomeDb, KomeSchema } from '../data/db';
import type { AppMeta, BackupConfig, BackupErrorKind, Lineage, PreRestoreSnapshot, Receipt } from '../data/types';

// 系譜の関所（設計書 §4.4）。meta.backup・secrets・preRestoreSnapshot を書くのはこのファイルだけ（I14）。
// どの操作も 1 つの readwrite トランザクションで今の系譜を読み、呼び出し側が渡した世代（と、送信の結果なら
// pendingPush.writeId）が一致しなければ何も書かない。

export function initialLineage(generation: string): Lineage {
  return {
    config: null,
    generation,
    lastPushedSha: null,
    lastPushedRevision: null,
    lastPushedAt: null,
    pendingPush: null,
    errorKind: null,
    retryAfter: null,
    lastErrorMessage: null,
  };
}

/** 起動時の初期化トランザクションの中で呼ぶ。系譜が無ければ初期値を置く */
export async function ensureLineage(
  meta: IDBPObjectStore<KomeSchema, ['meta'], 'meta', 'readwrite'>,
  newId: () => string,
): Promise<void> {
  const current = await meta.get('backup');
  if (current === undefined) await meta.put(initialLineage(newId()), 'backup');
}

/** 送信が要るか（§2.2）。「保存待ち」の表示もこれで決める */
export function needsPush(l: Lineage, dataRevision: number): boolean {
  return l.config !== null && (l.pendingPush !== null || l.lastPushedRevision === null || dataRevision > l.lastPushedRevision);
}

export type DisplayStatus = 'unset' | 'error' | 'pending' | 'saved';

export function displayStatus(l: Lineage, dataRevision: number): DisplayStatus {
  if (l.config === null) return 'unset';
  if (l.errorKind !== null) return 'error';
  return needsPush(l, dataRevision) ? 'pending' : 'saved';
}

/** 自動の再試行を止める種類のエラー（§4.0） */
export function isStopError(kind: BackupErrorKind | null): boolean {
  return kind === 'auth' || kind === 'config' || kind === 'conflict' || kind === 'invalid';
}

export function sameTarget(a: BackupConfig | null, b: BackupConfig | null): boolean {
  if (a === null || b === null) return a === b;
  return a.owner === b.owner && a.repo === b.repo && a.branch === b.branch && a.path === b.path;
}

export interface Snapshot {
  dataRevision: number;
  deviceId: string;
  receipts: Receipt[];
}

export interface RestoreExpectation {
  /** 確認時の端末の dataRevision */
  d0: number;
  /** 確認時の系譜の世代 */
  g0: string;
  /** GitHub からの復元なら確認時の blob sha。ファイルからなら null */
  s0: string | null;
}

export interface LineageGate {
  read(): Promise<{ lineage: Lineage; dataRevision: number }>;
  readToken(): Promise<string | null>;
  /** 写しを作るための 1 つの読み取りトランザクション（§4.2 手順 4） */
  readSnapshot(): Promise<Snapshot>;
  hasPreRestoreSnapshot(): Promise<boolean>;
  saveConfig(expectedGeneration: string, config: BackupConfig | null, token?: string): Promise<boolean>;
  beginPush(generation: string, pending: { writeId: string; revision: number; bodySha256: string }, now: Date): Promise<boolean>;
  recordPushLanded(generation: string, writeId: string, sha: string, now: Date): Promise<boolean>;
  clearPending(generation: string, writeId: string): Promise<boolean>;
  resetRemote(generation: string, writeId: string): Promise<boolean>;
  recordPushError(
    generation: string,
    writeId: string,
    kind: BackupErrorKind,
    keepPending: boolean,
    retryAfter?: string | null,
    message?: string,
  ): Promise<boolean>;
  /** sha が null なら GitHub にファイルが無い（次の PUT は sha なしの新規作成） */
  adoptRemoteSha(generation: string, sha: string | null): Promise<boolean>;
  clearErrorForRetry(generation: string): Promise<boolean>;
  restore(expected: RestoreExpectation, receipts: readonly Receipt[], source: 'github' | 'file', now: Date): Promise<boolean>;
  undoRestore(generation: string): Promise<'ok' | 'stale' | 'no-snapshot'>;
}

export function createLineageGate(db: KomeDb, newId: () => string): LineageGate {
  /** 系譜だけを書き換える操作。check が偽なら何も書かない */
  async function update(check: (l: Lineage) => boolean, change: (l: Lineage) => Lineage): Promise<boolean> {
    const tx = db.transaction('meta', 'readwrite');
    const done = tx.done;
    done.catch(() => {});
    const current = (await tx.store.get('backup')) as Lineage;
    if (!check(current)) {
      await done;
      return false;
    }
    await tx.store.put(change(current), 'backup');
    await done;
    return true;
  }

  const sameGen = (gen: string) => (l: Lineage) => l.generation === gen;
  const samePending = (gen: string, writeId: string) => (l: Lineage) => l.generation === gen && l.pendingPush?.writeId === writeId;

  return {
    async read() {
      const tx = db.transaction('meta', 'readonly');
      const [lineage, app] = await Promise.all([tx.store.get('backup'), tx.store.get('app')]);
      await tx.done;
      return { lineage: structuredClone(lineage as Lineage), dataRevision: (app as AppMeta).dataRevision };
    },

    async readToken() {
      return (await db.get('secrets', 'githubToken')) ?? null;
    },

    async readSnapshot() {
      const tx = db.transaction(['receipts', 'meta'], 'readonly');
      const [receipts, app] = await Promise.all([tx.objectStore('receipts').getAll(), tx.objectStore('meta').get('app')]);
      await tx.done;
      const a = app as AppMeta;
      return { dataRevision: a.dataRevision, deviceId: a.deviceId, receipts };
    },

    async hasPreRestoreSnapshot() {
      return (await db.get('meta', 'preRestoreSnapshot')) !== undefined;
    },

    async saveConfig(expectedGeneration, config, token) {
      const tx = db.transaction(['meta', 'secrets'], 'readwrite');
      const done = tx.done;
      done.catch(() => {});
      const meta = tx.objectStore('meta');
      const current = (await meta.get('backup')) as Lineage;
      if (current.generation !== expectedGeneration) {
        await done;
        return false;
      }
      let next: Lineage;
      if (!sameTarget(current.config, config)) {
        // 保存先が変わった: 新しい世代で系譜を始め直す（この保存先へはまだ何も届いていない）
        next = { ...initialLineage(newId()), config };
      } else {
        next = { ...current };
        if (current.errorKind === 'auth' || current.errorKind === 'config') {
          next.errorKind = null;
          next.retryAfter = null;
          next.lastErrorMessage = null;
        }
      }
      await meta.put(next, 'backup');
      if (token !== undefined) await tx.objectStore('secrets').put(token, 'githubToken');
      await done;
      return true;
    },

    beginPush(generation, pending, now) {
      return update(
        (l) => l.generation === generation && l.pendingPush === null,
        (l) => ({ ...l, pendingPush: { ...pending, generation, startedAt: now.toISOString() } }),
      );
    },

    recordPushLanded(generation, writeId, sha, now) {
      return update(samePending(generation, writeId), (l) => ({
        ...l,
        lastPushedSha: sha,
        lastPushedRevision: Math.max(l.lastPushedRevision ?? -1, l.pendingPush!.revision),
        lastPushedAt: now.toISOString(),
        pendingPush: null,
        errorKind: null,
        retryAfter: null,
        lastErrorMessage: null,
      }));
    },

    clearPending(generation, writeId) {
      return update(samePending(generation, writeId), (l) => ({ ...l, pendingPush: null }));
    },

    resetRemote(generation, writeId) {
      return update(samePending(generation, writeId), (l) => ({ ...l, lastPushedSha: null, pendingPush: null }));
    },

    recordPushError(generation, writeId, kind, keepPending, retryAfter = null, message) {
      return update(samePending(generation, writeId), (l) => ({
        ...l,
        errorKind: kind,
        retryAfter,
        lastErrorMessage: message ?? null,
        pendingPush: keepPending ? l.pendingPush : null,
      }));
    },

    adoptRemoteSha(generation, sha) {
      return update(sameGen(generation), (l) => ({
        ...l,
        lastPushedSha: sha,
        pendingPush: null,
        errorKind: null,
        retryAfter: null,
        lastErrorMessage: null,
      }));
    },

    clearErrorForRetry(generation) {
      return update(sameGen(generation), (l) => ({ ...l, errorKind: null, retryAfter: null, lastErrorMessage: null }));
    },

    async restore(expected, receipts, source, now) {
      const tx = db.transaction(['receipts', 'meta'], 'readwrite');
      const done = tx.done;
      done.catch(() => {});
      const meta = tx.objectStore('meta');
      const store = tx.objectStore('receipts');
      const app = (await meta.get('app')) as AppMeta;
      const lineage = (await meta.get('backup')) as Lineage;
      if (app.dataRevision !== expected.d0 || lineage.generation !== expected.g0) {
        await done;
        return false;
      }
      try {
        const before = await store.getAll();
        const snapshot: PreRestoreSnapshot = { receipts: before, dataRevision: expected.d0, takenAt: now.toISOString() };
        await meta.put(snapshot, 'preRestoreSnapshot');
        await store.clear();
        for (const r of receipts) await store.add(r);
        const revision = expected.d0 + 1;
        await meta.put({ ...app, dataRevision: revision }, 'app');
        const next: Lineage = { ...lineage, pendingPush: null, errorKind: null, retryAfter: null, lastErrorMessage: null };
        if (source === 'github') {
          // GitHub と端末が同じ内容になったので保存済み（§6.1 手順 3）
          next.lastPushedSha = expected.s0;
          next.lastPushedRevision = revision;
          next.lastPushedAt = now.toISOString();
        }
        await meta.put(next, 'backup');
        await done;
        return true;
      } catch (e) {
        try {
          tx.abort();
        } catch {
          // 既に中止されている
        }
        throw e;
      }
    },

    async undoRestore(generation) {
      const tx = db.transaction(['receipts', 'meta'], 'readwrite');
      const done = tx.done;
      done.catch(() => {});
      const meta = tx.objectStore('meta');
      const store = tx.objectStore('receipts');
      const lineage = (await meta.get('backup')) as Lineage;
      const snapshot = (await meta.get('preRestoreSnapshot')) as PreRestoreSnapshot | undefined;
      if (lineage.generation !== generation) {
        await done;
        return 'stale';
      }
      if (snapshot === undefined) {
        await done;
        return 'no-snapshot';
      }
      const app = (await meta.get('app')) as AppMeta;
      await store.clear();
      for (const r of snapshot.receipts) await store.add(r);
      await meta.delete('preRestoreSnapshot');
      await meta.put({ ...app, dataRevision: app.dataRevision + 1 }, 'app');
      await meta.put({ ...lineage, pendingPush: null, errorKind: null, retryAfter: null, lastErrorMessage: null }, 'backup');
      await done;
      return 'ok';
    },
  };
}
