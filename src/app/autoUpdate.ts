// 自動アップデート（設計書 §6 手順 5・§6.2）。新しい版の検知は 2 経路（Service Worker の controllerchange と
// vite-plugin-pwa の onNeedReload）あり、どちらも読み込み直しの窓口へ予約するだけにする。

import type { ReloadCoordinator } from './reload';

export { isBusy } from './reload';

export interface AutoUpdateDeps {
  win: Window;
  coordinator: ReloadCoordinator;
  /** vite-plugin-pwa の registerSW */
  registerSW: (options: {
    immediate: boolean;
    onNeedReload: () => void;
    onRegisteredSW: (url: string, reg: ServiceWorkerRegistration | undefined) => void;
  }) => unknown;
  checkIntervalMs?: number;
}

export function setupAutoUpdate(deps: AutoUpdateDeps): void {
  const { win, coordinator } = deps;
  const sw = win.navigator.serviceWorker;
  if (!sw) return;
  // 初回のインストールで制御が付いたときは読み込み直さない
  const hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (hadController) coordinator.request('sw-update');
  });
  deps.registerSW({
    immediate: true,
    // vite-plugin-pwa（autoUpdate）は onNeedReload が無いと内部で直接ページを読み込み直す（location.reload）。
    // 必ず窓口へ予約させ、内部の経路を使わせない（§6.2）
    onNeedReload: () => coordinator.request('sw-update'),
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const checkForUpdate = () => {
        reg.update().catch(() => {});
      };
      win.setInterval(checkForUpdate, deps.checkIntervalMs ?? 60 * 60 * 1000);
      win.document.addEventListener('visibilitychange', () => {
        if (win.document.visibilityState === 'visible') checkForUpdate();
      });
      win.addEventListener('focus', checkForUpdate);
    },
  });
}

/** 停止モード（I13）から新しい版を取りに行く */
export async function requestAppUpdate(win: Window): Promise<void> {
  const reg = await win.navigator.serviceWorker?.getRegistration();
  await reg?.update().catch(() => {});
}
