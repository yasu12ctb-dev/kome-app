import { describe, expect, it } from 'vitest';
import { createGitHubClient } from '../src/backup/github';
import { displayStatus, needsPush, type LineageGate } from '../src/backup/lineage';
import { createBackupService, MAX_PUSH_LOOPS, type BackupService } from '../src/backup/service';
import { buildBackup } from '../src/backup/format';
import { openRepo, type Repo } from '../src/data/repo';
import type { BackupConfig } from '../src/data/types';
import { cutResponse, deferred, fakeGitHub, stalledResponse } from './fakeGitHub';
import { idSource, uuid } from './helpers';

const TOKEN = 'github_pat_TEST_SECRET_0123456789';
const TARGET: BackupConfig = { owner: 'u', repo: 'kome-data', branch: 'main', path: 'kome-backup.json' };
const OTHER: BackupConfig = { ...TARGET, repo: 'kome-data-2' };
const KEY = 'kome-data/kome-backup.json';
const OTHER_KEY = 'kome-data-2/kome-backup.json';
const NOW = new Date('2026-10-01T03:00:00.000Z');

type Gh = ReturnType<typeof fakeGitHub>;

async function device(gh: Gh, dbName = 'kome', configure = true, idStart = 0, timeoutMs?: number) {
  const ids = idSource(idStart);
  const opened = await openRepo({ dbName, newId: ids.next });
  if (opened.kind !== 'ok') throw new Error(opened.reason);
  const service = createBackupService({
    gate: opened.lineage,
    appVersion: '0.1.0',
    newId: ids.next,
    now: () => NOW,
    client: (token) => createGitHubClient({ token, fetch: gh.fetch, now: () => NOW, ...(timeoutMs ? { timeoutMs } : {}) }),
  });
  if (configure) await service.saveConfig(TARGET, TOKEN);
  return { repo: opened.repo, gate: opened.lineage, service, ids };
}

function add(repo: Repo, date = '2026-09-20', kg = 30) {
  return repo.addReceipt({ date, kg, priceYen: null, paid: true }, NOW);
}

function remote(gh: Gh, path = KEY) {
  const t = gh.text(path);
  return t === null ? null : (JSON.parse(t) as { revision: number; receipts: unknown[]; deviceId: string; writeId: string });
}

async function state(gate: LineageGate) {
  const { lineage, dataRevision } = await gate.read();
  return { ...lineage, dataRevision, needs: needsPush(lineage, dataRevision), status: displayStatus(lineage, dataRevision) };
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('timeout');
}

const appPuts = (gh: Gh) => gh.requests.filter((r) => r.method === 'PUT');

describe('初回送信（保存先の系譜・改訂 2 P1-1）', () => {
  it('記録 0 件・dataRevision 0 でも、空の保存先へ空の写しを 1 回送り「保存済み」になる', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    expect((await state(d.gate)).needs).toBe(true);
    expect(await d.service.push()).toMatchObject({ kind: 'done', status: 'saved' });
    expect(remote(gh)).toMatchObject({ revision: 0, receipts: [] });
    expect(await state(d.gate)).toMatchObject({ lastPushedRevision: 0, pendingPush: null, needs: false });
    expect(await d.service.push()).toMatchObject({ kind: 'done', status: 'saved' });
    expect(appPuts(gh)).toHaveLength(1);
  });

  it('既にファイルがある保存先では、sha なしの PUT が拒否されて conflict で止まり、既存のファイルは変わらない', async () => {
    const gh = fakeGitHub();
    gh.setRemote(KEY, '{"someone":"else"}');
    const d = await device(gh);
    expect(await d.service.push()).toMatchObject({ kind: 'done', status: 'error', errorKind: 'conflict' });
    expect(gh.text(KEY)).toBe('{"someone":"else"}');
    expect(appPuts(gh)[0]!.body).not.toHaveProperty('sha');
    // 止める種類のエラーなので、自動の送信では何も送らない
    const before = gh.requests.length;
    expect(await d.service.push()).toEqual({ kind: 'skipped', reason: 'stopped' });
    expect(gh.requests.length).toBe(before);
  });
});

describe('I5: GitHub 上の写しは端末データ全体', () => {
  it('送った本文が全件を含み、検証を通る形式で、revision が端末と同じ', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await add(d.repo, '2026-08-29');
    await add(d.repo, '2026-09-20', 29.5);
    await d.service.push();
    const r = remote(gh)!;
    expect(r.revision).toBe(2);
    expect(r.receipts).toHaveLength(2);
    expect(r).toMatchObject({ format: 'kome-backup', schemaVersion: 1, appVersion: '0.1.0' });
    expect(gh.text(KEY)!.endsWith('}\n')).toBe(true);
  });
});

describe('I6: 送信中の変更は送り直し、古い写しで上書きしない', () => {
  it('PUT の応答待ちの間に記録を足すと、同じ送信の中で送り直し、lastPushedRevision は減らない', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await add(d.repo, '2026-08-29');
    const gate = deferred();
    let first = true;
    gh.hooks.beforeCommit = async () => {
      if (first) {
        first = false;
        await gate.promise;
      }
    };
    const pushing = d.service.push();
    await until(() => appPuts(gh).length === 1);
    await add(d.repo, '2026-09-20');
    gate.resolve();
    expect(await pushing).toMatchObject({ kind: 'done', status: 'saved' });
    expect(remote(gh)).toMatchObject({ revision: 2 });
    expect(remote(gh)!.receipts).toHaveLength(2);
    expect(await state(d.gate)).toMatchObject({ lastPushedRevision: 2, needs: false });
  });
});

describe('I7: 自分が送った写しだけを確認なしに上書きする', () => {
  it('a. deviceId・revision は同じでも本文が違う（手編集）なら PUT は拒否され conflict', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await add(d.repo);
    await d.service.push();
    const edited = remote(gh)!;
    edited.receipts = [];
    gh.setRemote(KEY, `${JSON.stringify(edited, null, 2)}\n`);
    const handEdited = gh.text(KEY);
    await add(d.repo, '2026-09-21');
    expect(await d.service.push()).toMatchObject({ status: 'error', errorKind: 'conflict' });
    expect(gh.text(KEY)).toBe(handEdited);
  });

  it('b. pendingPush の確定後・PUT 前に落ちた → 次回は「届いていない」と判定して送り直し、コミットは 1 つ', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await d.service.push();
    await add(d.repo);
    const { lineage } = await d.gate.read();
    await d.gate.beginPush(lineage.generation, { writeId: uuid(900), revision: 1, bodySha256: 'f'.repeat(64) }, NOW);
    const commits = gh.commits.length;
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    expect(gh.commits.length).toBe(commits + 1);
    expect(remote(gh)).toMatchObject({ revision: 1 });
  });

  it('c. PUT が確定したのに応答が届かなかった → 次回の照合で自分の写しと判定し、重複コミットを作らない', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await d.service.push();
    await add(d.repo);
    gh.hooks.dropResponseAfterCommit = true;
    expect(await d.service.push()).toMatchObject({ status: 'error', errorKind: 'network' });
    expect((await state(d.gate)).pendingPush).not.toBeNull();
    const commits = gh.commits.length;
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    expect(gh.commits.length).toBe(commits);
    expect(await state(d.gate)).toMatchObject({ lastPushedSha: gh.files.get(KEY)!.sha, lastPushedRevision: 1, pendingPush: null });
  });

  it('d. 通信の失敗では pendingPush が残り、次回は照合から始まる', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await d.service.push();
    await add(d.repo);
    gh.hooks.onRequest = (req) => {
      if (req.method === 'PUT') throw new TypeError('offline');
    };
    expect(await d.service.push()).toMatchObject({ errorKind: 'network' });
    const s = await state(d.gate);
    expect(s.pendingPush).not.toBeNull();
    gh.hooks.onRequest = undefined;
    const before = gh.requests.length;
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    expect(gh.requests[before]!.method).toBe('GET');
  });
});

describe('照合の GET が失敗したとき（改訂 2 P2-1）', () => {
  it('残った pendingPush の照合 GET がネット不通・429・401 なら pendingPush は残り、成功にも conflict にもならない', async () => {
    for (const make of [() => Promise.reject(new TypeError('offline')), () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }), () => new Response('{}', { status: 401 })]) {
      globalThis.indexedDB = new (await import('fake-indexeddb')).IDBFactory();
      const gh = fakeGitHub();
      const d = await device(gh);
      await d.service.push();
      await add(d.repo);
      const { lineage } = await d.gate.read();
      await d.gate.beginPush(lineage.generation, { writeId: uuid(901), revision: 1, bodySha256: 'f'.repeat(64) }, NOW);
      gh.hooks.onRequest = async (req) => (req.method === 'GET' ? make() : undefined);
      const out = await d.service.push();
      expect(out).toMatchObject({ kind: 'done' });
      const s = await state(d.gate);
      expect(s.pendingPush?.writeId).toBe(uuid(901));
      expect(s.errorKind).not.toBe('conflict');
      expect(s.lastPushedRevision).toBe(0);
    }
  });

  it('sha 衝突のあとの GET がネット不通なら pendingPush は消え（PUT は拒否済み）、成功にも conflict にもならない', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await d.service.push();
    await add(d.repo);
    gh.hooks.onRequest = (req) => {
      if (req.method === 'PUT') return new Response('{}', { status: 409 });
      if (req.method === 'GET') throw new TypeError('offline');
    };
    expect(await d.service.push()).toMatchObject({ errorKind: 'network' });
    expect(await state(d.gate)).toMatchObject({ pendingPush: null, lastPushedRevision: 0, needs: true });
  });
});

describe('I14: 古い送信の結果を新しい系譜へ入れない', () => {
  it('PUT の応答待ちの間に（ロックの外から）保存先を A→B に変えると、旧応答は B の系譜を変えず、B へ全件を送る', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await add(d.repo);
    const gate = deferred();
    gh.hooks.beforeCommit = async (req) => {
      if (req.path === KEY) await gate.promise;
    };
    const pushing = d.service.push();
    await until(() => appPuts(gh).length === 1);
    const { lineage: a } = await d.gate.read();
    expect(await d.gate.saveConfig(a.generation, OTHER)).toBe(true);
    const { lineage: b } = await d.gate.read();
    gate.resolve();
    await pushing;
    const s = await state(d.gate);
    expect(s.generation).toBe(b.generation);
    expect(s.lastPushedSha).toBe(gh.files.get(OTHER_KEY)!.sha);
    expect(remote(gh, OTHER_KEY)).toMatchObject({ revision: 1 });
  });

  it('サービス経由の保存先の変更は、送信が終わるまで待つ（同じ Web Lock）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    const gate = deferred();
    gh.hooks.beforeCommit = () => gate.promise;
    const order: string[] = [];
    const pushing = d.service.push().then(() => order.push('push'));
    await until(() => appPuts(gh).length === 1);
    const saving = d.service.saveConfig(OTHER).then(() => order.push('save'));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([pushing, saving]);
    expect(order).toEqual(['push', 'save']);
  });

  it('同じ世代でも、古い writeId の成功・エラーは新しい送信の pendingPush を変えない（改訂 3 P1-1）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    const { lineage } = await d.gate.read();
    const gen = lineage.generation;
    await d.gate.beginPush(gen, { writeId: uuid(1001), revision: 0, bodySha256: 'a'.repeat(64) }, NOW);
    await d.gate.clearPending(gen, uuid(1001));
    await d.gate.beginPush(gen, { writeId: uuid(1002), revision: 0, bodySha256: 'b'.repeat(64) }, NOW);
    for (const kind of ['network', 'auth', 'conflict'] as const) {
      expect(await d.gate.recordPushError(gen, uuid(1001), kind, false)).toBe(false);
    }
    expect(await d.gate.recordPushLanded(gen, uuid(1001), 'blob-x', NOW)).toBe(false);
    expect(await state(d.gate)).toMatchObject({ pendingPush: { writeId: uuid(1002) }, errorKind: null, lastPushedSha: null });
  });

  it('古い世代を渡した操作は何も書かない（clearErrorForRetry・adoptRemoteSha・saveConfig）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    const { lineage: old } = await d.gate.read();
    await d.service.saveConfig(OTHER);
    const now = await state(d.gate);
    expect(await d.gate.clearErrorForRetry(old.generation)).toBe(false);
    expect(await d.gate.adoptRemoteSha(old.generation, 'blob-x')).toBe(false);
    expect(await d.gate.saveConfig(old.generation, TARGET)).toBe(false);
    expect(await state(d.gate)).toEqual(now);
  });
});

describe('保存先・鍵の変更', () => {
  it('保存先を変えると、記録を足さなくても全件が新しい保存先へ送られる（前の保存先の sha は使わない）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await add(d.repo, '2026-08-29');
    await add(d.repo, '2026-09-20');
    await d.service.push();
    expect(await state(d.gate)).toMatchObject({ lastPushedRevision: 2, needs: false });
    await d.service.saveConfig(OTHER);
    expect(await state(d.gate)).toMatchObject({ lastPushedRevision: null, lastPushedSha: null, needs: true });
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    expect(remote(gh, OTHER_KEY)).toMatchObject({ revision: 2 });
    expect(remote(gh, OTHER_KEY)!.receipts).toHaveLength(2);
    expect(appPuts(gh).at(-1)!.body).not.toHaveProperty('sha');
  });

  it('保存先を外すと新しい世代になり、鍵も消える', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    const before = await state(d.gate);
    expect(await d.service.saveConfig(null)).toBe(true);
    expect(await state(d.gate)).toMatchObject({ config: null, lastPushedRevision: null, status: 'unset' });
    expect((await state(d.gate)).generation).not.toBe(before.generation);
    expect(await d.gate.readToken()).toBeNull();
    expect(await d.service.push()).toEqual({ kind: 'skipped', reason: 'not-configured' });
  });

  it('鍵だけの変更は世代を保ち、auth のエラーを消す', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    gh.hooks.onRequest = () => new Response('{}', { status: 401 });
    expect(await d.service.push()).toMatchObject({ errorKind: 'auth' });
    const before = await state(d.gate);
    gh.hooks.onRequest = undefined;
    await d.service.saveConfig(TARGET, 'github_pat_NEW');
    const after = await state(d.gate);
    expect(after.generation).toBe(before.generation);
    expect(after.errorKind).toBeNull();
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    expect(gh.requests.at(-1)!.headers.Authorization).toBe('Bearer github_pat_NEW');
  });

  it('同じ保存先の設定を保存し直すと invalid も解ける（設計書 §4.0・最終点検 9af66027 P2-2）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await add(d.repo);
    gh.hooks.onRequest = (req) => (req.method === 'PUT' ? new Response('{}', { status: 422 }) : undefined);
    expect(await d.service.push()).toMatchObject({ errorKind: 'invalid' });
    gh.hooks.onRequest = undefined;
    expect(await d.service.push()).toEqual({ kind: 'skipped', reason: 'stopped' });
    const before = await state(d.gate);
    await d.service.saveConfig(TARGET);
    const after = await state(d.gate);
    expect(after.generation).toBe(before.generation);
    expect(after.errorKind).toBeNull();
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
  });

  it('同じ保存先の設定の保存では conflict は解けない（衝突の解決か復元で解く）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await add(d.repo);
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    gh.setRemote(KEY, JSON.stringify({ other: true }));
    await add(d.repo, '2026-09-21');
    expect(await d.service.push()).toMatchObject({ errorKind: 'conflict' });
    await d.service.saveConfig(TARGET);
    expect((await state(d.gate)).errorKind).toBe('conflict');
  });

  it('「今すぐ保存」は止める種類のエラーを消して送る', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    gh.hooks.onRequest = () => new Response('{}', { status: 401 });
    await d.service.push();
    gh.hooks.onRequest = undefined;
    expect(await d.service.push()).toEqual({ kind: 'skipped', reason: 'stopped' });
    expect(await d.service.retryNow()).toMatchObject({ status: 'saved' });
  });
});

describe('§4.1 GitHub Contents API の契約', () => {
  it('ヘッダ・ref・PUT の本文の形、content.sha を記録する（commit.sha ではない）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await d.service.push();
    await add(d.repo);
    await d.service.push();
    for (const r of gh.requests) {
      expect(r.url.startsWith('https://api.github.com/repos/u/kome-data/contents/kome-backup.json')).toBe(true);
      expect(r.headers).toMatchObject({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${TOKEN}` });
      if (r.method === 'GET') expect(r.url.endsWith('?ref=main')).toBe(true);
    }
    const [first, second] = appPuts(gh);
    expect(Object.keys(first!.body!).sort()).toEqual(['branch', 'content', 'message']);
    expect(Object.keys(second!.body!).sort()).toEqual(['branch', 'content', 'message', 'sha']);
    expect((await state(d.gate)).lastPushedSha).toMatch(/^blob-/);
  });

  const cases: [string, () => Response, Record<string, unknown>][] = [
    ['403＋X-RateLimit-Remaining: 0 → rate-limit（再試行は Reset の時刻）', () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse('2026-10-01T04:00:00Z') / 1000) } }), { errorKind: 'rate-limit', retryAfter: '2026-10-01T04:00:00.000Z', keep: true }],
    ['403（rate limit のヘッダなし）→ auth', () => new Response('{}', { status: 403 }), { errorKind: 'auth', keep: false }],
    ['429＋Retry-After: 30 → rate-limit', () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }), { errorKind: 'rate-limit', retryAfter: '2026-10-01T03:00:30.000Z', keep: true }],
    ['PUT の 404 → config', () => new Response('{}', { status: 404 }), { errorKind: 'config', keep: false }],
    ['500 → network', () => new Response('{}', { status: 500 }), { errorKind: 'network', keep: true }],
  ];
  it.each(cases)('%s', async (_label, make, expected) => {
    const gh = fakeGitHub();
    const d = await device(gh);
    gh.hooks.onRequest = (req) => (req.method === 'PUT' ? make() : undefined);
    await d.service.push();
    const s = await state(d.gate);
    expect(s.errorKind).toBe(expected.errorKind);
    if ('retryAfter' in expected) expect(s.retryAfter).toBe(expected.retryAfter);
    expect(s.pendingPush !== null).toBe(expected.keep);
  });

  it('一般の 422（直後の GET の sha が送った sha と同じ）→ invalid。sha 不一致の 409 → conflict', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await d.service.push();
    await add(d.repo);
    gh.hooks.onRequest = (req) => (req.method === 'PUT' ? new Response('{}', { status: 422 }) : undefined);
    expect(await d.service.push()).toMatchObject({ errorKind: 'invalid' });

    const gh2 = fakeGitHub();
    globalThis.indexedDB = new (await import('fake-indexeddb')).IDBFactory();
    const d2 = await device(gh2);
    await d2.service.push();
    gh2.setRemote(KEY, '{"changed":true}');
    await add(d2.repo);
    expect(await d2.service.push()).toMatchObject({ errorKind: 'conflict' });
  });

  it('GitHub 側のファイルが消されていたら、古い sha 付きの PUT で作り直す（実物は 201。衝突にしない）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await d.service.push();
    gh.files.delete(KEY);
    await add(d.repo);
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    expect(appPuts(gh).at(-1)!.body).toHaveProperty('sha');
    expect(remote(gh)).toMatchObject({ revision: 1 });
  });

  it('rate-limit の再試行時刻より前は送らない', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    gh.hooks.onRequest = () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
    await d.service.push();
    gh.hooks.onRequest = undefined;
    const before = gh.requests.length;
    expect(await d.service.push()).toEqual({ kind: 'skipped', reason: 'waiting-retry' });
    expect(gh.requests.length).toBe(before);
  });
});

describe('応答の本文の打ち切りと不正な応答（U2 実装検収 P1-1・P2-1）', () => {
  it('PUT の本文が止まっても打ち切り時間で network になり、pendingPush を残して Web Lock を手放す', async () => {
    const gh = fakeGitHub();
    const d = await device(gh, 'kome', true, 0, 30);
    gh.hooks.onRequest = (req, init) => (req.method === 'PUT' ? stalledResponse(init?.signal, 201, '{"content":') : undefined);
    expect(await d.service.push()).toMatchObject({ errorKind: 'network' });
    expect((await state(d.gate)).pendingPush).not.toBeNull();
    gh.hooks.onRequest = undefined;
    // ロックが空いているので、すぐ次の送信ができる（照合 → 送り直し）
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
  });

  it('照合の GET の本文が止まっても network で、pendingPush は残る', async () => {
    const gh = fakeGitHub();
    const d = await device(gh, 'kome', true, 0, 30);
    await d.service.push();
    await add(d.repo);
    gh.hooks.dropResponseAfterCommit = true;
    await d.service.push();
    gh.hooks.onRequest = (req, init) => (req.method === 'GET' ? stalledResponse(init?.signal) : undefined);
    expect(await d.service.push()).toMatchObject({ errorKind: 'network' });
    expect((await state(d.gate)).pendingPush).not.toBeNull();
  });

  it('GET の本文の途中で切れたら network（invalid にしない）で、次のきっかけで再試行して保存できる', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await d.service.push();
    await add(d.repo);
    gh.hooks.dropResponseAfterCommit = true;
    await d.service.push();
    gh.hooks.onRequest = (req) => (req.method === 'GET' ? cutResponse() : undefined);
    expect(await d.service.push()).toMatchObject({ errorKind: 'network' });
    gh.hooks.onRequest = undefined;
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
  });

  it('GET 200 の本文が null・base64 が壊れている → invalid（例外を漏らさない）', async () => {
    for (const body of ['null', JSON.stringify({ type: 'file', encoding: 'base64', sha: 'x', content: '!!!' })]) {
      globalThis.indexedDB = new (await import('fake-indexeddb')).IDBFactory();
      const gh = fakeGitHub();
      const d = await device(gh);
      gh.hooks.onRequest = (req) => (req.method === 'GET' ? new Response(body, { status: 200 }) : undefined);
      expect(await d.service.previewRestoreFromGitHub()).toMatchObject({ kind: 'error', errorKind: 'invalid' });
    }
  });

  it('PUT 成功の本文が null → network で pendingPush を残し、次の照合で届いたと確かめる', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    let once = true;
    gh.hooks.onRequest = async (req) => {
      if (req.method === 'PUT' && once) {
        once = false;
        gh.hooks.onRequest = undefined;
        const real = await gh.fetch(req.url, { method: 'PUT', headers: req.headers, body: JSON.stringify(req.body) });
        void real;
        return new Response('null', { status: 201 });
      }
    };
    expect(await d.service.push()).toMatchObject({ errorKind: 'network' });
    expect((await state(d.gate)).pendingPush).not.toBeNull();
    const commits = gh.commits.length;
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    expect(gh.commits.length).toBe(commits);
  });
});

describe('§4.2 手順 7 の防御の分岐（409／422 のあとの GET が 404）', () => {
  it('sha を外して 1 回だけやり直し、新規作成で保存できる', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await d.service.push();
    await add(d.repo);
    let step = 0;
    gh.hooks.onRequest = (req) => {
      if (req.method === 'PUT' && step === 0) {
        step = 1;
        return new Response('{}', { status: 409 });
      }
      if (req.method === 'GET' && step === 1) {
        step = 2;
        gh.files.delete(KEY);
        return new Response('{}', { status: 404 });
      }
    };
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    expect(appPuts(gh).at(-1)!.body).not.toHaveProperty('sha');
    expect(remote(gh)).toMatchObject({ revision: 1 });
  });
});

describe('§4.2 手順 9: 周回の上限', () => {
  it('送るたびに端末が変わり続けても 5 周で止まり、エラーは書かず保存待ちが残る', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    let day = 1;
    gh.hooks.beforeCommit = async () => {
      await add(d.repo, `2026-09-${String(day++).padStart(2, '0')}`);
    };
    expect(await d.service.push()).toEqual({ kind: 'skipped', reason: 'loop-limit' });
    expect(appPuts(gh)).toHaveLength(MAX_PUSH_LOOPS);
    expect(await state(d.gate)).toMatchObject({ errorKind: null, needs: true });
  });
});

async function restoreFixture() {
  const gh = fakeGitHub();
  const a = await device(gh, 'phone-a');
  await add(a.repo, '2026-08-29');
  await add(a.repo, '2026-09-20');
  await a.service.push();
  // 端末ごとに ID の番号を分ける（本番の ID は乱数で衝突しない）
  const b = await device(gh, 'phone-b', true, 100_000);
  return { gh, a, b };
}

describe('I8: 復元（§6.1）', () => {
  it('機種変更: 0 件の新しい端末は自動送信で上書きせず conflict で止まり、GitHub から復元すると保存済みになって、以後の送信が通る', async () => {
    const { gh, b } = await restoreFixture();
    const original = gh.text(KEY);
    expect(await b.service.push()).toMatchObject({ errorKind: 'conflict' });
    expect(gh.text(KEY)).toBe(original);
    const p = await b.service.previewRestoreFromGitHub();
    if (p.kind !== 'ok') throw new Error(p.kind);
    expect(p.preview).toMatchObject({ local: { count: 0 }, backup: { count: 2, totalKg: 60, lastDate: '2026-09-20' } });
    expect(await b.service.confirmRestore(p.preview)).toEqual({ kind: 'ok' });
    expect(await b.repo.listReceipts()).toHaveLength(2);
    expect(await state(b.gate)).toMatchObject({ status: 'saved', errorKind: null, lastPushedSha: p.preview.expected.s0 });
    expect(await add(b.repo, '2026-09-30')).toMatchObject({ ok: true });
    expect(await b.service.push()).toMatchObject({ status: 'saved' });
    expect(remote(gh)!.receipts).toHaveLength(3);
  });

  it('確認のあとで端末の記録が変わったら置き換えない', async () => {
    const { b } = await restoreFixture();
    const p = await b.service.previewRestoreFromGitHub();
    if (p.kind !== 'ok') throw new Error();
    await add(b.repo, '2026-09-01');
    expect(await b.service.confirmRestore(p.preview)).toEqual({ kind: 'changed' });
    expect(await b.repo.listReceipts()).toHaveLength(1);
  });

  it('確認のあとで GitHub が変わったら置き換えない', async () => {
    const { gh, a, b } = await restoreFixture();
    const p = await b.service.previewRestoreFromGitHub();
    if (p.kind !== 'ok') throw new Error();
    await add(a.repo, '2026-09-25');
    await a.service.push();
    expect(gh.files.get(KEY)!.sha).not.toBe(p.preview.expected.s0);
    expect(await b.service.confirmRestore(p.preview)).toEqual({ kind: 'changed' });
    expect(await b.repo.listReceipts()).toHaveLength(0);
  });

  it('確認のあとで保存先を変えたら置き換えない', async () => {
    const { b } = await restoreFixture();
    const p = await b.service.previewRestoreFromGitHub();
    if (p.kind !== 'ok') throw new Error();
    await b.service.saveConfig(OTHER);
    expect(await b.service.confirmRestore(p.preview)).toEqual({ kind: 'changed' });
  });

  it('復元のトランザクションの途中で失敗すると端末は元のまま、取り消しのスナップショットも残らない', async () => {
    const { b } = await restoreFixture();
    await add(b.repo, '2026-09-01');
    const before = await b.repo.listReceipts();
    const { lineage, dataRevision } = await b.gate.read();
    const dup = { ...before[0]!, id: uuid(77) };
    await expect(b.gate.restore({ d0: dataRevision, g0: lineage.generation, s0: null }, [dup, dup], 'file', NOW)).rejects.toBeTruthy();
    expect(await b.repo.listReceipts()).toEqual(before);
    expect((await b.gate.read()).dataRevision).toBe(dataRevision);
    expect(await b.gate.hasPreRestoreSnapshot()).toBe(false);
  });

  it('取り消しで復元前に完全に戻り、dataRevision は 1 進む', async () => {
    const { b } = await restoreFixture();
    await add(b.repo, '2026-09-01');
    const before = await b.repo.listReceipts();
    const p = await b.service.previewRestoreFromGitHub();
    if (p.kind !== 'ok') throw new Error();
    await b.service.confirmRestore(p.preview);
    const restoredRevision = (await b.gate.read()).dataRevision;
    expect(await b.service.undoRestore()).toBe('ok');
    expect(await b.repo.listReceipts()).toEqual(before);
    expect((await b.gate.read()).dataRevision).toBe(restoredRevision + 1);
    expect(await b.service.undoRestore()).toBe('no-snapshot');
  });

  it('ネット不通で pendingPush が残った状態で JSON から復元すると pendingPush が消え、復元後のデータが保存済み扱いにならない（改訂 2 P1-3）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await d.service.push();
    await add(d.repo, '2026-08-29');
    gh.hooks.dropResponseAfterCommit = true; // 旧 pending の本文は GitHub に届いている
    await d.service.push();
    expect((await state(d.gate)).pendingPush).not.toBeNull();
    const file = buildBackup({ deviceId: uuid(500), writeId: uuid(501), revision: 9, exportedAt: NOW.toISOString(), appVersion: '0.1.0', receipts: [] });
    const p = await d.service.previewRestoreFromFile(file.bytes);
    if (p.kind !== 'ok') throw new Error();
    expect(await d.service.confirmRestore(p.preview)).toEqual({ kind: 'ok' });
    expect(await state(d.gate)).toMatchObject({ pendingPush: null, errorKind: null, needs: true });
    await d.service.push();
    const s = await state(d.gate);
    expect(s.status).not.toBe('saved');
    expect(s.lastPushedRevision === null || s.lastPushedRevision < s.dataRevision).toBe(true);
  });

  it('ファイルの検証に通らなければ確認に進まない', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    expect(await d.service.previewRestoreFromFile(new TextEncoder().encode('not json'))).toMatchObject({ kind: 'invalid' });
    expect(await d.service.previewRestoreFromFile(new TextEncoder().encode('{"format":"kome-backup","schemaVersion":2}'))).toMatchObject({ kind: 'invalid', reason: 'newer-schema' });
  });
});

describe('I15: 購入の記録はバックアップ・復元に入らない（設計書 §10）', () => {
  const PURCHASE = { kg: 240, date: '2026-09-01' };

  it('送る写しと書き出しのファイルに購入の記録が入らない', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await add(d.repo);
    expect(await d.repo.setPurchase(PURCHASE, NOW)).toMatchObject({ ok: true });
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    expect(gh.text(KEY)).not.toContain('purchase');
    expect(Object.keys(remote(gh)!).sort()).toEqual(['appVersion', 'deviceId', 'exportedAt', 'format', 'receipts', 'revision', 'schemaVersion', 'writeId']);
    const file = await d.service.exportFile();
    expect(new TextDecoder().decode(file.bytes)).not.toContain('purchase');
  });

  it('購入の記録を変えても送信は要らないまま（保存済みのまま）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    await add(d.repo);
    await d.service.push();
    const puts = appPuts(gh).length;
    await d.repo.setPurchase(PURCHASE, NOW);
    expect(await state(d.gate)).toMatchObject({ needs: false, status: 'saved' });
    expect(await d.service.push()).toMatchObject({ status: 'saved' });
    expect(appPuts(gh)).toHaveLength(puts);
  });

  it('GitHub から復元・取り消しをしても購入の記録は変わらない', async () => {
    const { b } = await restoreFixture();
    await b.repo.setPurchase(PURCHASE, NOW);
    const p = await b.service.previewRestoreFromGitHub();
    if (p.kind !== 'ok') throw new Error(p.kind);
    expect(await b.service.confirmRestore(p.preview)).toEqual({ kind: 'ok' });
    expect(await b.repo.getPurchase()).toMatchObject(PURCHASE);
    expect(await b.service.undoRestore()).toBe('ok');
    expect(await b.repo.getPurchase()).toMatchObject(PURCHASE);
  });

  it('ファイルから復元しても購入の記録は変わらない（購入の記録の無い端末でも増えない）', async () => {
    const gh = fakeGitHub();
    const d = await device(gh);
    const file = buildBackup({ deviceId: uuid(500), writeId: uuid(501), revision: 3, exportedAt: NOW.toISOString(), appVersion: '1.0.3', receipts: [] });
    let p = await d.service.previewRestoreFromFile(file.bytes);
    if (p.kind !== 'ok') throw new Error();
    await d.service.confirmRestore(p.preview);
    expect(await d.repo.getPurchase()).toBeNull();
    await d.repo.setPurchase(PURCHASE, NOW);
    p = await d.service.previewRestoreFromFile(file.bytes);
    if (p.kind !== 'ok') throw new Error();
    expect(await d.service.confirmRestore(p.preview)).toEqual({ kind: 'ok' });
    expect(await d.repo.getPurchase()).toMatchObject(PURCHASE);
  });
});

describe('I10: 鍵は Authorization ヘッダ以外に出さない', () => {
  it('送信本文・URL・エラー文言・書き出しファイルに鍵が含まれない', async () => {
    const gh = fakeGitHub();
    const d: { repo: Repo; gate: LineageGate; service: BackupService } = await device(gh);
    await add(d.repo);
    await d.service.push();
    gh.hooks.onRequest = () => new Response('{}', { status: 401 });
    await add(d.repo, '2026-09-21');
    await d.service.push();
    for (const r of gh.requests) {
      expect(r.url.startsWith('https://api.github.com/')).toBe(true);
      expect(r.url).not.toContain(TOKEN);
      expect(JSON.stringify(r.body ?? {})).not.toContain(TOKEN);
    }
    expect(JSON.stringify(await d.gate.read())).not.toContain(TOKEN);
    const exported = await d.service.exportFile();
    expect(new TextDecoder().decode(exported.bytes)).not.toContain(TOKEN);
  });
});
