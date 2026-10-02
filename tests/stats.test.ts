import { describe, expect, it } from 'vitest';
import { byYear, elapsedDays, intervals, monthlyKg, predictNext, totalKg, unitPriceYen, unpaid } from '../src/domain/stats';
import { validateReceipt } from '../src/data/validate';
import { receipt, SAMPLE, uuid } from './helpers';

// I12 と §8.1 の計算の定義を固定する

describe('サンプルデータ 8 件（docs/ui-brief.md）', () => {
  const TODAY = '2026-10-01';

  it('累計・経過日数', () => {
    expect(totalKg(SAMPLE)).toBe(240);
    expect(elapsedDays(SAMPLE, TODAY)).toBe(11);
  });

  it('予測: 直近 7 日分で 10 月 29 日・あと 28 日・約 39 日おき', () => {
    const p = predictNext(SAMPLE, TODAY);
    expect(p).toMatchObject({ kind: 'ok', nextDate: '2026-10-29', daysUntil: 28, state: 'ahead' });
    if (p.kind === 'ok') {
      expect(p.avgIntervalDays).toBeCloseTo(232 / 6, 10);
      expect(p.kgPerDay).toBeCloseTo(180 / 232, 10);
    }
  });

  it('未払い・単価・年別・月別・間隔', () => {
    expect(unpaid(SAMPLE)).toEqual({ count: 1, totalYen: 13000, countWithoutPrice: 0 });
    expect(SAMPLE.map(unitPriceYen)).toEqual([400, 400, 400, 417, 417, 417, 433, 433]);
    expect(byYear(SAMPLE)).toEqual([
      { year: 2026, count: 7, kg: 210, yen: 87500 },
      { year: 2025, count: 1, kg: 30, yen: 12000 },
    ]);
    expect(monthlyKg(SAMPLE, 2026)).toEqual([30, 0, 30, 30, 0, 30, 30, 30, 30, 0, 0, 0]);
    expect(intervals(SAMPLE).map((i) => i.days)).toEqual([42, 42, 42, 42, 42, 42, 22]);
  });
});

describe('I12: 予測は受取日が 2 日以上のときだけ', () => {
  const TODAY = '2026-10-01';

  it('0 件・1 件・同じ日の 2 件では予測しない（理由と残り回数を返す）', () => {
    expect(predictNext([], TODAY)).toEqual({ kind: 'none', reason: 'need-two-dates', datesNeeded: 2 });
    expect(predictNext([receipt({ date: '2026-09-20' })], TODAY)).toEqual({ kind: 'none', reason: 'need-two-dates', datesNeeded: 1 });
    const sameDay = [receipt({ date: '2026-09-20' }), receipt({ date: '2026-09-20', kg: 10 })];
    expect(predictNext(sameDay, TODAY)).toEqual({ kind: 'none', reason: 'need-two-dates', datesNeeded: 1 });
  });

  it('2 日分あれば予測する。同じ日の記録は合算する', () => {
    const rs = [receipt({ date: '2026-08-01' }), receipt({ date: '2026-09-01', kg: 20 }), receipt({ date: '2026-09-01', kg: 10 })];
    // 31 日で 30 kg → 1 日 30/31 kg、最後の日の 30 kg がなくなるのは 31 日後
    expect(predictNext(rs, '2026-09-10')).toMatchObject({ kind: 'ok', nextDate: '2026-10-02', daysUntil: 22 });
  });

  it('状態: 8 日以上=ahead、7 日以内=soon、当日=today、過ぎたら overdue で負の日数', () => {
    expect(predictNext(SAMPLE, '2026-10-21')).toMatchObject({ daysUntil: 8, state: 'ahead' });
    expect(predictNext(SAMPLE, '2026-10-22')).toMatchObject({ daysUntil: 7, state: 'soon' });
    expect(predictNext(SAMPLE, '2026-10-29')).toMatchObject({ daysUntil: 0, state: 'today' });
    expect(predictNext(SAMPLE, '2026-11-01')).toMatchObject({ daysUntil: -3, state: 'overdue' });
  });

  it('使うのは直近 7 日分だけ（古い記録は予測に影響しない）', () => {
    const old = [receipt({ date: '2024-01-01', kg: 5 }), receipt({ date: '2024-06-01', kg: 5 })];
    expect(predictNext([...old, ...SAMPLE], '2026-10-01')).toEqual(predictNext(SAMPLE, '2026-10-01'));
  });
});

describe('kg の足し算で小数の誤差を出さない', () => {
  it('0.1 + 0.2 = 0.3', () => {
    const rs = [receipt({ date: '2026-09-01', kg: 0.1 }), receipt({ date: '2026-09-02', kg: 0.2 })];
    expect(totalKg(rs)).toBe(0.3);
    expect(monthlyKg(rs, 2026)[8]).toBe(0.3);
  });
});

describe('未払いの数え方', () => {
  it('代金が空の未払いは件数だけ数える', () => {
    const rs = [receipt({ date: '2026-09-01', paid: false, priceYen: null }), receipt({ date: '2026-09-02', paid: false, priceYen: 5000 })];
    expect(unpaid(rs)).toEqual({ count: 2, totalYen: 5000, countWithoutPrice: 1 });
  });
});

describe('検証を通った量なら予測は例外を出さない（I2 と I12 のつなぎ）', () => {
  it('最小の 0.1 kg を含む記録でも予測が日付を返す', () => {
    const rs = [receipt({ id: uuid(1), date: '2026-09-01', kg: 0.1 }), receipt({ id: uuid(2), date: '2026-09-02', kg: 30 })];
    for (const r of rs) expect(validateReceipt(r, '2026-10-01').ok).toBe(true);
    const p = predictNext(rs, '2026-10-01');
    expect(p.kind).toBe('ok');
    if (p.kind === 'ok') expect(p.nextDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('0 に丸められる極小値は検証で止まる', () => {
    expect(validateReceipt(receipt({ id: uuid(3), date: '2026-09-01', kg: 1e-11 }), '2026-10-01').ok).toBe(false);
  });
});

describe('予測が日付の範囲を超えるとき（バグ点検 P1-1）', () => {
  it('0.1 kg と 1000 kg のように極端な組み合わせでも例外を出さず、予測できないと返す', () => {
    const rs = [receipt({ id: uuid(11), date: '2020-01-01', kg: 0.1 }), receipt({ id: uuid(12), date: '2026-10-03', kg: 1000 })];
    for (const r of rs) expect(validateReceipt(r, '2026-10-03').ok).toBe(true);
    expect(predictNext(rs, '2026-10-03')).toEqual({ kind: 'none', reason: 'out-of-range' });
  });

  it('上限ちょうど（10 年）までは予測する', () => {
    // 1 日 1kg のペースで、最後に 3650kg …は量の上限を超えるので、間隔で作る: 1 日 0.1kg・最後 365kg → 3650 日
    const rs = [receipt({ id: uuid(13), date: '2026-01-01', kg: 0.1 }), receipt({ id: uuid(14), date: '2026-01-02', kg: 365 })];
    expect(predictNext(rs, '2026-01-02')).toMatchObject({ kind: 'ok', daysUntil: 3650 });
  });
});
