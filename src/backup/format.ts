import { isValidYmd } from '../data/date';
import { KNOWN_SCHEMA_VERSION, type Receipt, type Ymd } from '../data/types';
import { isIsoDateTime, isUuid, validateReceipt } from '../data/validate';

// バックアップファイルの形式（設計書 §2.1。外部との契約）

export const BACKUP_FORMAT = 'kome-backup';

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  deviceId: string;
  writeId: string;
  revision: number;
  exportedAt: string;
  appVersion: string;
  receipts: Receipt[];
}

export type BackupValidation = { ok: true; value: BackupFile } | { ok: false; reason: 'newer-schema' | 'invalid'; errors: string[] };

function sortForBackup(receipts: readonly Receipt[]): Receipt[] {
  return [...receipts].sort((a, b) => (a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date.localeCompare(b.date)));
}

/** 本文のバイト列を作る。PUT する本文そのもの（このバイト列の SHA-256 が bodySha256） */
export function buildBackup(args: Omit<BackupFile, 'format' | 'schemaVersion' | 'receipts'> & { receipts: readonly Receipt[] }): {
  file: BackupFile;
  bytes: Uint8Array<ArrayBuffer>;
} {
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    schemaVersion: KNOWN_SCHEMA_VERSION,
    deviceId: args.deviceId,
    writeId: args.writeId,
    revision: args.revision,
    exportedAt: args.exportedAt,
    appVersion: args.appVersion,
    receipts: sortForBackup(args.receipts),
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`);
  return { file, bytes };
}

/** 書き込みの前に外枠と全件を検証する。1 つでも外れたら全体を拒否（I9） */
export function validateBackup(json: unknown, today: Ymd): BackupValidation {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, reason: 'invalid', errors: ['バックアップの形が正しくありません'] };
  }
  const o = json as Record<string, unknown>;
  const errors: string[] = [];
  if (o.format !== BACKUP_FORMAT) errors.push('format が kome-backup ではありません');
  if (!Number.isSafeInteger(o.schemaVersion) || (o.schemaVersion as number) < 1) {
    errors.push('schemaVersion が正しくありません');
  } else if ((o.schemaVersion as number) > KNOWN_SCHEMA_VERSION) {
    return { ok: false, reason: 'newer-schema', errors: ['新しい版のアプリで作られたバックアップです。アプリを更新してください'] };
  }
  if (!isUuid(o.deviceId)) errors.push('deviceId が正しくありません');
  if (!isUuid(o.writeId)) errors.push('writeId が正しくありません');
  if (!Number.isSafeInteger(o.revision) || (o.revision as number) < 0) errors.push('revision が正しくありません');
  if (!isIsoDateTime(o.exportedAt)) errors.push('exportedAt が正しくありません');
  if (typeof o.appVersion !== 'string') errors.push('appVersion が正しくありません');
  const receipts: Receipt[] = [];
  if (!Array.isArray(o.receipts)) {
    errors.push('receipts が配列ではありません');
  } else {
    const ids = new Set<string>();
    o.receipts.forEach((raw, i) => {
      const checked = validateReceipt(raw, today);
      if (!checked.ok) {
        errors.push(`${i + 1} 件目: ${checked.errors.map((e) => e.message).join('、')}`);
        return;
      }
      if (ids.has(checked.value.id)) errors.push(`${i + 1} 件目: ID が重複しています`);
      ids.add(checked.value.id);
      receipts.push(checked.value);
    });
  }
  if (errors.length > 0) return { ok: false, reason: 'invalid', errors };
  return {
    ok: true,
    value: {
      format: BACKUP_FORMAT,
      schemaVersion: o.schemaVersion as number,
      deviceId: o.deviceId as string,
      writeId: o.writeId as string,
      revision: o.revision as number,
      exportedAt: o.exportedAt as string,
      appVersion: o.appVersion as string,
      receipts,
    },
  };
}

/** バイト列 → 検証済みのバックアップ。UTF-8・JSON として読めなければ invalid */
export function parseBackupBytes(bytes: Uint8Array, today: Ymd): BackupValidation {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, reason: 'invalid', errors: ['JSON として読めません'] };
  }
  return validateBackup(json, today);
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/\s/g, ''));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** 確認画面に並べる要約（件数・累計・最後の受取日） */
export function summarize(receipts: readonly Receipt[]): { count: number; totalKg: number; lastDate: Ymd | null } {
  let tenths = 0;
  let lastDate: Ymd | null = null;
  for (const r of receipts) {
    tenths += Math.round(r.kg * 10);
    if (isValidYmd(r.date) && (lastDate === null || r.date > lastDate)) lastDate = r.date;
  }
  return { count: receipts.length, totalKg: tenths / 10, lastDate };
}
