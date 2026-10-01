import { describe, expect, it } from 'vitest';
import { buildBackup, parseBackupBytes, validateBackup } from '../src/backup/format';
import { receipt, uuid } from './helpers';

// I9: validateBackup を通らないバックアップは 1 件も適用しない（§2.1）

const TODAY = '2026-10-01';
const good = () =>
  JSON.parse(
    new TextDecoder().decode(
      buildBackup({
        deviceId: uuid(1),
        writeId: uuid(2),
        revision: 3,
        exportedAt: '2026-10-01T03:00:00.000Z',
        appVersion: '0.1.0',
        receipts: [receipt({ id: uuid(10), date: '2026-09-20' }), receipt({ id: uuid(11), date: '2026-08-29' })],
      }).bytes,
    ),
  ) as Record<string, unknown>;

describe('buildBackup', () => {
  it('受取日の昇順・インデント 2・末尾に改行 1 つ', () => {
    const { bytes, file } = buildBackup({ deviceId: uuid(1), writeId: uuid(2), revision: 0, exportedAt: '2026-10-01T03:00:00.000Z', appVersion: '0.1.0', receipts: [receipt({ id: uuid(10), date: '2026-09-20' }), receipt({ id: uuid(11), date: '2026-08-29' })] });
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe(`${JSON.stringify(file, null, 2)}\n`);
    expect(file.receipts.map((r) => r.date)).toEqual(['2026-08-29', '2026-09-20']);
  });
});

describe('validateBackup（I9）', () => {
  it('正しいバックアップを通し、未知のキーは読み捨てる', () => {
    const result = validateBackup({ ...good(), extra: 1 }, TODAY);
    expect(result.ok).toBe(true);
    expect(result.ok && 'extra' in result.value).toBe(false);
  });

  const bad: [string, (o: Record<string, unknown>) => void, string][] = [
    ['format 違い', (o) => (o.format = 'other'), 'invalid'],
    ['新しい schemaVersion', (o) => (o.schemaVersion = 2), 'newer-schema'],
    ['schemaVersion が 0', (o) => (o.schemaVersion = 0), 'invalid'],
    ['receipts が配列でない', (o) => (o.receipts = {}), 'invalid'],
    ['revision が負', (o) => (o.revision = -1), 'invalid'],
    ['revision が小数', (o) => (o.revision = 1.5), 'invalid'],
    ['deviceId が UUID でない', (o) => (o.deviceId = 'x'), 'invalid'],
    ['writeId が UUID でない', (o) => (o.writeId = 'x'), 'invalid'],
    ['exportedAt が不正', (o) => (o.exportedAt = '2026-02-30T00:00:00Z'), 'invalid'],
    ['appVersion が文字列でない', (o) => (o.appVersion = 1), 'invalid'],
    ['1 件だけ不正な記録', (o) => ((o.receipts as Record<string, unknown>[])[1]!.kg = 0), 'invalid'],
    ['id の重複', (o) => ((o.receipts as Record<string, unknown>[])[1]!.id = (o.receipts as Record<string, unknown>[])[0]!.id), 'invalid'],
  ];
  it.each(bad)('%s を拒否する', (_label, mutate, reason) => {
    const o = good();
    mutate(o);
    expect(validateBackup(o, TODAY)).toMatchObject({ ok: false, reason });
  });

  it('JSON・UTF-8 として読めないバイト列を拒否する', () => {
    expect(parseBackupBytes(new TextEncoder().encode('{'), TODAY)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parseBackupBytes(new Uint8Array([0xff, 0xfe]), TODAY)).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
