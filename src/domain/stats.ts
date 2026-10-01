import { addDays, daysBetween } from '../data/date';
import type { Receipt, Ymd } from '../data/types';

// 累計・経過日数・予測・集計は保存せず、毎回記録から計算する（設計書 I4・§8.1）

/** 予測に使う直近の受取日の数（間隔は 6 つ） */
export const PREDICTION_WINDOW = 7;
/** 「もうすぐ」とみなす残り日数 */
export const SOON_DAYS = 7;

// kg は 0.1 刻みなので、10 倍の整数で足して誤差を避ける
const tenths = (kg: number) => Math.round(kg * 10);

export function totalKg(receipts: readonly Receipt[]): number {
  return receipts.reduce((sum, r) => sum + tenths(r.kg), 0) / 10;
}

export function lastReceiptDate(receipts: readonly Receipt[]): Ymd | null {
  let last: Ymd | null = null;
  for (const r of receipts) if (last === null || r.date > last) last = r.date;
  return last;
}

/** 今日 − 最新の受取日（記録が無ければ null） */
export function elapsedDays(receipts: readonly Receipt[], today: Ymd): number | null {
  const last = lastReceiptDate(receipts);
  return last === null ? null : daysBetween(last, today);
}

/** 受取日ごとに kg を合算し、日付の昇順に並べる */
export function byDate(receipts: readonly Receipt[]): { date: Ymd; kg: number }[] {
  const map = new Map<Ymd, number>();
  for (const r of receipts) map.set(r.date, (map.get(r.date) ?? 0) + tenths(r.kg));
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, t]) => ({ date, kg: t / 10 }));
}

export type PredictionState = 'ahead' | 'soon' | 'today' | 'overdue';

export type Prediction =
  | { kind: 'none'; reason: 'need-two-dates'; datesNeeded: number }
  | {
      kind: 'ok';
      nextDate: Ymd;
      /** 予測日 − 今日（過ぎていれば負） */
      daysUntil: number;
      state: PredictionState;
      avgIntervalDays: number;
      kgPerDay: number;
    };

export function predictNext(receipts: readonly Receipt[], today: Ymd): Prediction {
  const days = byDate(receipts).slice(-PREDICTION_WINDOW);
  if (days.length < 2) return { kind: 'none', reason: 'need-two-dates', datesNeeded: 2 - days.length };
  const first = days[0]!;
  const last = days[days.length - 1]!;
  // 受取日を日付ごとに合算しているので、日付が 2 つ以上あれば span は 1 以上
  const span = daysBetween(first.date, last.date);
  const consumedTenths = days.slice(0, -1).reduce((sum, d) => sum + tenths(d.kg), 0);
  const kgPerDay = consumedTenths / 10 / span;
  const nextDate = addDays(last.date, Math.round(last.kg / kgPerDay));
  const daysUntil = daysBetween(today, nextDate);
  const state: PredictionState = daysUntil < 0 ? 'overdue' : daysUntil === 0 ? 'today' : daysUntil <= SOON_DAYS ? 'soon' : 'ahead';
  return { kind: 'ok', nextDate, daysUntil, state, avgIntervalDays: span / (days.length - 1), kgPerDay };
}

export function unitPriceYen(r: Receipt): number | null {
  return r.priceYen === null ? null : Math.round(r.priceYen / r.kg);
}

/** 未払い: 件数は代金の有無を問わず数え、金額は代金のあるものだけ足す */
export function unpaid(receipts: readonly Receipt[]): { count: number; totalYen: number; countWithoutPrice: number } {
  let count = 0;
  let totalYen = 0;
  let countWithoutPrice = 0;
  for (const r of receipts) {
    if (r.paid) continue;
    count += 1;
    if (r.priceYen === null) countWithoutPrice += 1;
    else totalYen += r.priceYen;
  }
  return { count, totalYen, countWithoutPrice };
}

export function byYear(receipts: readonly Receipt[]): { year: number; count: number; kg: number; yen: number }[] {
  const map = new Map<number, { count: number; tenths: number; yen: number }>();
  for (const r of receipts) {
    const year = Number(r.date.slice(0, 4));
    const cur = map.get(year) ?? { count: 0, tenths: 0, yen: 0 };
    cur.count += 1;
    cur.tenths += tenths(r.kg);
    cur.yen += r.priceYen ?? 0;
    map.set(year, cur);
  }
  return [...map.entries()].sort(([a], [b]) => b - a).map(([year, v]) => ({ year, count: v.count, kg: v.tenths / 10, yen: v.yen }));
}

/** その年の月ごとの kg（1〜12 月の 12 要素） */
export function monthlyKg(receipts: readonly Receipt[], year: number): number[] {
  const months = new Array<number>(12).fill(0);
  for (const r of receipts) {
    if (Number(r.date.slice(0, 4)) !== year) continue;
    const m = Number(r.date.slice(5, 7)) - 1;
    months[m] = (months[m] ?? 0) + tenths(r.kg);
  }
  return months.map((t) => t / 10);
}

/** 受取日（日付ごとに合算）の間隔 */
export function intervals(receipts: readonly Receipt[]): { from: Ymd; to: Ymd; days: number }[] {
  const days = byDate(receipts);
  const out: { from: Ymd; to: Ymd; days: number }[] = [];
  for (let i = 1; i < days.length; i += 1) {
    const from = days[i - 1]!.date;
    const to = days[i]!.date;
    out.push({ from, to, days: daysBetween(from, to) });
  }
  return out;
}
