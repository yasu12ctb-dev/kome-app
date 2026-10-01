// 読み込み直しの窓口（設計書 §6.2）。理由は 2 つ（sw-update・db-upgrade）で、どちらもここへ予約し、
// location.reload() を呼ぶのはここだけ。busy（I11）の間は待ち、busy が解けたら 1 回だけ読み込み直す。

export type ReloadReason = 'sw-update' | 'db-upgrade';

/** 再読み込みしてはいけない状態か（I11） */
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

export type ReloadState = 'idle' | 'pending' | 'reloading';

export interface ReloadCoordinator {
  request(reason: ReloadReason): void;
  /** 再判定（きっかけから呼ばれる。外から呼んでもよい） */
  check(): void;
  state(): ReloadState;
  reasons(): ReadonlySet<ReloadReason>;
}

export interface ReloadDeps {
  win: Window;
  reload: () => void;
  busy?: () => boolean;
  intervalMs?: number;
}

export const RECHECK_INTERVAL_MS = 5_000;

export function createReloadCoordinator(deps: ReloadDeps): ReloadCoordinator {
  const { win } = deps;
  const doc = win.document;
  const busy = deps.busy ?? (() => isBusy(doc));
  let state: ReloadState = 'idle';
  const reasons = new Set<ReloadReason>();
  let stopWatching: (() => void) | null = null;

  function check(): void {
    if (state !== 'pending' || busy()) return;
    state = 'reloading';
    stopWatching?.();
    stopWatching = null;
    deps.reload();
  }

  /** 再判定のきっかけ（§6.2）。pending の間だけ見張る */
  function startWatching(): void {
    const onFocusOut = () => win.setTimeout(check, 0);
    const onHash = () => check();
    const onVisible = () => {
      if (doc.visibilityState === 'visible') check();
    };
    doc.addEventListener('focusout', onFocusOut);
    win.addEventListener('hashchange', onHash);
    doc.addEventListener('visibilitychange', onVisible);
    const observer = new MutationObserver(() => check());
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-dirty', 'role'] });
    const timer = win.setInterval(check, deps.intervalMs ?? RECHECK_INTERVAL_MS);
    stopWatching = () => {
      doc.removeEventListener('focusout', onFocusOut);
      win.removeEventListener('hashchange', onHash);
      doc.removeEventListener('visibilitychange', onVisible);
      observer.disconnect();
      win.clearInterval(timer);
    };
  }

  return {
    request(reason) {
      if (state === 'reloading') return;
      reasons.add(reason);
      if (state === 'idle') {
        state = 'pending';
        startWatching();
      }
      check();
    },
    check,
    state: () => state,
    reasons: () => reasons,
  };
}

let shared: ReloadCoordinator | null = null;

/** アプリ全体で 1 つの窓口（main.tsx と画面で共有する） */
export function appReloadCoordinator(): ReloadCoordinator {
  shared ??= createReloadCoordinator({ win: window, reload: () => window.location.reload() });
  return shared;
}
