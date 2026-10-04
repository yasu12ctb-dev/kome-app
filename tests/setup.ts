// 日付の計算を日本時間で固定する（端末の日付＝日本時間の前提。設計書 §2）
process.env.TZ = 'Asia/Tokyo';

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { enableLocalLockForTests } from '../src/backup/lock';

// 試験の Node には Web Locks が無いので、同じページの中だけの代わりの排他を明示して使う（設計書 §3・§7 改訂 6）
enableLocalLockForTests();

// 試験ごとに空の IndexedDB にする
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
