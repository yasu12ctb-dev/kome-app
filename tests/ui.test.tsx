// @vitest-environment happy-dom
import { openDB } from 'idb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBusy, setupAutoUpdate } from '../src/app/autoUpdate';
import type { Lineage } from '../src/data/types';
import { AddEdit } from '../src/ui/AddEdit';
import { App } from '../src/ui/App';
import { Settings } from '../src/ui/Settings';
import type { KomeActions } from '../src/ui/useKome';

// 不変条件を担う画面と接続部分を、実際の部品で確かめる（U3 実装検収の回答）

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  window.location.hash = '';
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function render(node: React.ReactNode) {
  root = createRoot(host);
  await act(async () => root!.render(node));
}

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 300; i += 1) {
    if (cond()) return;
    await act(async () => new Promise((r) => setTimeout(r, 5)));
  }
  throw new Error('timeout');
}

const lineage: Lineage = {
  config: null,
  generation: 'g',
  lastPushedSha: null,
  lastPushedRevision: null,
  lastPushedAt: null,
  pendingPush: null,
  errorKind: null,
  retryAfter: null,
  lastErrorMessage: null,
};

function fakeActions(over: Partial<KomeActions> = {}): KomeActions {
  const never = () => new Promise<never>(() => {});
  return {
    add: never,
    update: never,
    remove: never,
    saveConfig: async () => true,
    retryNow: async () => {},
    overwriteRemote: async () => {},
    previewFromGitHub: never,
    previewFromFile: never,
    confirmRestore: never,
    undoRestore: never,
    exportFile: never,
    ...over,
  };
}

describe('I11: プラグインの再読み込み要求も同じ関門を通る（U3 実装検収 P1-1）', () => {
  it('vite-plugin-pwa の約束（onNeedReload があればそれを呼び、無ければ直接 reload）のもとで、入力中は再読み込みしない', () => {
    const reload = vi.fn();
    let options: { onNeedReload?: () => void } = {};
    const win = {
      document,
      navigator: { serviceWorker: { controller: {}, addEventListener: () => {} } },
      location: { reload },
      setInterval: () => 0,
      addEventListener: () => {},
    } as unknown as Window;
    const gate = setupAutoUpdate({ win, registerSW: (o) => (options = o) });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    // プラグインが新しい版の activated を受けたときの動き
    if (options.onNeedReload) options.onNeedReload();
    else win.location.reload();
    expect(reload).not.toHaveBeenCalled();
    input.blur();
    gate!.tryReload();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('I11: 設定の未保存の入力（U3 実装検収 P2-1）', () => {
  const props = (actions: KomeActions) => ({
    receipts: [],
    lineage,
    dataRevision: 0,
    deviceId: 'd',
    hasSnapshot: false,
    today: '2026-10-02',
    version: 't',
    actions,
    onPreview: () => {},
    onConflict: () => {},
  });

  it('入力したらフォーカスを外しても busy。保存に失敗しても入力は残り busy のまま。保存できたら busy でない', async () => {
    let result = false;
    const saveConfig = vi.fn(async () => result);
    await render(<Settings {...props(fakeActions({ saveConfig }))} />);
    const owner = host.querySelector<HTMLInputElement>('#owner')!;
    const token = host.querySelector<HTMLInputElement>('#token')!;
    expect(isBusy(document)).toBe(false);
    typeInto(owner, 'someone');
    typeInto(token, 'github_pat_x');
    act(() => owner.blur());
    expect(isBusy(document)).toBe(true);

    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>('#owner')!.value).toBe('someone');
    expect(host.querySelector<HTMLInputElement>('#token')!.value).toBe('github_pat_x');
    expect(isBusy(document)).toBe(true);

    result = true;
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(host.querySelector('#token')).toBeNull();
    expect(isBusy(document)).toBe(false);
  });
});

describe('I1: 保存に失敗したら入力を残す（実際の追加画面）', () => {
  it('failed のとき、量・代金の入力とエラーが残り、busy のまま', async () => {
    const onDone = vi.fn();
    await render(
      <AddEdit today="2026-10-02" editing={null} lastKg={30} onSave={async () => ({ ok: false, kind: 'failed', message: 'x' })} onDelete={async () => ({ ok: true, dataRevision: 1 })} onDone={onDone} />,
    );
    typeInto(host.querySelector<HTMLInputElement>('#kg')!, '12.5');
    typeInto(host.querySelector<HTMLInputElement>('#price')!, '5000');
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(onDone).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('#kg')!.value).toBe('12.5');
    expect(host.querySelector<HTMLInputElement>('#price')!.value).toBe('5000');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('保存できませんでした');
    expect(isBusy(document)).toBe(true);
  });
});

describe('別のタブが DB の版を上げたとき、入力中のフォームを残す（U3 実装検収 P2-2）', () => {
  it('追加画面の入力が消えず、案内が出て、再読み込みは入力を終えるまで待つ', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, reload, hash: '' }, configurable: true, writable: true });
    await render(<App />);
    await until(() => host.textContent?.includes('最初の一袋') ?? false);
    window.location.hash = '#add';
    await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await until(() => host.querySelector('#kg') !== null);
    typeInto(host.querySelector<HTMLInputElement>('#kg')!, '15');
    // 別のタブ（別の接続）が版 2 で開く
    const other = openDB('kome', 2, { upgrade: () => {} });
    await until(() => host.textContent?.includes('新しい版のアプリが別の画面で開かれました') ?? false);
    expect(host.querySelector<HTMLInputElement>('#kg')!.value).toBe('15');
    expect(isBusy(document)).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    (await other).close();
  });
});
