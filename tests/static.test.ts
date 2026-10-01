import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// §3 の経路の見張り。0 件を合格条件にせず、全出現を「許可したファイル」と照合する

const ROOT = join(import.meta.dirname, '..');

function sourceFiles(dir = join(ROOT, 'src')): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function filesMatching(re: RegExp): string[] {
  return sourceFiles()
    .filter((f) => re.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f))
    .sort();
}

describe('§3 データを変えうる経路', () => {
  it('IndexedDB を開くのは src/data/db.ts だけ', () => {
    // 型引数つきの呼び出し（openDB<Schema>(…)）も拾う
    expect(filesMatching(/\b(openDB|indexedDB\.open)\s*(<[^>]*>)?\s*\(/)).toEqual(['src/data/db.ts']);
  });

  it("meta の 'backup' を書くのは src/backup/lineage.ts だけ（I14）", () => {
    // 引数の中に括弧があっても拾う（put(initialLineage(x), 'backup')）
    expect(filesMatching(/\.put\([^;]*?,\s*['"]backup['"]\s*\)/)).toEqual(['src/backup/lineage.ts']);
  });

  it("meta の 'app' を書くのは db.ts（初期化）と repo.ts（dataRevision）だけ", () => {
    expect(filesMatching(/\.put\([^;]*?,\s*['"]app['"]\s*\)/)).toEqual(['src/data/db.ts', 'src/data/repo.ts']);
  });

  it('記録の store を書くのは repo.ts だけ（U1 時点。U2 で lineage.ts の復元が加わる）', () => {
    expect(filesMatching(/objectStore\(\s*['"]receipts['"]\s*\)/)).toEqual(['src/data/repo.ts']);
  });

  it("'secrets'・'preRestoreSnapshot' は U1 では db.ts の定義以外に出てこない", () => {
    expect(filesMatching(/['"](secrets|preRestoreSnapshot)['"]/)).toEqual(['src/data/db.ts']);
  });

  it('U1 では外部への通信（fetch）が無い', () => {
    expect(filesMatching(/\bfetch\s*\(/)).toEqual([]);
  });
});
