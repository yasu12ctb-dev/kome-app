// @vitest-environment happy-dom
import { openDB } from 'idb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBusy, setupAutoUpdate } from '../src/app/autoUpdate';
import { createReloadCoordinator } from '../src/app/reload';
import type { Lineage } from '../src/data/types';
import { AddEdit } from '../src/ui/AddEdit';
import { App } from '../src/ui/App';
import { Settings } from '../src/ui/Settings';
import { Stats } from '../src/ui/Stats';
import { PurchaseSection, RemainingLine } from '../src/ui/Purchase';
import { isBusy as reloadBusy } from '../src/app/reload';
import { receipt, uuid } from './helpers';
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
    setPurchase: never,
    clearPurchase: never,
    ...over,
  };
}

describe('§6.2 プラグインの再読み込み要求も窓口を通る（U3 実装検収 P1-1）', () => {
  it('vite-plugin-pwa の約束（onNeedReload があればそれを呼び、無ければ直接 reload）のもとで、入力中は読み込み直さず、入力を終えたら 1 回だけ', async () => {
    const reload = vi.fn();
    const coordinator = createReloadCoordinator({ win: window, reload });
    let options: { onNeedReload?: () => void } = {};
    const win = {
      document,
      navigator: { serviceWorker: { controller: {}, addEventListener: () => {} } },
      location: { reload },
      setInterval: () => 0,
      addEventListener: () => {},
    } as unknown as Window;
    setupAutoUpdate({ win, coordinator, registerSW: (o) => (options = o) });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    // プラグインが新しい版の activated を受けたときの動き
    if (options.onNeedReload) options.onNeedReload();
    else win.location.reload();
    expect(reload).not.toHaveBeenCalled();
    input.blur();
    await new Promise((r) => setTimeout(r, 5));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('I11: 設定の未保存の入力（U3 実装検収 P2-1）', () => {
  const props = (actions: KomeActions) => ({
    receipts: [],
    lineage,
    dataRevision: 0,
    deviceId: 'd',
    purchase: null,
    hasSnapshot: false,
    today: '2026-10-02',
    version: 't',
    actions,
    onPreview: () => {},
    onConflict: () => {},
  });

  it('sw-update の流れ: 設定を入力中に新しい版 → 読み込み直さない → 保存に失敗しても入力が残り待つ → 保存できたら 1 回だけ読み込み直す', async () => {
    let result = false;
    const saveConfig = vi.fn(async () => result);
    const reload = vi.fn();
    const coordinator = createReloadCoordinator({ win: window, reload });
    await render(<Settings {...props(fakeActions({ saveConfig }))} />);
    const owner = host.querySelector<HTMLInputElement>('#owner')!;
    const token = host.querySelector<HTMLInputElement>('#token')!;
    expect(isBusy(document)).toBe(false);
    typeInto(owner, 'someone');
    typeInto(token, 'github_pat_x');
    act(() => owner.blur());
    expect(isBusy(document)).toBe(true);
    coordinator.request('sw-update');
    expect(reload).not.toHaveBeenCalled();

    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>('#owner')!.value).toBe('someone');
    expect(host.querySelector<HTMLInputElement>('#token')!.value).toBe('github_pat_x');
    expect(isBusy(document)).toBe(true);
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(reload).not.toHaveBeenCalled();

    result = true;
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(host.querySelector('#token')).toBeNull();
    expect(isBusy(document)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
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

describe('§6.2 db-upgrade の流れ（U3 実装検収 P2-2・再検収 P2-1）', () => {
  it('追加画面で入力中に別のタブが版を上げる → 入力が残り案内が出る → 保存は失敗して入力が残る → 「やめる」でホームへ → 1 回だけ読み込み直す', async () => {
    const reload = vi.fn();
    const coordinator = createReloadCoordinator({ win: window, reload });
    await render(<App coordinator={coordinator} />);
    await until(() => host.textContent?.includes('最初の一袋') ?? false);
    window.location.hash = '#add';
    await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await until(() => host.querySelector('#kg') !== null);
    typeInto(host.querySelector<HTMLInputElement>('#kg')!, '15');
    // 別のタブ（別の接続）が版 2 で開く
    const other = openDB('kome', 2, { upgrade: () => {} });
    await until(() => host.textContent?.includes('新しい版のアプリが別の画面で開かれました') ?? false);
    expect(host.querySelector<HTMLInputElement>('#kg')!.value).toBe('15');
    expect(coordinator.state()).toBe('pending');
    expect(isBusy(document)).toBe(true);

    // 保存は失敗し、入力は残る（I1）
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(host.querySelector<HTMLInputElement>('#kg')!.value).toBe('15');
    expect(reload).not.toHaveBeenCalled();

    // 「やめる」でホームへ。busy が解けて 1 回だけ読み込み直す
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'やめる')!.click();
    });
    await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await until(() => reload.mock.calls.length > 0);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(reload).toHaveBeenCalledTimes(1);
    (await other).close();
  });
});

describe('集計で選んでいた年の記録が無くなったとき（最終点検 9af66027 P2-1）', () => {
  it('別のタブで 2026 年の記録が消えて 2025 年だけになったら、2025 年を出す', async () => {
    const r2025 = receipt({ id: uuid(31), date: '2025-11-01', kg: 30, priceYen: 12000 });
    const r2026 = receipt({ id: uuid(32), date: '2026-03-01', kg: 30, priceYen: 12000 });
    await render(<Stats receipts={[r2025, r2026]} today="2026-10-04" />);
    expect(host.textContent).toContain('2026年　1回');
    await act(async () => root!.render(<Stats receipts={[r2025]} today="2026-10-04" />));
    expect(host.textContent).toContain('2025年　1回・12,000円');
    expect(host.textContent).not.toContain('2026年　0回');
  });
});

describe('購入の記録と残り（設計書 §10）', () => {
  const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;

  it('設定: 保存に失敗したら入力が残り未保存のまま（読み込み直しを待たせる）、保存できたら未保存が解ける', async () => {
    let result: { ok: true; purchase: { kg: number; date: string; updatedAt: string } } | { ok: false; kind: 'failed'; message: string } = { ok: false, kind: 'failed', message: 'x' };
    const onSave = vi.fn(async () => result);
    await render(<PurchaseSection purchase={null} today="2026-10-04" onSave={onSave} onClear={async () => ({ ok: true, purchase: null })} />);
    typeInto(host.querySelector<HTMLInputElement>('#purchase-kg')!, '240');
    expect(host.querySelector('[data-dirty="true"]')).not.toBeNull();
    await act(async () => button('保存').click());
    expect(onSave).toHaveBeenCalledWith({ kg: 240, date: '2026-10-04' });
    expect(host.textContent).toContain('保存できませんでした');
    expect(host.querySelector<HTMLInputElement>('#purchase-kg')!.value).toBe('240');
    expect(reloadBusy(document)).toBe(true);
    result = { ok: true, purchase: { kg: 240, date: '2026-10-04', updatedAt: 'x' } };
    await act(async () => root!.render(<PurchaseSection purchase={{ kg: 240, date: '2026-10-04', updatedAt: 'x' }} today="2026-10-04" onSave={onSave} onClear={async () => ({ ok: true, purchase: null })} />));
    await act(async () => button('保存').click());
    expect(host.querySelector('[data-dirty="true"]')).toBeNull();
  });

  it('設定: 量が空や文字なら数でない値として渡し、検証のエラーを出す', async () => {
    const onSave = vi.fn(async () => ({ ok: false as const, kind: 'invalid' as const, errors: [{ field: 'kg' as const, message: '購入した量は 0 より大きく 10,000 kg 以下で入れてください' }] }));
    await render(<PurchaseSection purchase={null} today="2026-10-04" onSave={onSave} onClear={async () => ({ ok: true, purchase: null })} />);
    typeInto(host.querySelector<HTMLInputElement>('#purchase-kg')!, 'abc');
    await act(async () => button('保存').click());
    expect(Number.isNaN((onSave.mock.calls[0] as unknown as [{ kg: number }])[0].kg)).toBe(true);
    expect(host.textContent).toContain('10,000 kg 以下');
  });

  // 設計書 §10「設定の購入欄の状態」・§9.1。親（useKome）の代わりに、保存・消去が成功したら最新を差し替えてから応答する
  type P = { kg: number; date: string; updatedAt: string } | null;
  function harness(initial: P, opts: { today?: string } = {}) {
    let latest: P = initial;
    let today = opts.today ?? '2026-10-04';
    let n = 0;
    let gate: (() => void) | null = null;
    let fail = false;
    const view = () => <PurchaseSection purchase={latest} today={today} onSave={onSave} onClear={onClear} />;
    const setLatest = async (v: P) => {
      latest = v;
      await act(async () => root!.render(view()));
    };
    const wait = () => (gate ? new Promise<void>((r) => (gate = r)) : Promise.resolve());
    const onSave = vi.fn(async (i: { kg: number; date: string }) => {
      await wait();
      if (fail) return { ok: false as const, kind: 'failed' as const, message: 'x' };
      latest = { ...i, updatedAt: `s${++n}` };
      root!.render(view()); // 外側の act（ボタンを押す act）の中なので、入れ子の act を使わない
      return { ok: true as const, purchase: latest };
    });
    const onClear = vi.fn(async () => {
      await wait();
      if (fail) return { ok: false as const, kind: 'failed' as const, message: 'x' };
      latest = null;
      root!.render(view());
      return { ok: true as const, purchase: null };
    });
    return {
      view,
      onSave,
      onClear,
      setLatest,
      setToday: async (t: string) => {
        today = t;
        await act(async () => root!.render(view()));
      },
      hold: () => {
        gate = () => {};
      },
      release: async () => {
        const g = gate as unknown as () => void;
        gate = null;
        await act(async () => g());
      },
      failNext: (v: boolean) => (fail = v),
    };
  }
  const kgInput = () => host.querySelector<HTMLInputElement>('#purchase-kg')!;
  const dateInput = () => host.querySelector<HTMLInputElement>('#purchase-date')!;
  const isDirty = () => host.querySelector('[data-dirty="true"]') !== null;
  const notice = () => host.textContent!.includes('ほかの画面で購入の記録が変わりました');
  const P240 = { kg: 240, date: '2026-10-01', updatedAt: 'a' };

  it('未編集なら、ほかの画面の変更・消去に追従し、古い値を送らない（74519483 P2-1）', async () => {
    const h = harness(P240);
    await render(h.view());
    await h.setLatest({ kg: 180, date: '2026-10-02', updatedAt: 'b' });
    expect([kgInput().value, dateInput().value, isDirty()]).toEqual(['180', '2026-10-02', false]);
    expect(button('保存').disabled).toBe(true);
    await h.setLatest(null);
    expect([kgInput().value, dateInput().value, isDirty()]).toEqual(['', '2026-10-04', false]);
    expect(h.onSave).not.toHaveBeenCalled();
  });

  it('編集中にほかの画面で変わったら下書きを守ってお知らせし、「今の記録に戻す」で最新に合わせる', async () => {
    const h = harness(P240);
    await render(h.view());
    typeInto(kgInput(), '300');
    await h.setLatest({ kg: 180, date: '2026-10-02', updatedAt: 'b' });
    expect([kgInput().value, isDirty(), notice()]).toEqual(['300', true, true]);
    expect(host.textContent).toContain('（今は 180kg・10月2日）');
    await act(async () => button('今の記録に戻す').click());
    expect([kgInput().value, dateInput().value, isDirty(), notice()]).toEqual(['180', '2026-10-02', false, false]);
  });

  it('量・購入日を元の値に戻しても、最新と違えば未保存とお知らせが残り、保存できる（d5d79a1d）', async () => {
    const h = harness(P240);
    await render(h.view());
    typeInto(kgInput(), '300');
    typeInto(dateInput(), '2026-09-30');
    await h.setLatest({ kg: 180, date: '2026-10-02', updatedAt: 'b' });
    typeInto(kgInput(), '240');
    typeInto(dateInput(), '2026-10-01');
    expect([kgInput().value, dateInput().value, isDirty(), notice()]).toEqual(['240', '2026-10-01', true, true]);
    expect(button('保存').disabled).toBe(false);
    await act(async () => button('保存').click());
    expect(h.onSave).toHaveBeenLastCalledWith({ kg: 240, date: '2026-10-01' });
    expect([kgInput().value, isDirty(), notice()]).toEqual(['240', false, false]);
  });

  it('下書きが最新と同じになったら終わり、その後の変更で古い下書きは生き返らない（47ea7d55）', async () => {
    const h = harness(P240);
    await render(h.view());
    typeInto(kgInput(), '180');
    await h.setLatest({ kg: 180, date: '2026-10-01', updatedAt: 'b' });
    expect([kgInput().value, isDirty(), notice()]).toEqual(['180', false, false]);
    await h.setLatest({ kg: 120, date: '2026-10-01', updatedAt: 'c' });
    expect([kgInput().value, isDirty(), notice()]).toEqual(['120', false, false]);
    // 入力で最新と同じにしても終わる
    typeInto(kgInput(), '130');
    typeInto(kgInput(), '120');
    expect(isDirty()).toBe(false);
    await h.setLatest({ kg: 100, date: '2026-10-01', updatedAt: 'd' });
    expect(kgInput().value).toBe('100');
  });

  it('終わった後にまた編集すると、そのときの最新を元にする（古いお知らせを出さない）', async () => {
    const h = harness(P240);
    await render(h.view());
    typeInto(kgInput(), '180');
    await h.setLatest({ kg: 180, date: '2026-10-01', updatedAt: 'b' });
    typeInto(kgInput(), '200');
    expect([isDirty(), notice()]).toEqual([true, false]);
  });

  it('購入の記録が無いとき、購入日を触って今日に戻した後に 0 時を越えたら新しい今日に追従する', async () => {
    const h = harness(null, { today: '2026-10-04' });
    await render(h.view());
    typeInto(dateInput(), '2026-10-01');
    typeInto(dateInput(), '2026-10-04');
    expect(isDirty()).toBe(false);
    await h.setToday('2026-10-05');
    expect([dateInput().value, isDirty()]).toEqual(['2026-10-05', false]);
  });

  it('保存・消去が失敗したら下書きとエラーが残り、成功で下書きが消える', async () => {
    const h = harness(P240);
    await render(h.view());
    typeInto(kgInput(), '300');
    h.failNext(true);
    await act(async () => button('保存').click());
    expect([kgInput().value, isDirty()]).toEqual(['300', true]);
    expect(host.textContent).toContain('保存できませんでした');
    await act(async () => button('消す').click());
    expect([kgInput().value, isDirty()]).toEqual(['300', true]);
    expect(host.textContent).toContain('消せませんでした');
    h.failNext(false);
    await act(async () => button('消す').click());
    expect([kgInput().value, isDirty()]).toEqual(['', false]);
  });

  it('待機中は欄・保存・消す・戻すが操作できず、待機中のほかの画面の変更で下書きは変わらない（74519483 P2-2）', async () => {
    const h = harness(P240);
    await render(h.view());
    typeInto(kgInput(), '300');
    await h.setLatest({ kg: 180, date: '2026-10-02', updatedAt: 'b' });
    h.hold();
    await act(async () => button('保存').click());
    expect([kgInput().disabled, dateInput().disabled, button('保存').disabled, button('消す').disabled, button('今の記録に戻す').disabled]).toEqual([true, true, true, true, true]);
    await h.setLatest({ kg: 150, date: '2026-10-02', updatedAt: 'c' });
    expect(kgInput().value).toBe('300');
    await h.release();
    expect([kgInput().disabled, kgInput().value, isDirty()]).toEqual([false, '300', false]);
    expect(h.onSave).toHaveBeenLastCalledWith({ kg: 300, date: '2026-10-01' });
  });

  it('ホーム: 残り・受け取りすぎ・購入の記録なしの表示', async () => {
    const rs = [receipt({ id: uuid(41), date: '2026-09-30', kg: 30 }), receipt({ id: uuid(42), date: '2026-10-01', kg: 30 })];
    await render(<RemainingLine receipts={rs} purchase={{ kg: 240, date: '2026-10-01', updatedAt: 'x' }} />);
    expect(host.textContent).toBe('残り 210kg');
    await act(async () => root!.render(<RemainingLine receipts={rs} purchase={{ kg: 20, date: '2026-09-01', updatedAt: 'x' }} />));
    expect(host.textContent).toBe('購入より 40kg 多く受け取り');
    await act(async () => root!.render(<RemainingLine receipts={rs} purchase={null} />));
    expect(host.querySelector('a[href="#settings"]')!.textContent).toContain('購入した量を記録すると');
  });
});
