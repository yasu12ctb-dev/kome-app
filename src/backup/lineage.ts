import type { IDBPObjectStore } from 'idb';
import type { KomeSchema } from '../data/db';
import type { Lineage } from '../data/types';

// 系譜の関所（設計書 §4.4）。meta.backup を書くのはこのファイルだけ（I14）。
// U1 では初期値の作成だけを持つ。送信・復元の操作は U2 で足す。

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
