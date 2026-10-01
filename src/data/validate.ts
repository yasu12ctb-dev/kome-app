import { daysBetween, isValidYmd } from './date';
import type { Receipt, Ymd } from './types';

// 記録の検証は 1 つの関数に集める（設計書 I2）。追加・編集・復元の全経路がここを通る

export interface ValidationError {
  field: keyof Receipt | 'record';
  message: string;
}

export type ValidationResult = { ok: true; value: Receipt } | { ok: false; errors: ValidationError[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function hasAtMostOneDecimal(kg: number): boolean {
  return Math.abs(kg * 10 - Math.round(kg * 10)) < 1e-9;
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
  } else if (!hasAtMostOneDecimal(r.kg)) {
    errors.push({ field: 'kg', message: '量は小数 1 桁までです' });
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
