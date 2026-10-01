import { describe, expect, it } from 'vitest';
import { validateReceipt } from '../src/data/validate';
import { receipt, uuid } from './helpers';

// I2: 端末に入る記録は必ず検証を通っている

const TODAY = '2026-10-01';
const base = receipt({ id: uuid(1), date: '2026-09-20', priceYen: 13000, paid: false });

describe('validateReceipt（I2）', () => {
  it('正しい記録と境界の値を通す', () => {
    expect(validateReceipt(base, TODAY).ok).toBe(true);
    for (const over of [{ kg: 1000 }, { kg: 0.1 }, { kg: 29.5 }, { priceYen: 0 }, { priceYen: null }, { date: TODAY }]) {
      expect(validateReceipt({ ...base, ...over }, TODAY), JSON.stringify(over)).toMatchObject({ ok: true });
    }
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ['kg が 0', { kg: 0 }, 'kg'],
    ['kg が負', { kg: -1 }, 'kg'],
    ['kg が 1000 超', { kg: 1000.1 }, 'kg'],
    ['kg が小数 2 桁', { kg: 30.25 }, 'kg'],
    ['kg が NaN', { kg: Number.NaN }, 'kg'],
    ['kg が文字列', { kg: '30' }, 'kg'],
    ['存在しない日付', { date: '2026-02-30' }, 'date'],
    ['日付の書式違い', { date: '2026/09/20' }, 'date'],
    ['未来日', { date: '2026-10-02' }, 'date'],
    ['代金が負', { priceYen: -1 }, 'priceYen'],
    ['代金が小数', { priceYen: 1.5 }, 'priceYen'],
    ['代金が文字列', { priceYen: '13000' }, 'priceYen'],
    ['支払いが真偽値でない', { paid: 'yes' }, 'paid'],
    ['id が UUID でない', { id: 'abc' }, 'id'],
    ['作成日時が不正', { createdAt: '2026-09-20' }, 'createdAt'],
    ['更新日時が不正', { updatedAt: 'yesterday' }, 'updatedAt'],
    ['更新日時が作成日時より前', { createdAt: '2026-09-20T03:00:00.000Z', updatedAt: '2026-09-20T02:59:59.000Z' }, 'updatedAt'],
  ];

  it.each(invalid)('%s を拒否する', (_label, over, field) => {
    const result = validateReceipt({ ...base, ...over }, TODAY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toContain(field);
  });

  it('オブジェクトでない値を拒否する', () => {
    for (const v of [null, 1, 'x', [base]]) expect(validateReceipt(v, TODAY).ok).toBe(false);
  });

  it('余分なキーは結果に含めない', () => {
    const result = validateReceipt({ ...base, extra: 1 }, TODAY);
    expect(result.ok && Object.keys(result.value).sort()).toEqual(['createdAt', 'date', 'id', 'kg', 'paid', 'priceYen', 'updatedAt']);
  });
});
