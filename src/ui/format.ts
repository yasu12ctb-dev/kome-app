import type { Ymd } from '../data/types';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function parts(ymd: Ymd): [number, number, number] {
  return ymd.split('-').map(Number) as [number, number, number];
}

export function weekday(ymd: Ymd): string {
  const [y, m, d] = parts(ymd);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/** 10月29日 */
export function monthDay(ymd: Ymd): string {
  const [, m, d] = parts(ymd);
  return `${m}月${d}日`;
}

/** 10月29日（木） */
export function monthDayWeek(ymd: Ymd): string {
  return `${monthDay(ymd)}（${weekday(ymd)}）`;
}

/** 9.20 */
export function dotDate(ymd: Ymd): string {
  const [, m, d] = parts(ymd);
  return `${m}.${String(d).padStart(2, '0')}`;
}

export function kg(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function yen(n: number): string {
  return `${n.toLocaleString('ja-JP')}円`;
}

export function dateTime(iso: string): string {
  const t = new Date(iso);
  return `${t.getMonth() + 1}/${t.getDate()} ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
}
