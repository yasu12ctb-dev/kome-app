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

describe('買う間隔の数字の置き方（バグ点検 P2-3）', async () => {
  const { placeGapLabels, labelHalfWidth } = await import('../src/ui/timeline');
  const overlaps = (days: number[]) => {
    const ls = placeGapLabels(days)
      .map((l, i) => ({ ...l, half: labelHalfWidth(days[i]!) }))
      .filter((l) => l.show);
    return ls.some((l, i) => i > 0 && l.center - l.half < ls[i - 1]!.center + ls[i - 1]!.half);
  };

  it('短い間隔が続き、1 つだけ長いときも数字が重ならない', () => {
    for (const days of [[1, 1, 1, 1, 1, 1, 1000, 1], [30, 30, 30, 30, 30, 30, 30, 30], [1, 365], [2, 2, 2]]) {
      expect(overlaps(days)).toBe(false);
    }
  });

  it('十分な幅があれば数字を出す', () => {
    expect(placeGapLabels([60, 60, 60]).every((l) => l.show)).toBe(true);
    expect(placeGapLabels([1, 1, 1, 1, 1, 1, 1000, 1]).filter((l) => l.show)).toHaveLength(1);
  });
});

describe('ホームの未払いの帯（バグ点検 P2-2）', async () => {
  const { unpaidText } = await import('../src/ui/timeline');
  const y = (n: number) => `${n.toLocaleString('ja-JP')}円`;
  it('0 円で記録したものは「0円」と出す（金額未入力とは分ける）', () => {
    expect(unpaidText({ count: 1, totalYen: 0, countWithoutPrice: 0 }, y)).toMatchObject({ amount: '0円', extra: null });
  });
  it('すべて金額未入力なら「金額未入力」', () => {
    expect(unpaidText({ count: 2, totalYen: 0, countWithoutPrice: 2 }, y)).toMatchObject({ amount: '金額未入力', extra: null });
  });
  it('混在なら合計と「ほか金額未入力 N件」', () => {
    const t = unpaidText({ count: 3, totalYen: 12000, countWithoutPrice: 1 }, y);
    expect(t).toMatchObject({ amount: '12,000円', extra: 'ほか金額未入力 1件' });
    expect(t.aria).toContain('ほか金額未入力 1件');
  });
});
