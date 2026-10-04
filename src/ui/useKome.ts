import { useCallback, useEffect, useRef, useState } from 'react';
import { createChangeChannel, type ChangeChannel } from '../app/channel';
import { attachPushTriggers, createPushScheduler, type PushScheduler } from '../app/scheduler';
import type { ReloadCoordinator } from '../app/reload';
import { msUntilNextLocalDay } from '../app/clock';
import type { LineageGate } from '../backup/lineage';
import { createBackupService, type BackupService, type ConfirmResult, type PreviewResult, type RestorePreview } from '../backup/service';
import { toLocalYmd } from '../data/date';
import type { StopReason } from '../data/db';
import { openRepo, type PurchaseResult, type ReceiptInput, type Repo, type WriteResult, type DeleteResult } from '../data/repo';
import type { AppMeta, BackupConfig, Lineage, Purchase, Receipt, Ymd } from '../data/types';

// 画面とデータ基盤・バックアップをつなぐ（設計書 §6 の起動手順・§4.0 の送信のきっかけ・§7 の複数タブ）

export const APP_VERSION: string = __APP_VERSION__;

export type KomeState =
  | { kind: 'loading' }
  | { kind: 'stopped'; reason: StopReason | 'other-tab-upgrade' }
  | {
      kind: 'ready';
      receipts: Receipt[];
      /** 購入の記録（端末の中だけ。設計書 §10） */
      purchase: Purchase | null;
      meta: AppMeta;
      lineage: Lineage;
      hasSnapshot: boolean;
      today: Ymd;
      /** 別のタブが新しい版で DB を上げた。DB は閉じてあり書けない。入力を終えたら読み込み直す */
      upgrading: boolean;
    };

export interface KomeActions {
  add(input: ReceiptInput): Promise<WriteResult>;
  update(id: string, input: ReceiptInput): Promise<WriteResult>;
  remove(id: string): Promise<DeleteResult>;
  setPurchase(input: { kg: number; date: string }): Promise<PurchaseResult>;
  clearPurchase(): Promise<PurchaseResult>;
  saveConfig(config: BackupConfig | null, token?: string): Promise<boolean>;
  /** 今すぐ保存。GitHub と確かめられなかったら false（§4.5） */
  retryNow(): Promise<boolean>;
  overwriteRemote(): Promise<void>;
  previewFromGitHub(): Promise<PreviewResult>;
  previewFromFile(bytes: Uint8Array): Promise<PreviewResult>;
  confirmRestore(preview: RestorePreview): Promise<ConfirmResult>;
  undoRestore(): Promise<'ok' | 'stale' | 'no-snapshot'>;
  exportFile(): Promise<{ bytes: Uint8Array<ArrayBuffer>; fileName: string }>;
}

export function useKome(coordinator: ReloadCoordinator): { state: KomeState; actions: KomeActions } {
  const [state, setState] = useState<KomeState>({ kind: 'loading' });
  const repoRef = useRef<Repo | null>(null);
  const gateRef = useRef<LineageGate | null>(null);
  const serviceRef = useRef<BackupService | null>(null);
  const schedulerRef = useRef<PushScheduler | null>(null);
  const channelRef = useRef<ChangeChannel | null>(null);
  const upgradingRef = useRef(false);

  const refresh = useCallback(async () => {
    const repo = repoRef.current;
    const gate = gateRef.current;
    if (!repo || !gate || upgradingRef.current) return;
    const [receipts, purchase, meta, l, hasSnapshot] = await Promise.all([repo.listReceipts(), repo.getPurchase(), repo.getAppMeta(), gate.read(), gate.hasPreRestoreSnapshot()]);
    setState((prev) => ({
      kind: 'ready',
      receipts,
      purchase,
      meta,
      lineage: l.lineage,
      hasSnapshot,
      today: toLocalYmd(new Date()),
      upgrading: prev.kind === 'ready' ? prev.upgrading : false,
    }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let detach: (() => void) | null = null;
    void (async () => {
      // §6 手順 4: 保存領域を消されにくくする
      void navigator.storage?.persist?.().catch(() => false);
      const opened = await openRepo({
        onChange: () => {
          schedulerRef.current?.notifyChange();
          channelRef.current?.post();
        },
        // 購入の記録は送る内容に入らないので、送信は予約せず他タブへ知らせるだけ（設計書 §10）
        onPurchaseChange: () => channelRef.current?.post(),
        onVersionChange: () => {
          // 別のタブが新しい版で DB を上げた。DB は閉じた（db.ts）。画面は残して入力を守り、
          // 送信のきっかけと読み直しを止め、窓口に予約する（§6.2 の db-upgrade）
          upgradingRef.current = true;
          schedulerRef.current?.dispose();
          setState((prev) => (prev.kind === 'ready' ? { ...prev, upgrading: true } : { kind: 'stopped', reason: 'other-tab-upgrade' }));
          coordinator.request('db-upgrade');
        },
      });
      if (disposed) return;
      if (opened.kind === 'stopped') {
        setState({ kind: 'stopped', reason: opened.reason });
        return;
      }
      repoRef.current = opened.repo;
      gateRef.current = opened.lineage;
      const service = createBackupService({ gate: opened.lineage, appVersion: APP_VERSION });
      serviceRef.current = service;
      const scheduler = createPushScheduler({
        push: async (opts) => {
          await service.push(opts);
          await refresh();
        },
      });
      schedulerRef.current = scheduler;
      channelRef.current = createChangeChannel(() => void refresh());
      const detachTriggers = attachPushTriggers(scheduler, window, { now: () => Date.now(), verifiedAt: Date.now() });
      const onVisible = () => {
        if (document.visibilityState === 'visible') void refresh();
      };
      document.addEventListener('visibilitychange', onVisible);
      // 開いたまま日付が変わったら「今日」を更新する（0 時を少し過ぎた時点で読み直す）
      let midnightTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleMidnight = () => {
        midnightTimer = setTimeout(() => {
          void refresh();
          scheduleMidnight();
        }, msUntilNextLocalDay(new Date()));
      };
      scheduleMidnight();
      detach = () => {
        if (midnightTimer !== null) clearTimeout(midnightTimer);
        detachTriggers();
        document.removeEventListener('visibilitychange', onVisible);
      };
      await refresh();
      // §6 手順 7: 起動時に裏で送る（画面の描画を待たせない）。送る必要が無くても GitHub を確かめる（§4.5）
      scheduler.triggerNow({ verify: true });
    })();
    return () => {
      disposed = true;
      detach?.();
      schedulerRef.current?.dispose();
      channelRef.current?.close();
      repoRef.current?.close();
    };
  }, [refresh, coordinator]);

  const service = () => {
    const s = serviceRef.current;
    if (!s) throw new Error('not ready');
    return s;
  };
  const repo = () => {
    const r = repoRef.current;
    if (!r) throw new Error('not ready');
    return r;
  };
  const afterBackupChange = async () => {
    await refresh();
    channelRef.current?.post();
  };

  const actions: KomeActions = {
    async add(input) {
      const r = await repo().addReceipt(input);
      if (r.ok) await refresh();
      return r;
    },
    async update(id, input) {
      const r = await repo().updateReceipt(id, input);
      if (r.ok) await refresh();
      return r;
    },
    async remove(id) {
      const r = await repo().deleteReceipt(id);
      if (r.ok) await refresh();
      return r;
    },
    async setPurchase(input) {
      const r = await repo().setPurchase(input);
      if (r.ok) await refresh();
      return r;
    },
    async clearPurchase() {
      const r = await repo().clearPurchase();
      if (r.ok) await refresh();
      return r;
    },
    async saveConfig(config, token) {
      const ok = await service().saveConfig(config, token);
      await afterBackupChange();
      // 設定の保存後はすぐ送る（§4.0）
      if (ok && config !== null) schedulerRef.current?.triggerNow();
      return ok;
    },
    async retryNow() {
      const r = await service().retryNow();
      await afterBackupChange();
      return r.kind !== 'verify-failed';
    },
    async overwriteRemote() {
      await service().overwriteRemote();
      await afterBackupChange();
    },
    previewFromGitHub: () => service().previewRestoreFromGitHub(),
    previewFromFile: (bytes) => service().previewRestoreFromFile(bytes),
    async confirmRestore(preview) {
      const r = await service().confirmRestore(preview);
      await afterBackupChange();
      if (r.kind === 'ok') schedulerRef.current?.triggerNow();
      return r;
    },
    async undoRestore() {
      const r = await service().undoRestore();
      await afterBackupChange();
      if (r === 'ok') schedulerRef.current?.triggerNow();
      return r;
    },
    exportFile: () => service().exportFile(),
  };

  return { state, actions };
}
