// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBusy } from '../src/app/autoUpdate';
import { createReloadCoordinator, RECHECK_INTERVAL_MS } from '../src/app/reload';
import { createChangeChannel } from '../src/app/channel';
import { buildIcs } from '../src/app/ics';
import { attachPushTriggers, createPushScheduler, PUSH_DEBOUNCE_MS } from '../src/app/scheduler';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('送信のきっかけ（§4.0・U3 の必須試験）', () => {
  it('連続した変更は、最後の変更から 3 秒後の 1 回の送信にまとまる', async () => {
    vi.useFakeTimers();
    const push = vi.fn(async () => {});
    const s = createPushScheduler({ push });
    s.notifyChange();
    vi.advanceTimersByTime(2000);
    s.notifyChange();
    vi.advanceTimersByTime(2999);
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(PUSH_DEBOUNCE_MS).toBe(3000);
  });

  it('送信中に来たきっかけは、終わってからもう 1 回だけ送る（同時に 2 本走らない）', async () => {
    let release!: () => void;
    let running = 0;
    let maxRunning = 0;
    const push = vi.fn(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((r) => (release = r));
      running -= 1;
    });
    const s = createPushScheduler({ push });
    s.triggerNow();
    s.triggerNow();
    s.triggerNow();
    await Promise.resolve();
    release();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(push).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
  });

  it('前面に戻ったとき・online になったときにすぐ送る', () => {
    const s = { notifyChange: vi.fn(), triggerNow: vi.fn(), dispose: vi.fn() };
    const detach = attachPushTriggers(s, window);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    expect(s.triggerNow).toHaveBeenCalledTimes(2);
    detach();
    window.dispatchEvent(new Event('online'));
    expect(s.triggerNow).toHaveBeenCalledTimes(2);
  });

  it('送信が例外を出してもきっかけは止まらない', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const push = vi.fn(async () => {
      throw new Error('boom');
    });
    const s = createPushScheduler({ push });
    s.triggerNow();
    await new Promise((r) => setTimeout(r, 0));
    s.triggerNow();
    await new Promise((r) => setTimeout(r, 0));
    expect(push).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });
});

describe('I11: 自動アップデートの再読み込みを待つ条件', () => {
  it('入力欄にフォーカス・未保存のフォーム・ダイアログ表示中は busy、どれも無ければ busy でない', () => {
    expect(isBusy(document)).toBe(false);
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(isBusy(document)).toBe(true);
    input.blur();
    expect(isBusy(document)).toBe(false);
    const form = document.createElement('main');
    form.dataset.dirty = 'true';
    document.body.append(form);
    expect(isBusy(document)).toBe(true);
    form.dataset.dirty = 'false';
    expect(isBusy(document)).toBe(false);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    expect(isBusy(document)).toBe(true);
    dialog.remove();
    expect(isBusy(document)).toBe(false);
  });

});

describe('§6.2 読み込み直しの窓口', () => {
  function setup() {
    let busy = true;
    const reload = vi.fn();
    const c = createReloadCoordinator({ win: window, reload, busy: () => busy });
    return { c, reload, unbusy: () => (busy = false) };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('予約が無ければ、どのきっかけでも読み込み直さない（見張りも始めない）', async () => {
    const reload = vi.fn();
    const c = createReloadCoordinator({ win: window, reload, busy: () => false });
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    document.body.append(document.createElement('div'));
    c.check();
    await tick();
    expect(reload).not.toHaveBeenCalled();
    expect(c.state()).toBe('idle');
  });

  it('busy でなければ予約した直後に 1 回だけ読み込み直す', () => {
    const reload = vi.fn();
    const c = createReloadCoordinator({ win: window, reload, busy: () => false });
    c.request('sw-update');
    c.request('db-upgrade');
    c.check();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(c.state()).toBe('reloading');
  });

  it('busy の間は pending のまま、理由は集合で持つ', () => {
    const { c, reload } = setup();
    c.request('sw-update');
    c.request('db-upgrade');
    c.request('sw-update');
    expect(reload).not.toHaveBeenCalled();
    expect(c.state()).toBe('pending');
    expect([...c.reasons()].sort()).toEqual(['db-upgrade', 'sw-update']);
  });

  const triggers: [string, () => void | Promise<void>][] = [
    ['focusout（次のタスクで）', async () => {
      document.dispatchEvent(new FocusEvent('focusout'));
      await tick();
    }],
    ['文書の変化（未保存の印が外れる）', async () => {
      const m = document.createElement('main');
      m.dataset.dirty = 'true';
      document.body.append(m);
      await tick();
    }],
    ['hashchange（画面の移動）', () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }],
    ['前面に戻った', () => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }],
  ];
  it.each(triggers)('きっかけ: %s で、busy が解けていれば 1 回だけ読み込み直す', async (_label, fire) => {
    const { c, reload, unbusy } = setup();
    c.request('db-upgrade');
    unbusy();
    expect(reload).not.toHaveBeenCalled();
    await fire();
    expect(reload).toHaveBeenCalledTimes(1);
    await fire();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('きっかけ: 5 秒ごとの定期判定（取りこぼしの保険）', () => {
    vi.useFakeTimers();
    const { c, reload, unbusy } = setup();
    c.request('sw-update');
    unbusy();
    vi.advanceTimersByTime(RECHECK_INTERVAL_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RECHECK_INTERVAL_MS * 3);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('読み込み直しに入った後の予約は何もしない', () => {
    const reload = vi.fn();
    const c = createReloadCoordinator({ win: window, reload, busy: () => false });
    c.request('sw-update');
    c.request('db-upgrade');
    expect(reload).toHaveBeenCalledTimes(1);
    expect([...c.reasons()]).toEqual(['sw-update']);
  });
});

describe('§8.1 カレンダー（.ics）', () => {
  it('予測日に終日の予定、3 日前に通知、UID は端末ごとに固定、改行は CRLF', () => {
    const ics = buildIcs('2026-10-29', 'dev-1', new Date('2026-10-01T03:00:00.000Z'));
    const lines = ics.split('\r\n');
    expect(lines).toContain('UID:kome-next@dev-1');
    expect(lines).toContain('DTSTART;VALUE=DATE:20261029');
    expect(lines).toContain('DTEND;VALUE=DATE:20261030');
    expect(lines).toContain('TRIGGER:-P3D');
    expect(lines).toContain('DTSTAMP:20261001T030000Z');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('月末・年末の翌日を正しく出す', () => {
    expect(buildIcs('2026-12-31', 'd', new Date()).includes('DTEND;VALUE=DATE:20270101')).toBe(true);
    expect(buildIcs('2028-02-28', 'd', new Date()).includes('DTEND;VALUE=DATE:20280229')).toBe(true);
  });
});

describe('§7 別タブへの変更の通知（U3 の必須試験）', () => {
  it('一方のタブの post を、もう一方のタブが受けて読み直す', async () => {
    const received = vi.fn();
    const a = createChangeChannel(() => {}, 'kome-test');
    const b = createChangeChannel(received, 'kome-test');
    a.post();
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveBeenCalledTimes(1);
    a.close();
    b.close();
  });
});

describe('大きな数字を画面幅に収める大きさ（総点検で見つかった桁あふれの再発防止）', () => {
  it('文字数が増えるほど小さくなり、上限を超えない', async () => {
    const { fitFontSize } = await import('../src/ui/fit');
    expect(fitFontSize('28', 250, 102)).toBe('min(250px, calc((100vw - 102px) / 1.24))');
    expect(fitFontSize('190', 250, 102)).toBe('min(250px, calc((100vw - 102px) / 1.86))');
    expect(fitFontSize('2980', 250, 182)).toBe('min(250px, calc((100vw - 182px) / 2.48))');
    // 390px の画面で 3 桁 + 「日」が収まる（数字 1.86em ≤ 390 − 102）
    const px = Math.min(250, (390 - 102) / 1.86);
    expect(px * 1.86 + 102).toBeLessThanOrEqual(390);
  });
});

describe('0 時をまたいだら「今日」を更新する（バグ点検 P2-1）', () => {
  it('次の日の 0:00:05 までの時間（日付の境目・年越し）', async () => {
    const { msUntilNextLocalDay } = await import('../src/app/clock');
    expect(msUntilNextLocalDay(new Date(2026, 9, 3, 23, 59, 59))).toBe(6_000);
    expect(msUntilNextLocalDay(new Date(2026, 11, 31, 23, 0, 0))).toBe(3_605_000);
    expect(msUntilNextLocalDay(new Date(2026, 9, 3, 0, 0, 0))).toBe(86_405_000);
  });
});
