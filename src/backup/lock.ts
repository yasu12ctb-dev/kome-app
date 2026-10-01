// Web Lock `kome-backup`（設計書 §3・§7）。送信・復元・設定の保存・衝突の解決を同時に 1 つに絞る。
// Web Locks が無い環境（試験の Node など）では、同じページの中だけで効く代わりの排他を使う。

export const BACKUP_LOCK = 'kome-backup';

type Mode = { ifAvailable: boolean };

const local = new Map<string, Promise<void>>();

async function withLocalLock<T>(name: string, mode: Mode, fn: () => Promise<T>): Promise<T | null> {
  const held = local.get(name);
  if (held && mode.ifAvailable) return null;
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const prev = held ?? Promise.resolve();
  const chain = prev.then(() => mine);
  local.set(name, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (local.get(name) === chain) local.delete(name);
  }
}

/** ifAvailable が真なら、取れないとき null を返してすぐ終わる（実行中の処理に任せる） */
export async function withBackupLock<T>(mode: Mode, fn: () => Promise<T>): Promise<T | null> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks?.request) {
    return locks.request(BACKUP_LOCK, { ifAvailable: mode.ifAvailable }, async (lock) => (lock === null ? null : fn()));
  }
  return withLocalLock(BACKUP_LOCK, mode, fn);
}
