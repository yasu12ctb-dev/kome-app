import type { IDBPObjectStore } from 'idb';
import { toLocalYmd } from './date';
import { createLineageGate, type LineageGate } from '../backup/lineage';
import { openKomeDb, type KomeDb, type KomeSchema, type StopReason } from './db';
import type { AppMeta, Purchase, Receipt } from './types';
import { validatePurchase, validateReceipt, type ValidationError } from './validate';

// 記録の追加・編集・削除はすべてここを通す（設計書 §3）。
// 各書き込みは 1 トランザクションで「記録の変更」と「dataRevision +1」を行う（I2・I3）。
// DB ハンドルやトランザクションは外へ返さない（戻り値は値のコピーだけ）。

export interface ReceiptInput {
  date: string;
  kg: number;
  priceYen: number | null;
  paid: boolean;
}

export type WriteResult =
  | { ok: true; receipt: Receipt; dataRevision: number }
  | { ok: false; kind: 'invalid'; errors: ValidationError[] }
  | { ok: false; kind: 'not-found' }
  | { ok: false; kind: 'failed'; message: string };

export type DeleteResult =
  | { ok: true; dataRevision: number }
  | { ok: false; kind: 'not-found' }
  | { ok: false; kind: 'failed'; message: string };

export type PurchaseResult =
  | { ok: true; purchase: Purchase | null }
  | { ok: false; kind: 'invalid'; errors: ValidationError[] }
  | { ok: false; kind: 'failed'; message: string };

export interface Repo {
  listReceipts(): Promise<Receipt[]>;
  getAppMeta(): Promise<AppMeta>;
  addReceipt(input: ReceiptInput, now?: Date): Promise<WriteResult>;
  updateReceipt(id: string, input: ReceiptInput, now?: Date): Promise<WriteResult>;
  deleteReceipt(id: string): Promise<DeleteResult>;
  /** 購入の記録（無ければ null。値のコピー） */
  getPurchase(): Promise<Purchase | null>;
  /** 購入の記録を書く・消す（設計書 §10・I15）。dataRevision は変えず、送信も予約しない */
  setPurchase(input: { kg: number; date: string }, now?: Date): Promise<PurchaseResult>;
  clearPurchase(): Promise<PurchaseResult>;
  close(): void;
}

export type OpenRepoResult =
  | { kind: 'ok'; repo: Repo; lineage: LineageGate }
  | { kind: 'stopped'; reason: StopReason; detail?: string };

export interface OpenRepoOptions {
  dbName?: string;
  newId?: () => string;
  /** 書き込みが確定した後に呼ぶ（送信の予約・他タブへの通知に使う）。トランザクションの外で呼ばれる */
  onChange?: () => void;
  /** 購入の記録が確定した後に呼ぶ（他タブへの通知だけに使う。送信は予約しない。設計書 §10） */
  onPurchaseChange?: () => void;
  onVersionChange?: () => void;
}

type ReceiptStore = IDBPObjectStore<KomeSchema, ['receipts', 'meta'], 'receipts', 'readwrite'>;

class Aborted extends Error {
  constructor(readonly result: { ok: false; kind: 'invalid'; errors: ValidationError[] } | { ok: false; kind: 'not-found' }) {
    super(result.kind);
  }
}

function message(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'name' in e) return String((e as { name: unknown }).name);
  return String(e);
}

function sortReceipts(rs: Receipt[]): Receipt[] {
  return [...rs].sort((a, b) => (a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date.localeCompare(b.date)));
}

export async function openRepo(options: OpenRepoOptions = {}): Promise<OpenRepoResult> {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const opened = await openKomeDb({
    dbName: options.dbName ?? 'kome',
    newId,
    ...(options.onVersionChange ? { onVersionChange: options.onVersionChange } : {}),
  });
  if (opened.kind === 'stopped') return opened;
  return { kind: 'ok', repo: createRepo(opened.db, newId, options.onChange, options.onPurchaseChange), lineage: createLineageGate(opened.db, newId) };
}

function createRepo(db: KomeDb, newId: () => string, onChange?: () => void, onPurchaseChange?: () => void): Repo {
  /** 確定した後の通知。通知の失敗は保存の失敗と分ける（確定した書き込みは成功として返す） */
  function notify(fn: (() => void) | undefined): void {
    try {
      fn?.();
    } catch (e) {
      console.error('kome: 変更の通知に失敗しました', e);
    }
  }
  const notifyChanged = () => notify(onChange);

  /** 購入の記録だけを 1 トランザクションで書く（meta の purchase キーだけに触れる） */
  async function writePurchase(value: Purchase | null): Promise<PurchaseResult> {
    try {
      const tx = db.transaction('meta', 'readwrite');
      if (value === null) await tx.store.delete('purchase');
      else await tx.store.put(value, 'purchase');
      await tx.done;
    } catch (e) {
      return { ok: false, kind: 'failed', message: message(e) };
    }
    notify(onPurchaseChange);
    return { ok: true, purchase: value === null ? null : { ...value } };
  }

  /** 記録の変更と dataRevision +1 を 1 トランザクションで行う */
  async function mutate<T extends Receipt | null>(
    work: (stores: { receipts: ReceiptStore; bump: () => Promise<number> }) => Promise<T>,
  ): Promise<{ value: T; dataRevision: number }> {
    const tx = db.transaction(['receipts', 'meta'], 'readwrite');
    const done = tx.done;
    done.catch(() => {});
    const stores = { receipts: tx.objectStore('receipts'), meta: tx.objectStore('meta') };
    let revision = -1;
    const bump = async () => {
      const app = (await stores.meta.get('app')) as AppMeta;
      revision = app.dataRevision + 1;
      await stores.meta.put({ ...app, dataRevision: revision }, 'app');
      return revision;
    };
    try {
      const value = await work({ receipts: stores.receipts, bump });
      await done;
      return { value, dataRevision: revision };
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // 既に中止・完了している
      }
      throw e;
    }
  }

  return {
    async listReceipts() {
      return sortReceipts(await db.getAll('receipts'));
    },

    async getAppMeta() {
      return { ...((await db.get('meta', 'app')) as AppMeta) };
    },

    async addReceipt(input, now = new Date()) {
      const iso = now.toISOString();
      const candidate = { id: newId(), ...input, createdAt: iso, updatedAt: iso };
      const checked = validateReceipt(candidate, toLocalYmd(now));
      if (!checked.ok) return { ok: false, kind: 'invalid', errors: checked.errors };
      const receipt = checked.value;
      let dataRevision: number;
      try {
        ({ dataRevision } = await mutate(async ({ receipts, bump }) => {
          await bump();
          await receipts.add(receipt);
          return receipt;
        }));
      } catch (e) {
        return { ok: false, kind: 'failed', message: message(e) };
      }
      notifyChanged();
      return { ok: true, receipt: { ...receipt }, dataRevision };
    },

    async updateReceipt(id, input, now = new Date()) {
      let committed: { value: Receipt | null; dataRevision: number };
      try {
        committed = await mutate(async ({ receipts, bump }) => {
          const existing = await receipts.get(id);
          if (!existing) throw new Aborted({ ok: false, kind: 'not-found' });
          const iso = now.toISOString();
          const updatedAt = Date.parse(iso) < Date.parse(existing.createdAt) ? existing.createdAt : iso;
          const checked = validateReceipt({ ...existing, ...input, id, createdAt: existing.createdAt, updatedAt }, toLocalYmd(now));
          if (!checked.ok) throw new Aborted({ ok: false, kind: 'invalid', errors: checked.errors });
          await bump();
          await receipts.put(checked.value);
          return checked.value;
        });
      } catch (e) {
        if (e instanceof Aborted) return e.result;
        return { ok: false, kind: 'failed', message: message(e) };
      }
      notifyChanged();
      return { ok: true, receipt: { ...(committed.value as Receipt) }, dataRevision: committed.dataRevision };
    },

    async deleteReceipt(id) {
      let dataRevision: number;
      try {
        ({ dataRevision } = await mutate(async ({ receipts, bump }) => {
          const existing = await receipts.get(id);
          if (!existing) throw new Aborted({ ok: false, kind: 'not-found' });
          await bump();
          await receipts.delete(id);
          return null;
        }));
      } catch (e) {
        if (e instanceof Aborted && e.result.kind === 'not-found') return { ok: false, kind: 'not-found' };
        return { ok: false, kind: 'failed', message: message(e) };
      }
      notifyChanged();
      return { ok: true, dataRevision };
    },

    async getPurchase() {
      const p = (await db.get('meta', 'purchase')) as Purchase | undefined;
      return p === undefined ? null : { ...p };
    },

    async setPurchase(input, now = new Date()) {
      const checked = validatePurchase(input, toLocalYmd(now));
      if (!checked.ok) return { ok: false, kind: 'invalid', errors: checked.errors };
      return writePurchase({ ...checked.value, updatedAt: now.toISOString() });
    },

    clearPurchase() {
      return writePurchase(null);
    },

    close() {
      db.close();
    },
  };
}
