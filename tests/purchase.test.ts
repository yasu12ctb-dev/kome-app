import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import { needsPush } from '../src/backup/lineage';
import { openRepo } from '../src/data/repo';
import { validatePurchase } from '../src/data/validate';
import { remaining } from '../src/domain/stats';
import { idSource, receipt, uuid } from './helpers';

// 購入の記録と残り（設計書 §10・§9.1・I15）

const NOW = new Date('2026-10-04T03:00:00.000Z'); // 2026-10-04 12:00 JST
const TODAY = '2026-10-04';

async function open(handlers: { onChange?: () => void; onPurchaseChange?: () => void } = {}) {
  const r = await openRepo({ dbName: 'kome', newId: idSource().next, ...handlers });
  if (r.kind !== 'ok') throw new Error(r.reason);
  return r;
}

async function rawMeta() {
  const db = await openDB('kome');
  const [app, backup, purchase] = await Promise.all([db.get('meta', 'app'), db.get('meta', 'backup'), db.get('meta', 'purchase')]);
  db.close();
  return { app, backup, purchase };
}

describe('validatePurchase', () => {
  it('0.1 kg 刻みで 0 < kg ≤ 10000、今日以前の実在する日付だけ通す', () => {
    expect(validatePurchase({ kg: 240, date: '2026-10-01' }, TODAY)).toEqual({ ok: true, value: { kg: 240, date: '2026-10-01' } });
    expect(validatePurchase({ kg: 0.1, date: TODAY }, TODAY).ok).toBe(true);
    expect(validatePurchase({ kg: 10000, date: TODAY }, TODAY).ok).toBe(true);
    for (const kg of [0, -1, 10000.1, 0.05, 30.25, Number.NaN, Number.POSITIVE_INFINITY, '240']) {
      expect(validatePurchase({ kg, date: TODAY }, TODAY).ok, String(kg)).toBe(false);
    }
    for (const date of ['2026-10-05', '2026-02-30', '2026/10/01', '', null]) {
      expect(validatePurchase({ kg: 240, date }, TODAY).ok, String(date)).toBe(false);
    }
  });
});

describe('I15: 購入の記録の書き込み', () => {
  it('書いて読み戻せる。dataRevision・系譜・needsPush は変わらず、送信の通知（onChange）ではなく購入の通知だけが来る', async () => {
    const onChange = vi.fn();
    const onPurchaseChange = vi.fn();
    const { repo, lineage } = await open({ onChange, onPurchaseChange });
    const before = await rawMeta();
    const beforeGate = await lineage.read();
    expect(await repo.getPurchase()).toBeNull();
    expect(await repo.setPurchase({ kg: 240, date: '2026-10-01' }, NOW)).toEqual({ ok: true, purchase: { kg: 240, date: '2026-10-01', updatedAt: NOW.toISOString() } });
    expect(await repo.getPurchase()).toEqual({ kg: 240, date: '2026-10-01', updatedAt: NOW.toISOString() });
    const after = await rawMeta();
    expect(after.app).toEqual(before.app);
    expect(after.backup).toEqual(before.backup);
    const afterGate = await lineage.read();
    expect(afterGate.dataRevision).toBe(beforeGate.dataRevision);
    expect(needsPush(afterGate.lineage, afterGate.dataRevision)).toBe(needsPush(beforeGate.lineage, beforeGate.dataRevision));
    expect(onChange).not.toHaveBeenCalled();
    expect(onPurchaseChange).toHaveBeenCalledTimes(1);

    expect(await repo.clearPurchase()).toEqual({ ok: true, purchase: null });
    expect(await repo.getPurchase()).toBeNull();
    expect((await rawMeta()).app).toEqual(before.app);
    expect(onPurchaseChange).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
    repo.close();
  });

  it('書き換えると新しい購入に置き換わる（履歴は持たない）', async () => {
    const { repo } = await open();
    await repo.setPurchase({ kg: 240, date: '2025-10-01' }, NOW);
    await repo.setPurchase({ kg: 180, date: '2026-10-01' }, NOW);
    expect(await repo.getPurchase()).toMatchObject({ kg: 180, date: '2026-10-01' });
    repo.close();
  });

  it('検証に通らなければ何も書かず、通知もしない', async () => {
    const onPurchaseChange = vi.fn();
    const { repo } = await open({ onPurchaseChange });
    await repo.setPurchase({ kg: 240, date: '2026-10-01' }, NOW);
    const r = await repo.setPurchase({ kg: 0, date: '2026-10-05' }, NOW);
    expect(r).toMatchObject({ ok: false, kind: 'invalid' });
    if (r.ok || r.kind !== 'invalid') throw new Error();
    expect(r.errors.map((e) => e.field).sort()).toEqual(['date', 'kg']);
    expect(await repo.getPurchase()).toMatchObject({ kg: 240, date: '2026-10-01' });
    expect(onPurchaseChange).toHaveBeenCalledTimes(1);
    repo.close();
  });

  it('DB が閉じていて書けないとき failed を返し、何も残らない（I1）', async () => {
    const { repo } = await open();
    repo.close();
    expect(await repo.setPurchase({ kg: 240, date: '2026-10-01' }, NOW)).toMatchObject({ ok: false, kind: 'failed' });
    expect(await repo.clearPurchase()).toMatchObject({ ok: false, kind: 'failed' });
    expect((await rawMeta()).purchase).toBeUndefined();
  });

  it('確定後の通知が例外を出しても、成功として返る', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo } = await open({
      onPurchaseChange: () => {
        throw new Error('notify failed');
      },
    });
    expect(await repo.setPurchase({ kg: 240, date: '2026-10-01' }, NOW)).toMatchObject({ ok: true });
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
    repo.close();
  });

  it('購入の記録がある DB を開き直しても残り、初期化は触れない', async () => {
    const first = await open();
    await first.repo.setPurchase({ kg: 240, date: '2026-10-01' }, NOW);
    first.repo.close();
    const second = await open();
    expect(await second.repo.getPurchase()).toMatchObject({ kg: 240, date: '2026-10-01' });
    second.repo.close();
  });
});

describe('§8.1 残り', () => {
  const r = (date: string, kg: number) => receipt({ id: uuid(Math.floor(Math.random() * 1e6)), date, kg });

  it('購入日より前は数えず、同じ日は数える', () => {
    const rs = [r('2026-09-30', 30), r('2026-10-01', 30), r('2026-10-03', 30)];
    expect(remaining(rs, { kg: 240, date: '2026-10-01' })).toEqual({ receivedKg: 60, remainingKg: 180 });
  });

  it('受け取りが無ければ購入量そのもの、受け取りすぎは負', () => {
    expect(remaining([], { kg: 240, date: '2026-10-01' })).toEqual({ receivedKg: 0, remainingKg: 240 });
    const rs = Array.from({ length: 9 }, (_, i) => r(`2026-10-0${i + 1}`, 30));
    expect(remaining(rs, { kg: 240, date: '2026-10-01' }).remainingKg).toBe(-30);
  });

  it('0.1 kg の足し引きで誤差が出ない', () => {
    const rs = [r('2026-10-01', 0.1), r('2026-10-02', 0.2)];
    expect(remaining(rs, { kg: 0.3, date: '2026-10-01' })).toEqual({ receivedKg: 0.3, remainingKg: 0 });
    expect(remaining([r('2026-10-01', 29.9)], { kg: 240.1, date: '2026-10-01' }).remainingKg).toBe(210.2);
  });
});
