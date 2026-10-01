// 別のタブへ変更を知らせる（設計書 §3・§7）。受けた側は読み直す

export const CHANNEL_NAME = 'kome';

export interface ChangeChannel {
  post(): void;
  close(): void;
}

export function createChangeChannel(onChanged: () => void, name = CHANNEL_NAME): ChangeChannel {
  if (typeof BroadcastChannel === 'undefined') return { post() {}, close() {} };
  const bc = new BroadcastChannel(name);
  bc.onmessage = (ev: MessageEvent) => {
    if ((ev.data as { type?: unknown } | null)?.type === 'changed') onChanged();
  };
  return {
    post() {
      bc.postMessage({ type: 'changed' });
    },
    close() {
      bc.close();
    },
  };
}
