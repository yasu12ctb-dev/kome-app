import type { Receipt } from '../src/data/types';

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** 呼ぶたびに別の UUID を返す。fixed を設定すると、その値を返し続ける（ID の衝突を起こす試験用） */
export function idSource(start = 0) {
  let n = start;
  const source = {
    fixed: null as string | null,
    next: () => source.fixed ?? uuid(++n),
  };
  return source;
}

export function receipt(over: Partial<Receipt> & { date: string }): Receipt {
  return {
    id: uuid(Math.floor(Math.random() * 1e9)),
    kg: 30,
    priceYen: null,
    paid: true,
    createdAt: `${over.date}T03:00:00.000Z`,
    updatedAt: `${over.date}T03:00:00.000Z`,
    ...over,
  };
}

/** docs/ui-brief.md のサンプルデータ 8 件 */
export const SAMPLE: Receipt[] = [
  ['2025-12-20', 12000, true],
  ['2026-01-31', 12000, true],
  ['2026-03-14', 12000, true],
  ['2026-04-25', 12500, true],
  ['2026-06-06', 12500, true],
  ['2026-07-18', 12500, true],
  ['2026-08-29', 13000, true],
  ['2026-09-20', 13000, false],
].map(([date, priceYen, paid], i) => receipt({ id: uuid(i + 1), date: date as string, priceYen: priceYen as number, paid: paid as boolean }));
