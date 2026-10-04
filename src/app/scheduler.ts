// 送信のきっかけ（設計書 §4.0）: 端末での変更の 3 秒後（連続した変更はまとめる）／起動時／前面復帰／online／設定の保存後。
// 送るかどうか（止める種類のエラー・再試行の時刻・保存待ちか）は push() 自身が決める。

export const PUSH_DEBOUNCE_MS = 3000;

export interface PushScheduler {
  /** 端末での変更。最後の変更から 3 秒後に 1 回送る */
  notifyChange(): void;
  /** すぐ送る（起動時・前面復帰・online・設定の保存後）。verify なら送る必要が無くても GitHub を確かめる（§4.5） */
  triggerNow(options?: { verify?: boolean }): void;
  dispose(): void;
}

export interface SchedulerDeps {
  push: (options: { verify: boolean }) => Promise<unknown>;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createPushScheduler(deps: SchedulerDeps): PushScheduler {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const debounceMs = deps.debounceMs ?? PUSH_DEBOUNCE_MS;
  let timer: unknown = null;
  let running = false;
  let again = false;
  let againVerify = false;
  let disposed = false;

  async function run(verify = false): Promise<void> {
    if (disposed) return;
    if (running) {
      again = true;
      againVerify ||= verify;
      return;
    }
    running = true;
    try {
      await deps.push({ verify });
    } catch (e) {
      console.error('kome: 送信に失敗しました', e);
    } finally {
      running = false;
      if (again) {
        const v = againVerify;
        again = false;
        againVerify = false;
        void run(v);
      }
    }
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    notifyChange() {
      cancelTimer();
      timer = setTimer(() => {
        timer = null;
        void run();
      }, debounceMs);
    },
    triggerNow(options) {
      cancelTimer();
      void run(options?.verify === true);
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}

/** 前面復帰で GitHub を確かめる間隔（§4.5。同じタブで 10 分に 1 回まで） */
export const VERIFY_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 前面復帰と online で送る。前面復帰では、直前に GitHub を確かめられた時刻（起動・今すぐ保存・前面復帰のどれでも。
 * 送信中で見送った・GET が失敗したときは数えない）から 10 分以上たっていれば確かめる（§4.5）。戻り値で外す
 */
export function attachPushTriggers(
  scheduler: PushScheduler,
  win: Window,
  clock: { now: () => number; lastVerified: () => number } = { now: () => Date.now(), lastVerified: () => Date.now() },
): () => void {
  const onVisible = () => {
    if (win.document.visibilityState !== 'visible') return;
    scheduler.triggerNow({ verify: clock.now() - clock.lastVerified() >= VERIFY_INTERVAL_MS });
  };
  const onOnline = () => scheduler.triggerNow();
  win.document.addEventListener('visibilitychange', onVisible);
  win.addEventListener('online', onOnline);
  return () => {
    win.document.removeEventListener('visibilitychange', onVisible);
    win.removeEventListener('online', onOnline);
  };
}
