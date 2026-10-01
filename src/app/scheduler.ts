// 送信のきっかけ（設計書 §4.0）: 端末での変更の 3 秒後（連続した変更はまとめる）／起動時／前面復帰／online／設定の保存後。
// 送るかどうか（止める種類のエラー・再試行の時刻・保存待ちか）は push() 自身が決める。

export const PUSH_DEBOUNCE_MS = 3000;

export interface PushScheduler {
  /** 端末での変更。最後の変更から 3 秒後に 1 回送る */
  notifyChange(): void;
  /** すぐ送る（起動時・前面復帰・online・設定の保存後） */
  triggerNow(): void;
  dispose(): void;
}

export interface SchedulerDeps {
  push: () => Promise<unknown>;
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
  let disposed = false;

  async function run(): Promise<void> {
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await deps.push();
    } catch (e) {
      console.error('kome: 送信に失敗しました', e);
    } finally {
      running = false;
      if (again) {
        again = false;
        void run();
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
    triggerNow() {
      cancelTimer();
      void run();
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}

/** 前面復帰と online で送る。戻り値で外す */
export function attachPushTriggers(scheduler: PushScheduler, win: Window): () => void {
  const onVisible = () => {
    if (win.document.visibilityState === 'visible') scheduler.triggerNow();
  };
  const onOnline = () => scheduler.triggerNow();
  win.document.addEventListener('visibilitychange', onVisible);
  win.addEventListener('online', onOnline);
  return () => {
    win.document.removeEventListener('visibilitychange', onVisible);
    win.removeEventListener('online', onOnline);
  };
}
