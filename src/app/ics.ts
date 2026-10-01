import type { Ymd } from '../data/types';

// 次回の目安をカレンダーに入れる（設計書 §8.1）。iOS のホーム画面版で Blob の <a download> が
// カレンダーの追加画面を開くことを 2026-10-01 にシミュレータで確認済み（§8）

function compact(ymd: Ymd): string {
  return ymd.replaceAll('-', '');
}

function nextDay(ymd: Ymd): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}

export function buildIcs(nextDate: Ymd, deviceId: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//kome-app//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // UID を固定し、登録し直すと同じ予定の更新になるようにする
    `UID:kome-next@${deviceId}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compact(nextDate)}`,
    `DTEND;VALUE=DATE:${nextDay(nextDate)}`,
    'SUMMARY:お米の購入目安',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:お米の購入目安',
    'TRIGGER:-P3D',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** ファイルを渡す（.ics・バックアップの書き出しで共通） */
export function saveFile(doc: Document, bytes: BlobPart, type: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = fileName;
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
