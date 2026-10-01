// 日付の計算を日本時間で固定する（端末の日付＝日本時間の前提。設計書 §2）
process.env.TZ = 'Asia/Tokyo';

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';

// 試験ごとに空の IndexedDB にする
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
