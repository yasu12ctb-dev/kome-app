import type { Ymd } from './types';

// 日付は 'YYYY-MM-DD' の文字列で持ち、日数差は年月日を UTC の日付に直して引く（設計書 §2）

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function parts(ymd: Ymd): [number, number, number] | null {
  const m = YMD_RE.exec(ymd);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isValidYmd(value: unknown): value is Ymd {
  if (typeof value !== 'string') return false;
  const p = parts(value);
  if (!p) return false;
  const [y, m, d] = p;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function dayNumber(ymd: Ymd): number {
  const p = parts(ymd);
  if (!p || !isValidYmd(ymd)) throw new RangeError(`invalid date: ${ymd}`);
  return Date.UTC(p[0], p[1] - 1, p[2]) / DAY_MS;
}

/** b − a（日） */
export function daysBetween(a: Ymd, b: Ymd): number {
  return dayNumber(b) - dayNumber(a);
}

export function addDays(ymd: Ymd, days: number): Ymd {
  const t = new Date((dayNumber(ymd) + days) * DAY_MS);
  return formatYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 端末の現在の日付（端末の時刻帯）を 'YYYY-MM-DD' に */
export function toLocalYmd(now: Date): Ymd {
  return formatYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function formatYmd(y: number, m: number, d: number): Ymd {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
