import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import { openRepo, type Repo } from '../src/data/repo';
import { idSource } from './helpers';

const DB = 'kome';
// 端末の日付は日本時間。2026-10-01 12:00 JST
const NOW = new Date('2026-10-01T03:00:00.000Z');
const LATER = new Date('2026-10-01T04:00:00.000Z');
const input = { date: '2026-09-20', kg: 30, priceYen: 13000, paid: false };

async function open(ids = idSource(), onChange?: () => void): Promise<Repo> {
  const r = await openRepo({ dbName: DB, newId: ids.next, ...(onChange ? { onChange } : {}) });
  if (r.kind !== 'ok') throw new Error(`stopped: ${r.reason}`);
  return r.repo;
}

/** 試験から DB の中身を直接読む（版を指定せずに開く） */
async function raw() {
  const db = await openDB(DB);
  const app = await db.get('meta', 'app');
  const backup = await db.get('meta', 'backup');
  const receipts = await db.getAll('receipts');
  db.close();
  return { app, backup, receipts };
}

describe('初回起動（§6 手順 2）', () => {
  it('meta.app と系譜の初期値を作り、2 回目は作り直さない', async () => {
    const repo = await open();
    repo.close();
    const first = await raw();
    expect(first.app).toEqual({ schemaVersion: 1, deviceId: expect.any(String), dataRevision: 0 });
    expect(first.backup).toMatchObject({ config: null, lastPushedRevision: null, pendingPush: null, errorKind: null });

    (await open()).close();
    const second = await raw();
    expect(second.app.deviceId).toBe(first.app.deviceId);
    expect(second.backup.generation).toBe(first.backup.generation);
  });
});

describe('記録の追加・編集・削除', () => {
  it('書き込みのたびに dataRevision が 1 ずつ増える', async () => {
    const repo = await open();
    const added = await repo.addReceipt(input, NOW);
    expect(added).toMatchObject({ ok: true, dataRevision: 1 });
    if (!added.ok) throw new Error();
    expect(await repo.updateReceipt(added.receipt.id, { ...input, paid: true }, LATER)).toMatchObject({ ok: true, dataRevision: 2 });
    expect(await repo.deleteReceipt(added.receipt.id)).toEqual({ ok: true, dataRevision: 3 });
    expect((await repo.getAppMeta()).dataRevision).toBe(3);
    expect(await repo.listReceipts()).toEqual([]);
    repo.close();
  });

  it('編集では createdAt を保ち、updatedAt を進める', async () => {
    const repo = await open();
    const added = await repo.addReceipt(input, NOW);
    if (!added.ok) throw new Error();
    const updated = await repo.updateReceipt(added.receipt.id, { ...input, kg: 29.5 }, LATER);
    expect(updated).toMatchObject({ ok: true, receipt: { kg: 29.5, createdAt: NOW.toISOString(), updatedAt: LATER.toISOString() } });
    repo.close();
  });

  it('一覧は受取日の昇順', async () => {
    const repo = await open();
    await repo.addReceipt({ ...input, date: '2026-09-20' }, NOW);
    await repo.addReceipt({ ...input, date: '2026-08-29' }, NOW);
    expect((await repo.listReceipts()).map((r) => r.date)).toEqual(['2026-08-29', '2026-09-20']);
    repo.close();
  });

  it('onChange は確定した書き込みの後だけ呼ばれる', async () => {
    const onChange = vi.fn();
    const repo = await open(idSource(), onChange);
    await repo.addReceipt({ ...input, kg: 0 }, NOW);
    await repo.deleteReceipt('00000000-0000-4000-8000-0000000000ff');
    expect(onChange).not.toHaveBeenCalled();
    await repo.addReceipt(input, NOW);
    expect(onChange).toHaveBeenCalledTimes(1);
    repo.close();
  });
});

describe('I1: 書き込みに失敗したら成功を返さない', () => {
  it('確定した後の通知が例外を出しても、追加・編集・削除は成功として返る', async () => {
    const onChange = vi.fn(() => {
      throw new Error('notify failed');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const repo = await open(idSource(), onChange);
    const added = await repo.addReceipt(input, NOW);
    expect(added).toMatchObject({ ok: true, dataRevision: 1 });
    if (!added.ok) throw new Error();
    expect(await repo.updateReceipt(added.receipt.id, { ...input, paid: true }, LATER)).toMatchObject({ ok: true, dataRevision: 2 });
    expect(await repo.deleteReceipt(added.receipt.id)).toEqual({ ok: true, dataRevision: 3 });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenCalledTimes(3);
    errors.mockRestore();
    repo.close();
  });

  it('DB が閉じていて書けないとき failed を返し、何も残らない', async () => {
    const repo = await open();
    repo.close();
    expect(await repo.addReceipt(input, NOW)).toMatchObject({ ok: false, kind: 'failed' });
    const after = await raw();
    expect(after.receipts).toEqual([]);
    expect(after.app.dataRevision).toBe(0);
  });
});

describe('I2: 追加・編集の経路でも検証を通す', () => {
  it('追加: 不正な値は invalid で、DB は変わらない', async () => {
    const repo = await open();
    for (const bad of [{ kg: 0 }, { date: '2026-10-02' }, { priceYen: -5 }]) {
      expect(await repo.addReceipt({ ...input, ...bad }, NOW)).toMatchObject({ ok: false, kind: 'invalid' });
    }
    expect((await repo.getAppMeta()).dataRevision).toBe(0);
    expect(await repo.listReceipts()).toEqual([]);
    repo.close();
  });

  it('編集: 不正な値は invalid で、元の記録と dataRevision は変わらない', async () => {
    const repo = await open();
    const added = await repo.addReceipt(input, NOW);
    if (!added.ok) throw new Error();
    for (const bad of [{ kg: 30.25 }, { date: '2026-10-02' }, { priceYen: 1.5 }]) {
      expect(await repo.updateReceipt(added.receipt.id, { ...input, ...bad }, LATER)).toMatchObject({ ok: false, kind: 'invalid' });
    }
    expect((await repo.getAppMeta()).dataRevision).toBe(1);
    expect(await repo.listReceipts()).toEqual([added.receipt]);
    repo.close();
  });
});

describe('I3: 記録の変更と dataRevision +1 は同じトランザクション', () => {
  it('dataRevision を上げた後で記録の追加が失敗すると、両方とも元のまま', async () => {
    const ids = idSource();
    const repo = await open(ids);
    const added = await repo.addReceipt(input, NOW);
    if (!added.ok) throw new Error();
    ids.fixed = added.receipt.id; // 次の追加の ID を既存と衝突させる
    expect(await repo.addReceipt({ ...input, kg: 10 }, NOW)).toMatchObject({ ok: false, kind: 'failed' });
    repo.close();
    const after = await raw();
    expect(after.app.dataRevision).toBe(1);
    expect(after.receipts).toEqual([added.receipt]);
  });

  it('無い記録の編集・削除は not-found で、dataRevision は変わらない', async () => {
    const repo = await open();
    const missing = '00000000-0000-4000-8000-0000000000ff';
    expect(await repo.updateReceipt(missing, input, NOW)).toEqual({ ok: false, kind: 'not-found' });
    expect(await repo.deleteReceipt(missing)).toEqual({ ok: false, kind: 'not-found' });
    expect((await repo.getAppMeta()).dataRevision).toBe(0);
    repo.close();
  });
});

describe('I4: 累計・予測は保存しない', () => {
  it('書き込んだ後も meta.app は 3 項目、記録は 7 項目だけ', async () => {
    const repo = await open();
    await repo.addReceipt(input, NOW);
    repo.close();
    const after = await raw();
    expect(Object.keys(after.app).sort()).toEqual(['dataRevision', 'deviceId', 'schemaVersion']);
    expect(Object.keys(after.receipts[0]).sort()).toEqual(['createdAt', 'date', 'id', 'kg', 'paid', 'priceYen', 'updatedAt']);
  });
});

describe('I13: 新しい版のデータに出会ったら停止モード', () => {
  it('DB の版が新しいと stopped（newer-db-version）で、DB を変えない', async () => {
    const newer = await openDB(DB, 2, {
      upgrade(db) {
        db.createObjectStore('receipts', { keyPath: 'id' });
        db.createObjectStore('meta');
        db.createObjectStore('future');
      },
    });
    newer.close();
    expect(await openRepo({ dbName: DB })).toEqual({ kind: 'stopped', reason: 'newer-db-version' });
    const db = await openDB(DB);
    expect(db.version).toBe(2);
    expect([...db.objectStoreNames].sort()).toEqual(['future', 'meta', 'receipts']);
    expect(await db.get('meta', 'app')).toBeUndefined();
    db.close();
  });

  it('schemaVersion が新しいと stopped（newer-schema）で、系譜も作らない', async () => {
    (await open()).close();
    const db = await openDB(DB);
    await db.put('meta', { schemaVersion: 2, deviceId: 'x', dataRevision: 5 }, 'app');
    await db.delete('meta', 'backup');
    db.close();
    expect(await openRepo({ dbName: DB })).toEqual({ kind: 'stopped', reason: 'newer-schema' });
    const after = await raw();
    expect(after.app).toEqual({ schemaVersion: 2, deviceId: 'x', dataRevision: 5 });
    expect(after.backup).toBeUndefined();
  });
});
