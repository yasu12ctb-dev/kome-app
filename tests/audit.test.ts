// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
// @ts-expect-error 開発用の道具（型なしの JS）
import { screenState } from '../tools/layout-audit.js';

// 表示の総点検が「期待した画面」を確かめてから測ること（再検収 6ea4af18 P2-1）

function doc(html: string): Document {
  const d = document.implementation.createHTMLDocument('t');
  d.body.innerHTML = `<div id="root">${html}</div>`;
  return d;
}

describe('総点検の画面の確かめ方', () => {
  it('例外の画面・停止画面は、どの画面の点検でも失敗にする', () => {
    for (const route of ['', 'records', 'stats', 'settings', 'add']) {
      expect(screenState(doc('<main data-screen="error"><h1>画面を表示できませんでした</h1></main>'), route)).toMatch(/例外の画面/);
      expect(screenState(doc('<main data-screen="stopped"><h1>新しい版で開いてください</h1></main>'), route)).toMatch(/停止画面/);
    }
  });

  it('読み込み中は待つ。別の画面が出たら失敗にする', () => {
    expect(screenState(doc('<main data-screen="loading" aria-busy="true"></main>'), 'stats')).toBe('wait');
    expect(screenState(doc(''), 'stats')).toBe('wait');
    expect(screenState(doc('<main data-screen="home"><h1>x</h1></main>'), 'stats')).toMatch(/期待した画面（stats）/);
  });

  it('正常な空の画面・予測できない画面は通し、期待した値が無ければ失敗にする', () => {
    expect(screenState(doc('<main data-screen="stats"><h1>集計</h1></main>'), 'stats')).toBeNull();
    const home = doc('<main data-screen="home"><p>目安の日を出せません</p><span>1000.1</span></main>');
    expect(screenState(home, '', { texts: ['1000.1'] })).toBeNull();
    expect(screenState(home, '', { texts: ['240'] })).toMatch(/期待した表示「240」/);
  });
});
