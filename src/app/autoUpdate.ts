// 自動アップデート（設計書 §6 手順 5・I11。Libroli の方式: Vault Knowledge/pwa-auto-update-reload.md）。
// 新しい版が来たら再読み込みを予約し、入力中・未保存のフォーム・ダイアログ表示中は待つ。

/** 再読み込みしてはいけない状態か */
export function isBusy(doc: Document): boolean {
  const el = doc.activeElement as HTMLElement | null;
  if (el) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  }
  if (doc.querySelector('[data-dirty="true"]')) return true;
  if (doc.querySelector('[role="dialog"]')) return true;
  return false;
}

export interface ReloadGate {
  /** 新しい版が有効になった。可能なら再読み込み、無理なら予約 */
  request(): void;
  /** 予約があり、今なら再読み込みしてよければする */
  tryReload(): void;
}

export function createReloadGate(deps: { busy: () => boolean; reload: () => void }): ReloadGate {
  let pending = false;
  let reloading = false;
  const tryReload = () => {
    if (!pending || reloading || deps.busy()) return;
    reloading = true;
    deps.reload();
  };
  return {
    request() {
      pending = true;
      tryReload();
    },
    tryReload,
  };
}

export interface AutoUpdateDeps {
  win: Window;
  /** vite-plugin-pwa の registerSW */
  registerSW: (options: { immediate: boolean; onRegisteredSW: (url: string, reg: ServiceWorkerRegistration | undefined) => void }) => unknown;
  checkIntervalMs?: number;
}

export function setupAutoUpdate(deps: AutoUpdateDeps): void {
  const { win } = deps;
  const sw = win.navigator.serviceWorker;
  if (!sw) return;
  // 初回のインストールで制御が付いたときは再読み込みしない
  const hadController = !!sw.controller;
  const gate = createReloadGate({ busy: () => isBusy(win.document), reload: () => win.location.reload() });
  sw.addEventListener('controllerchange', () => {
    if (hadController) gate.request();
  });
  win.document.addEventListener('focusout', () => setTimeout(() => gate.tryReload(), 0));
  win.setInterval(() => gate.tryReload(), 5_000);
  deps.registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => {
        reg.update().catch(() => {});
        gate.tryReload();
      };
      win.setInterval(check, deps.checkIntervalMs ?? 60 * 60 * 1000);
      win.document.addEventListener('visibilitychange', () => {
        if (win.document.visibilityState === 'visible') check();
      });
      win.addEventListener('focus', check);
    },
  });
}

/** 停止モード（I13）から新しい版を取りに行く */
export async function requestAppUpdate(win: Window): Promise<void> {
  const reg = await win.navigator.serviceWorker?.getRegistration();
  await reg?.update().catch(() => {});
}
