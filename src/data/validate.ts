import { daysBetween, isValidYmd } from './date';
import type { Receipt, Ymd } from './types';

// 記録の検証は 1 つの関数に集める（設計書 I2）。追加・編集・復元の全経路がここを通る

export interface ValidationError {
  field: keyof Receipt | 'record';
  message: string;
}

export type ValidationResult = { ok: true; value: Receipt } | { ok: false; errors: ValidationError[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * 書式だけでなく日時の成分が実在するかも確かめる。Date.parse は 2 月 30 日と 24 時を通すため、
 * 日付と時を自前で確かめる（分・秒の 60 と時差の 24 時間は Date.parse が拒む。試験で確認済み）
 */
export function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const [, ymd, hh, mm, ss] = m;
  if (!isValidYmd(ymd)) return false;
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) return false;
  return !Number.isNaN(Date.parse(value));
}

/** 0.1 kg 刻みの正の値か（10 倍して整数にしたとき 1 以上になること。極小値が 0 に丸められるのを防ぐ） */
function isPositiveTenth(kg: number): boolean {
  const t = Math.round(kg * 10);
  return t >= 1 && Math.abs(kg * 10 - t) < 1e-9;
}

/** 購入した量の上限（kg）。記録 1 件の上限 1000 kg より大きくまとめて買えるようにする */
export const MAX_PURCHASE_KG = 10000;

/** 購入の記録の検証（設計書 §10）。量は 0.1 kg 刻みで 0 < kg ≤ 10000、購入日は実在する今日以前の日付 */
export function validatePurchase(input: { kg: unknown; date: unknown }, today: Ymd): { ok: true; value: { kg: number; date: Ymd } } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const { kg, date } = input;
  if (typeof kg !== 'number' || !Number.isFinite(kg) || kg <= 0 || kg > MAX_PURCHASE_KG) {
    errors.push({ field: 'kg', message: `購入した量は 0 より大きく ${MAX_PURCHASE_KG.toLocaleString('ja-JP')} kg 以下で入れてください` });
  } else if (!isPositiveTenth(kg)) {
    errors.push({ field: 'kg', message: '購入した量は 0.1 kg 刻みで入れてください' });
  }
  if (!isValidYmd(date)) {
    errors.push({ field: 'date', message: '購入日が正しくありません' });
  } else if (daysBetween(today, date) > 0) {
    errors.push({ field: 'date', message: '購入日に未来の日付は選べません' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { kg: kg as number, date: date as Ymd } };
}

export function validateReceipt(input: unknown, today: Ymd): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'record', message: '記録の形が正しくありません' }] };
  }
  const r = input as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (!isUuid(r.id)) errors.push({ field: 'id', message: 'ID が正しくありません' });

  if (!isValidYmd(r.date)) {
    errors.push({ field: 'date', message: '受取日が正しくありません' });
  } else if (daysBetween(today, r.date) > 0) {
    errors.push({ field: 'date', message: '受取日に未来の日付は選べません' });
  }

  if (typeof r.kg !== 'number' || !Number.isFinite(r.kg) || r.kg <= 0 || r.kg > 1000) {
    errors.push({ field: 'kg', message: '量は 0 より大きく 1000 kg 以下で入れてください' });
  } else if (!isPositiveTenth(r.kg)) {
    errors.push({ field: 'kg', message: '量は 0.1 kg 刻みで入れてください' });
  }

  if (!(r.priceYen === null || (Number.isSafeInteger(r.priceYen) && (r.priceYen as number) >= 0))) {
    errors.push({ field: 'priceYen', message: '代金は 0 以上の整数（円）で入れてください' });
  }

  if (typeof r.paid !== 'boolean') errors.push({ field: 'paid', message: '支払いの状態が正しくありません' });

  const createdOk = isIsoDateTime(r.createdAt);
  const updatedOk = isIsoDateTime(r.updatedAt);
  if (!createdOk) errors.push({ field: 'createdAt', message: '作成日時が正しくありません' });
  if (!updatedOk) errors.push({ field: 'updatedAt', message: '更新日時が正しくありません' });
  if (createdOk && updatedOk && Date.parse(r.updatedAt as string) < Date.parse(r.createdAt as string)) {
    errors.push({ field: 'updatedAt', message: '更新日時が作成日時より前です' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: r.id as string,
      date: r.date as Ymd,
      kg: r.kg as number,
      priceYen: r.priceYen as number | null,
      paid: r.paid as boolean,
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
    },
  };
}
