// 表示の総点検（開発サーバー専用）。状態ごとに試験データを入れ、アプリを複数の画面幅の iframe で開いて、
// 全画面のはみ出し・文字同士の重なり・欄の中で切れた文字を測る。使い方: /kome-app/tools/audit.html を開き、
//   const m = await import('/kome-app/tools/layout-audit.js'); await m.run()   （1 回 45 秒に収めるなら run(['over3']) のように分ける）
// ダークの点検は、ブラウザ側で prefers-color-scheme: dark にしてから同じく run() する

const DAY = 86_400_000;
function ymd(offsetDays) {
  const t = new Date(Date.now() + offsetDays * DAY);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

// [受取日の今日からの日数, kg, 代金, 支払い済み]
export const SCENARIOS = {
  empty: [],
  one: [[-10, 30, 12000, true]],
  ahead2: [[-128, 30, 12000, true], [-89, 30, 12000, true], [-50, 30, 12500, true], [-11, 30, 13000, false]],
  ahead3: [[-210, 30, 12000, true], [-10, 30, 12000, true]],
  soon: [[-73, 30, 12000, true], [-36, 30, 12000, true]],
  today: [[-80, 30, 12000, true], [-40, 30, 12000, true]],
  over2: [[-90, 30, 12000, true], [-50, 30, 12000, false]],
  over3: [[-400, 30, 12000, true], [-350, 30, 12000, true]],
  over4: [[-3000, 30, 12000, true], [-2990, 30, 12000, true]],
  many: Array.from({ length: 120 }, (_, i) => [-(i * 30 + 1), 30, 999999, false]),
  heavy: [[-60, 999.9, 9999999, false], [-30, 999.9, 9999999, false], [-1, 0.1, null, false]],
  unpaidZero: [[-40, 30, 12000, true], [-10, 30, 0, false]],
  unpaidMixed: [[-70, 30, 12000, false], [-40, 30, 12000, false], [-10, 30, null, false]],
  unpaidMissing: [[-40, 30, null, false], [-10, 30, null, false]],
  sameDay: [[-5, 30, 12000, true], [-5, 30, 12000, true]],
  skewed: gapsToRows([1, 1, 1, 1, 1, 1, 1000, 1]),
  outOfRange: [[daysFromToday('2020-01-01'), 0.1, null, true], [0, 1000, null, true]],
  // 長い保存先の名前と、保存を止めているエラーの帯（meta を直接書く。アプリの経路は通らない）
  errorBanner: {
    rows: [[-40, 30, 12000, true], [-10, 30, 12000, true]],
    lineage: {
      config: { owner: 'a-very-long-github-owner-name-x', repo: 'a-very-long-repository-name-for-kome-backup-data', branch: 'main', path: 'kome-backup.json' },
      errorKind: 'conflict',
      lastErrorMessage: 'GitHub に、この端末が送っていないデータがあります（409 Conflict: is at 0123456789abcdef0123456789abcdef01234567 but expected fedcba9876543210）',
    },
  },
};

function daysFromToday(isoYmd) {
  const [y, m, d] = isoYmd.split('-').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d) - today) / DAY);
}

/** 古い順の間隔（日）から、最後の受け取りを 1 日前とする記録を作る */
function gapsToRows(gaps) {
  let off = -1 - gaps.reduce((a, b) => a + b, 0);
  const rows = [[off, 30, 12000, true]];
  for (const g of gaps) {
    off += g;
    rows.push([off, 30, 12000, true]);
  }
  return rows;
}

// edit-delete は編集画面で「この記録を削除」を押した確認の画面
const ROUTES = ['', 'records', 'records?unpaid', 'stats', 'settings', 'add', 'edit', 'edit-delete'];
const WIDTHS = [375, 390, 430];

async function deleteDb() {
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('kome');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

function idbDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function patchLineage(patch) {
  const db = await idbDone(indexedDB.open('kome'));
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  const cur = await idbDone(store.get('backup'));
  store.put({ ...cur, ...patch }, 'backup');
  await new Promise((r) => (tx.oncomplete = r));
  db.close();
}

async function seed(scenario) {
  const rows = Array.isArray(scenario) ? scenario : scenario.rows;
  await deleteDb();
  const { openRepo } = await import('/src/data/repo.ts');
  const r = await openRepo({});
  if (r.kind !== 'ok') throw new Error(r.reason);
  const ids = [];
  for (const [off, kg, priceYen, paid] of rows) {
    const x = await r.repo.addReceipt({ date: ymd(off), kg, priceYen, paid });
    if (!x.ok) throw new Error(`seed failed: ${JSON.stringify(x)}`);
    ids.push(x.receipt.id);
  }
  r.repo.close();
  if (!Array.isArray(scenario) && scenario.lineage) await patchLineage(scenario.lineage);
  return ids;
}

const HIDDEN = '.visually-hidden, .kg-mirror, [aria-hidden="true"] .bag';

function visibleText(doc) {
  // 見えている文字のかたまり（テキストノード単位）の矩形
  // 確認の画面が開いていれば、その下の画面は隠れているので確認の画面の中だけを見る
  const dialogs = doc.querySelectorAll('#root [role="dialog"]');
  const scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : doc.getElementById('root');
  const out = [];
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    const el = n.parentElement;
    if (!t || !el || el.closest(HIDDEN)) continue;
    const cs = doc.defaultView.getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const range = doc.createRange();
    range.selectNodeContents(n);
    // 文字の外枠（行の高さ）は字形より上下に大きいので、字の大きさの 74% を字形の高さとして縦を詰める
    const ink = 0.74 * parseFloat(cs.fontSize);
    for (const b of range.getClientRects()) {
      if (b.width === 0 || b.height === 0) continue;
      const cy = (b.top + b.bottom) / 2;
      const h = Math.min(b.height, ink);
      out.push({ r: { left: b.left, right: b.right, top: cy - h / 2, bottom: cy + h / 2, height: h }, t: t.slice(0, 16), el });
    }
  }
  return out;
}

function overlaps(doc) {
  const items = visibleText(doc);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].r;
      const b = items[j].r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 2 && h > 2) out.push(`文字が重なる「${items[i].t}」と「${items[j].t}」`);
    }
  }
  return out;
}

function clipped(doc) {
  // はみ出しを隠す箱の中で、文字が切れている
  const out = [];
  for (const el of doc.querySelectorAll('#root *')) {
    if (el.closest(HIDDEN) || !el.textContent.trim()) continue;
    const cs = doc.defaultView.getComputedStyle(el);
    const hides = ['hidden', 'clip'].includes(cs.overflowX) || ['hidden', 'clip'].includes(cs.overflowY);
    if (!hides) continue;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      out.push(`箱の中で文字が切れる ${el.scrollWidth}x${el.scrollHeight}>${el.clientWidth}x${el.clientHeight} ${el.tagName.toLowerCase()}.${el.className}「${el.textContent.trim().slice(0, 20)}」`);
  }
  return out;
}

function overflow(win) {
  const doc = win.document;
  const vw = win.innerWidth;
  const out = [];
  if (doc.documentElement.scrollWidth > vw + 1) out.push(`ページの横幅 ${doc.documentElement.scrollWidth} > ${vw}`);
  for (const el of doc.querySelectorAll('#root *')) {
    if (el.closest('.visually-hidden') || el.closest('.kg-mirror')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const label = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : ''}「${(el.textContent || '').trim().slice(0, 24)}」`;
    if (r.right > vw + 1) out.push(`右へはみ出し ${Math.round(r.right - vw)}px ${label}`);
    if (r.left < -1 && !el.classList.contains('banner')) out.push(`左へはみ出し ${Math.round(-r.left)}px ${label}`);
    if ((el.tagName === 'INPUT') && el.scrollWidth > el.clientWidth + 1) out.push(`入力欄の中身が欠ける ${el.scrollWidth}>${el.clientWidth} ${label}`);
  }
  return [...new Set([...out, ...overlaps(doc), ...clipped(doc)])];
}

// 画面ごとの目印（各画面の main の data-screen）。停止画面（stopped）・例外の画面（error）は、通常の点検では失敗とする
const SCREEN_OF_ROUTE = { '': 'home', records: 'records', 'records?unpaid': 'records-unpaid', stats: 'stats', settings: 'settings', add: 'add', edit: 'edit', 'edit-delete': 'edit' };

/** 期待した画面が出ていれば null、まだなら 'wait'、別の画面（停止・例外を含む）なら理由の文字列 */
export function screenState(doc, route, expect = {}) {
  const main = doc.querySelector('#root main[data-screen]');
  if (!main) return 'wait';
  const screen = main.getAttribute('data-screen');
  if (screen === 'loading') return 'wait';
  if (screen === 'error' || screen === 'stopped') return `通常の画面でなく${screen === 'error' ? '例外の画面' : '停止画面'}が出た「${(main.querySelector('h1')?.textContent ?? '').trim().slice(0, 30)}」`;
  const want = SCREEN_OF_ROUTE[route] ?? 'home';
  if (screen !== want) return `期待した画面（${want}）でなく ${screen} が出た`;
  // 期待するデータが画面に出ているか（シナリオの合計量など）
  for (const t of expect.texts ?? []) if (!main.textContent.includes(t)) return `期待した表示「${t}」が無い`;
  return null;
}

async function waitReady(win, route, expect) {
  // 固定の待ち時間ではなく、期待した画面とデータが出たことを確かめる（最大 4 秒）
  let last = 'wait';
  for (let i = 0; i < 80; i++) {
    const doc = win.document;
    last = screenState(doc, route, expect);
    if (last === null && doc.fonts.status === 'loaded') {
      // 表示枠が隠れていると描画の合図が来ないので、時間でも抜ける
      await Promise.race([new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r))), new Promise((r) => setTimeout(r, 150))]);
      return null;
    }
    if (last !== null && last !== 'wait') return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last === 'wait' ? '画面の読み込みが終わらない' : last;
}

async function open(route, width, editId, expect) {
  const frame = document.createElement('iframe');
  frame.style.cssText = `width:${width}px;height:844px;border:1px solid #999`;
  const hash = route.startsWith('edit') ? `edit/${editId}` : route;
  frame.src = `/kome-app/#${hash}`;
  document.body.append(frame);
  await new Promise((r) => (frame.onload = r));
  const win = frame.contentWindow;
  const notReady = await waitReady(win, route, expect);
  if (!notReady && route === 'edit-delete') {
    const btn = [...win.document.querySelectorAll('button')].find((b) => b.textContent.includes('この記録を削除'));
    btn?.click();
    await new Promise((r) => setTimeout(r, 100));
    if (!win.document.querySelector('[role="dialog"]')) {
      frame.remove();
      return { result: ['削除の確認が開かない'], text: '' };
    }
  }
  const result = notReady ? [notReady] : overflow(win);
  const text = frame.contentDocument.body.innerText.replace(/\s+/g, ' ').slice(0, 80);
  frame.remove();
  await new Promise((r) => setTimeout(r, 50));
  return { result, text };
}

/** シナリオから、画面に出ているはずの値（ホームの合計量・集計の年の合計）を作る */
function expectFor(scenario, route) {
  const rows = Array.isArray(scenario) ? scenario : scenario.rows;
  if (rows.length === 0) return {};
  const total = rows.reduce((s, r) => s + Math.round(r[1] * 10), 0) / 10;
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1)); // src/ui/format.ts の kg と同じ
  if (route === '') return { texts: [fmt(total)] };
  return {};
}

export async function run(only) {
  const report = [];
  for (const [name, rows] of Object.entries(SCENARIOS)) {
    if (only && !only.includes(name)) continue;
    const ids = await seed(rows);
    for (const route of ROUTES) {
      if (route.startsWith('edit') && ids.length === 0) continue;
      for (const w of WIDTHS) {
        const { result, text } = await open(route, w, ids[0], expectFor(rows, route));
        if (result.length) report.push({ scenario: name, route: route || 'home', width: w, problems: result.slice(0, 6), text });
      }
    }
  }
  await deleteDb();
  return report;
}

// 検出の自己確認用（わざと崩した画面を測る）
export { overflow as measure, seed };
