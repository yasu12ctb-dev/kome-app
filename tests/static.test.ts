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

  it("meta の 'app' を書くのは db.ts（初期化）・repo.ts（dataRevision）・lineage.ts（復元と取り消し）だけ", () => {
    expect(filesMatching(/\.put\([^;]*?,\s*['"]app['"]\s*\)/)).toEqual(['src/backup/lineage.ts', 'src/data/db.ts', 'src/data/repo.ts']);
  });

  it('記録の store を開くのは repo.ts（追加・編集・削除）と lineage.ts（復元・取り消し・写しの読み取り）だけ', () => {
    expect(filesMatching(/objectStore\(\s*['"]receipts['"]\s*\)/)).toEqual(['src/backup/lineage.ts', 'src/data/repo.ts']);
  });

  it("'secrets'・'preRestoreSnapshot' を扱うのは db.ts（定義）と lineage.ts だけ", () => {
    expect(filesMatching(/['"](secrets|preRestoreSnapshot)['"]/)).toEqual(['src/backup/lineage.ts', 'src/data/db.ts']);
  });

  it('読み込み直し（location.reload）を呼ぶのは窓口 src/app/reload.ts と、利用者が押す停止画面のボタン（App.tsx・ErrorBoundary.tsx）だけ（§6.2）', () => {
    expect(filesMatching(/location\.reload\s*\(/)).toEqual(['src/app/reload.ts', 'src/ui/App.tsx', 'src/ui/ErrorBoundary.tsx']);
  });

  it('予約の 3 経路（controllerchange・onNeedReload・DB の版上げ）はすべて窓口へ予約する（§6.2）', () => {
    const auto = readFileSync(join(ROOT, 'src/app/autoUpdate.ts'), 'utf8');
    expect(auto.match(/coordinator\.request\('sw-update'\)/g)).toHaveLength(2);
    expect(readFileSync(join(ROOT, 'src/ui/useKome.ts'), 'utf8')).toContain("coordinator.request('db-upgrade')");
  });

  it('外部への通信（fetch）と api.github.com は src/backup/github.ts だけ', () => {
    expect(filesMatching(/\bfetch\s*\(/)).toEqual(['src/backup/github.ts']);
    expect(filesMatching(/api\.github\.com/)).toEqual(['src/backup/github.ts']);
  });
});
