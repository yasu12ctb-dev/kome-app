import { useCallback, useEffect, useRef, useState } from 'react';
import { createChangeChannel, type ChangeChannel } from '../app/channel';
import { attachPushTriggers, createPushScheduler, type PushScheduler } from '../app/scheduler';
import { createReloadGate, isBusy } from '../app/autoUpdate';
import type { LineageGate } from '../backup/lineage';
import { createBackupService, type BackupService, type ConfirmResult, type PreviewResult, type RestorePreview } from '../backup/service';
import { toLocalYmd } from '../data/date';
import type { StopReason } from '../data/db';
import { openRepo, type ReceiptInput, type Repo, type WriteResult, type DeleteResult } from '../data/repo';
import type { AppMeta, BackupConfig, Lineage, Receipt, Ymd } from '../data/types';

// 画面とデータ基盤・バックアップをつなぐ（設計書 §6 の起動手順・§4.0 の送信のきっかけ・§7 の複数タブ）

export const APP_VERSION: string = __APP_VERSION__;

export type KomeState =
  | { kind: 'loading' }
  | { kind: 'stopped'; reason: StopReason | 'other-tab-upgrade' }
  | { kind: 'ready'; receipts: Receipt[]; meta: AppMeta; lineage: Lineage; hasSnapshot: boolean; today: Ymd };

export interface KomeActions {
  add(input: ReceiptInput): Promise<WriteResult>;
  update(id: string, input: ReceiptInput): Promise<WriteResult>;
  remove(id: string): Promise<DeleteResult>;
  saveConfig(config: BackupConfig | null, token?: string): Promise<boolean>;
  retryNow(): Promise<void>;
  overwriteRemote(): Promise<void>;
  previewFromGitHub(): Promise<PreviewResult>;
  previewFromFile(bytes: Uint8Array): Promise<PreviewResult>;
  confirmRestore(preview: RestorePreview): Promise<ConfirmResult>;
  undoRestore(): Promise<'ok' | 'stale' | 'no-snapshot'>;
  exportFile(): Promise<{ bytes: Uint8Array<ArrayBuffer>; fileName: string }>;
}

export function useKome(): { state: KomeState; actions: KomeActions } {
  const [state, setState] = useState<KomeState>({ kind: 'loading' });
  const repoRef = useRef<Repo | null>(null);
  const gateRef = useRef<LineageGate | null>(null);
  const serviceRef = useRef<BackupService | null>(null);
  const schedulerRef = useRef<PushScheduler | null>(null);
  const channelRef = useRef<ChangeChannel | null>(null);

  const refresh = useCallback(async () => {
    const repo = repoRef.current;
    const gate = gateRef.current;
    if (!repo || !gate) return;
    const [receipts, meta, l, hasSnapshot] = await Promise.all([repo.listReceipts(), repo.getAppMeta(), gate.read(), gate.hasPreRestoreSnapshot()]);
    setState({ kind: 'ready', receipts, meta, lineage: l.lineage, hasSnapshot, today: toLocalYmd(new Date()) });
  }, []);

  useEffect(() => {
    let disposed = false;
    let detach: (() => void) | null = null;
    const reloadGate = createReloadGate({ busy: () => isBusy(document), reload: () => window.location.reload() });
    void (async () => {
      // §6 手順 4: 保存領域を消されにくくする
      void navigator.storage?.persist?.().catch(() => false);
      const opened = await openRepo({
        onChange: () => {
          schedulerRef.current?.notifyChange();
          channelRef.current?.post();
        },
        onVersionChange: () => {
          // 別のタブが新しい版で DB を上げた。この画面は閉じて読み込み直す
          setState({ kind: 'stopped', reason: 'other-tab-upgrade' });
          reloadGate.request();
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
        push: async () => {
          await service.push();
          await refresh();
        },
      });
      schedulerRef.current = scheduler;
      channelRef.current = createChangeChannel(() => void refresh());
      const detachTriggers = attachPushTriggers(scheduler, window);
      const onVisible = () => {
        if (document.visibilityState === 'visible') void refresh();
      };
      document.addEventListener('visibilitychange', onVisible);
      document.addEventListener('focusout', () => setTimeout(() => reloadGate.tryReload(), 0));
      detach = () => {
        detachTriggers();
        document.removeEventListener('visibilitychange', onVisible);
      };
      await refresh();
      // §6 手順 7: 起動時に裏で送る（画面の描画を待たせない）
      scheduler.triggerNow();
    })();
    return () => {
      disposed = true;
      detach?.();
      schedulerRef.current?.dispose();
      channelRef.current?.close();
      repoRef.current?.close();
    };
  }, [refresh]);

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
    async saveConfig(config, token) {
      const ok = await service().saveConfig(config, token);
      await afterBackupChange();
      // 設定の保存後はすぐ送る（§4.0）
      if (ok && config !== null) schedulerRef.current?.triggerNow();
      return ok;
    },
    async retryNow() {
      await service().retryNow();
      await afterBackupChange();
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
