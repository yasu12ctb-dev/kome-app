import { toLocalYmd } from '../data/date';
import type { BackupConfig, BackupErrorKind, Receipt } from '../data/types';
import { buildBackup, parseBackupBytes, sha256Hex, summarize, type BackupFile } from './format';
import { createGitHubClient, type GitHubClient } from './github';
import { displayStatus, isStopError, needsPush, type DisplayStatus, type LineageGate } from './lineage';
import type { Lineage } from '../data/types';
import { withBackupLock } from './lock';

// GitHub 自動保存（設計書 §4.2）・衝突の解決（§4.3）・復元（§6.1）

/** 1 回の送信で回す最大の周回数（§4.2 手順 9） */
export const MAX_PUSH_LOOPS = 5;

export interface BackupServiceOptions {
  gate: LineageGate;
  appVersion: string;
  newId?: () => string;
  now?: () => Date;
  /** 試験で GitHub を差し替える入口。本番では鍵から通常のクライアントを作る */
  client?: (token: string) => GitHubClient;
}

export type PushOutcome =
  | { kind: 'skipped'; reason: 'busy' | 'not-configured' | 'stopped' | 'waiting-retry' | 'up-to-date' | 'no-token' | 'loop-limit' }
  | { kind: 'done'; status: DisplayStatus; errorKind: BackupErrorKind | null }
  /** GitHub の確かめ（§4.5）の GET が失敗した。系譜には何も書いていない */
  | { kind: 'verify-failed'; errorKind: BackupErrorKind; message: string };

export interface RestorePreview {
  source: 'github' | 'file';
  local: ReturnType<typeof summarize>;
  backup: ReturnType<typeof summarize>;
  /** 確定時に照合する値（§6.1 手順 2） */
  expected: { d0: number; g0: string; s0: string | null };
  file: BackupFile;
}

export type PreviewResult =
  | { kind: 'ok'; preview: RestorePreview }
  | { kind: 'not-configured' }
  | { kind: 'no-backup' }
  | { kind: 'invalid'; reason: 'newer-schema' | 'invalid'; errors: string[] }
  | { kind: 'error'; errorKind: BackupErrorKind; message: string };

export type ConfirmResult = { kind: 'ok' } | { kind: 'changed' } | { kind: 'error'; errorKind: BackupErrorKind; message: string };

export interface BackupService {
  /** verify が真なら、送る必要が無いときも GitHub を確かめる（§4.5。起動・前面復帰） */
  push(options?: { verify?: boolean }): Promise<PushOutcome>;
  /** 設定画面の「今すぐ保存」: エラーを消してから送り、送る必要が無ければ GitHub を確かめる（§4.0・§4.5） */
  retryNow(): Promise<PushOutcome>;
  saveConfig(config: BackupConfig | null, token?: string): Promise<boolean>;
  /** 衝突の解決「端末の内容で上書き」（§4.3） */
  overwriteRemote(): Promise<PushOutcome | { kind: 'error'; errorKind: BackupErrorKind; message: string }>;
  previewRestoreFromGitHub(): Promise<PreviewResult>;
  previewRestoreFromFile(bytes: Uint8Array): Promise<PreviewResult>;
  confirmRestore(preview: RestorePreview): Promise<ConfirmResult>;
  undoRestore(): Promise<'ok' | 'stale' | 'no-snapshot'>;
  /** 手動の「JSON ファイルに書き出す」。鍵は入らない（I10） */
  exportFile(): Promise<{ bytes: Uint8Array<ArrayBuffer>; fileName: string }>;
}

export function createBackupService(options: BackupServiceOptions): BackupService {
  const { gate } = options;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const makeClient = options.client ?? ((token: string) => createGitHubClient({ token }));

  async function clientFor(): Promise<GitHubClient | null> {
    const token = await gate.readToken();
    return token ? makeClient(token) : null;
  }

  function pushMessage(revision: number, receipts: readonly Receipt[]): string {
    const s = summarize(receipts);
    return `kome: rev ${revision}（${s.count}件・累計 ${s.totalKg}kg）`;
  }

  /** §4.5 GitHub の確かめ。Web Lock を持った状態で、送る必要が無いときだけ呼ぶ */
  async function verifyLocked(L: Lineage): Promise<PushOutcome> {
    if (L.config === null) return { kind: 'skipped', reason: 'not-configured' };
    const client = await clientFor();
    if (client === null) return { kind: 'skipped', reason: 'no-token' };
    const S = L.lastPushedSha;
    const g = await client.get(L.config);
    // 失敗は系譜に書かない（確かめられなかっただけ）
    if (g.kind === 'error') return { kind: 'verify-failed', errorKind: g.errorKind, message: g.message };
    if (g.kind === 'ok' && g.sha !== S) {
      await gate.recordRemoteChanged(L.generation, S, 'GitHub 側のファイルが、この端末の送った内容から変わっています');
    } else if (g.kind === 'not-found' && S !== null) {
      await gate.recordRemoteChanged(L.generation, S, 'GitHub 側のファイルが見つかりません（外で消された可能性があります）');
    }
    return finish();
  }

  /** §4.2 手順 2〜9。Web Lock を持った状態で呼ぶ */
  async function pushLocked(verify = false): Promise<PushOutcome> {
    let loops = 0;
    let notFoundRetried = false;
    while (loops < MAX_PUSH_LOOPS) {
      const { lineage: L, dataRevision } = await gate.read();
      if (L.config === null) return { kind: 'skipped', reason: 'not-configured' };
      if (isStopError(L.errorKind)) return { kind: 'skipped', reason: 'stopped' };
      if (L.retryAfter !== null && Date.parse(L.retryAfter) > now().getTime()) return { kind: 'skipped', reason: 'waiting-retry' };
      if (!needsPush(L, dataRevision)) return verify && loops === 0 ? verifyLocked(L) : finish();
      const client = await clientFor();
      if (client === null) return { kind: 'skipped', reason: 'no-token' };
      const target = L.config;
      loops += 1;

      // 手順 3: 前回の送信が届いたか分からないまま残っていれば、先に照合する
      if (L.pendingPush !== null) {
        const p = L.pendingPush;
        const g = await client.get(target);
        if (g.kind === 'error') {
          await gate.recordPushError(L.generation, p.writeId, g.errorKind, true, g.retryAfter, g.message);
          return finish();
        }
        if (g.kind === 'ok' && (await sha256Hex(g.bytes)) === p.bodySha256) {
          await gate.recordPushLanded(L.generation, p.writeId, g.sha, now());
        } else if ((g.kind === 'ok' && g.sha === L.lastPushedSha) || (g.kind === 'not-found' && L.lastPushedSha === null)) {
          await gate.clearPending(L.generation, p.writeId);
        } else {
          await gate.recordPushError(L.generation, p.writeId, 'conflict', false, null, 'GitHub 側に、この端末が送っていないデータがあります');
          return finish();
        }
        continue;
      }

      // 手順 4: 1 つの読み取りトランザクションで写しの元を読み、閉じてから本文とハッシュを作る
      const snap = await gate.readSnapshot();
      const writeId = newId();
      const { bytes } = buildBackup({
        deviceId: snap.deviceId,
        writeId,
        revision: snap.dataRevision,
        exportedAt: now().toISOString(),
        appVersion: options.appVersion,
        receipts: snap.receipts,
      });
      const bodySha256 = await sha256Hex(bytes);

      // 手順 5: PUT より前に pendingPush を確定する
      if (!(await gate.beginPush(L.generation, { writeId, revision: snap.dataRevision, bodySha256 }, now()))) continue;

      // 手順 6・7
      const sentSha = L.lastPushedSha;
      const put = await client.put(target, { bytes, message: pushMessage(snap.dataRevision, snap.receipts), sha: sentSha });
      if (put.kind === 'ok') {
        await gate.recordPushLanded(L.generation, writeId, put.sha, now());
        continue;
      }
      if (put.kind === 'error') {
        const keep = put.errorKind === 'network' || put.errorKind === 'rate-limit';
        await gate.recordPushError(L.generation, writeId, put.errorKind, keep, put.retryAfter, put.message);
        return finish();
      }
      // sha 衝突の候補: PUT は拒否された。直後の GET で決める
      const g = await client.get(target);
      if (g.kind === 'error') {
        await gate.recordPushError(L.generation, writeId, g.errorKind, false, g.retryAfter, g.message);
        return finish();
      }
      if (g.kind === 'ok') {
        if ((await sha256Hex(g.bytes)) === bodySha256) {
          await gate.recordPushLanded(L.generation, writeId, g.sha, now());
          continue;
        }
        const kind: BackupErrorKind = put.status === 422 && sentSha !== null && g.sha === sentSha ? 'invalid' : 'conflict';
        await gate.recordPushError(L.generation, writeId, kind, false, null, kind === 'conflict' ? 'GitHub 側に、この端末が送っていないデータがあります' : `HTTP ${put.status}`);
        return finish();
      }
      // GET 404
      if (sentSha === null) {
        await gate.recordPushError(L.generation, writeId, 'invalid', false, null, 'ファイルが無いのに作成が拒否されました');
        return finish();
      }
      if (!notFoundRetried) {
        notFoundRetried = true;
        await gate.resetRemote(L.generation, writeId);
        continue;
      }
      await gate.recordPushError(L.generation, writeId, 'conflict', false, null, 'GitHub 側のファイルが見つかりません');
      return finish();
    }
    // 手順 9: 周回の上限。writeId を持たないのでエラーは書かない（needsPush が残り、次のきっかけで再開）
    return { kind: 'skipped', reason: 'loop-limit' };
  }

  async function finish(): Promise<PushOutcome> {
    const { lineage, dataRevision } = await gate.read();
    return { kind: 'done', status: displayStatus(lineage, dataRevision), errorKind: lineage.errorKind };
  }

  function today(): string {
    return toLocalYmd(now());
  }

  async function localSummary() {
    const snap = await gate.readSnapshot();
    return { snap, summary: summarize(snap.receipts) };
  }

  return {
    async push(options) {
      const result = await withBackupLock({ ifAvailable: true }, () => pushLocked(options?.verify === true));
      return result ?? { kind: 'skipped', reason: 'busy' };
    },

    async retryNow() {
      const result = await withBackupLock({ ifAvailable: false }, async () => {
        const { lineage } = await gate.read();
        await gate.clearErrorForRetry(lineage.generation);
        return pushLocked(true);
      });
      return result ?? { kind: 'skipped', reason: 'busy' };
    },

    async saveConfig(config, token) {
      const ok = await withBackupLock({ ifAvailable: false }, async () => {
        const { lineage } = await gate.read();
        return gate.saveConfig(lineage.generation, config, token);
      });
      return ok === true;
    },

    async overwriteRemote() {
      const result = await withBackupLock({ ifAvailable: false }, async () => {
        const { lineage } = await gate.read();
        if (lineage.config === null) return { kind: 'skipped', reason: 'not-configured' } as const;
        const client = await clientFor();
        if (client === null) return { kind: 'skipped', reason: 'no-token' } as const;
        const g = await client.get(lineage.config);
        if (g.kind === 'error') return { kind: 'error', errorKind: g.errorKind, message: g.message } as const;
        // ファイルが無ければ sha なしの新規作成になる
        await gate.adoptRemoteSha(lineage.generation, g.kind === 'ok' ? g.sha : null);
        return pushLocked();
      });
      return result ?? { kind: 'skipped', reason: 'busy' };
    },

    async previewRestoreFromGitHub() {
      const { lineage, dataRevision } = await gate.read();
      if (lineage.config === null) return { kind: 'not-configured' };
      const client = await clientFor();
      if (client === null) return { kind: 'not-configured' };
      const g = await client.get(lineage.config);
      if (g.kind === 'not-found') return { kind: 'no-backup' };
      if (g.kind === 'error') return { kind: 'error', errorKind: g.errorKind, message: g.message };
      const parsed = parseBackupBytes(g.bytes, today());
      if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason, errors: parsed.errors };
      const { summary } = await localSummary();
      return {
        kind: 'ok',
        preview: {
          source: 'github',
          local: summary,
          backup: summarize(parsed.value.receipts),
          expected: { d0: dataRevision, g0: lineage.generation, s0: g.sha },
          file: parsed.value,
        },
      };
    },

    async previewRestoreFromFile(bytes) {
      const parsed = parseBackupBytes(bytes, today());
      if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason, errors: parsed.errors };
      const { lineage, dataRevision } = await gate.read();
      const { summary } = await localSummary();
      return {
        kind: 'ok',
        preview: {
          source: 'file',
          local: summary,
          backup: summarize(parsed.value.receipts),
          expected: { d0: dataRevision, g0: lineage.generation, s0: null },
          file: parsed.value,
        },
      };
    },

    async confirmRestore(preview) {
      const result = await withBackupLock({ ifAvailable: false }, async (): Promise<ConfirmResult> => {
        if (preview.source === 'github') {
          const { lineage } = await gate.read();
          const client = await clientFor();
          if (lineage.config === null || client === null) return { kind: 'changed' };
          const g = await client.get(lineage.config);
          if (g.kind === 'error') return { kind: 'error', errorKind: g.errorKind, message: g.message };
          if (g.kind === 'not-found' || g.sha !== preview.expected.s0) return { kind: 'changed' };
        }
        const ok = await gate.restore(preview.expected, preview.file.receipts, preview.source, now());
        return ok ? { kind: 'ok' } : { kind: 'changed' };
      });
      return result ?? { kind: 'changed' };
    },

    async undoRestore() {
      const result = await withBackupLock({ ifAvailable: false }, async () => {
        const { lineage } = await gate.read();
        return gate.undoRestore(lineage.generation);
      });
      return result ?? 'stale';
    },

    async exportFile() {
      const snap = await gate.readSnapshot();
      const { bytes } = buildBackup({
        deviceId: snap.deviceId,
        writeId: newId(),
        revision: snap.dataRevision,
        exportedAt: now().toISOString(),
        appVersion: options.appVersion,
        receipts: snap.receipts,
      });
      return { bytes, fileName: `kome-backup-${today()}.json` };
    },
  };
}
