// 表示の総点検（開発サーバー専用）。状態ごとに試験データを入れ、アプリを複数の画面幅の iframe で開いて、
// 全画面のはみ出しを測る。使い方: /kome-app/tools/audit.html を開き、
//   const m = await import('/kome-app/tools/layout-audit.js'); await m.run()

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
};

const ROUTES = ['', 'records', 'records?unpaid', 'stats', 'settings', 'add', 'edit'];
const WIDTHS = [375, 390, 430];

async function deleteDb() {
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('kome');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

async function seed(rows) {
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
  return ids;
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
  return [...new Set(out)];
}

async function open(route, width, editId) {
  const frame = document.createElement('iframe');
  frame.style.cssText = `width:${width}px;height:844px;border:1px solid #999`;
  const hash = route === 'edit' ? `edit/${editId}` : route;
  frame.src = `/kome-app/#${hash}`;
  document.body.append(frame);
  await new Promise((r) => (frame.onload = r));
  await new Promise((r) => setTimeout(r, 600));
  const result = overflow(frame.contentWindow);
  const text = frame.contentDocument.body.innerText.replace(/\s+/g, ' ').slice(0, 80);
  frame.remove();
  await new Promise((r) => setTimeout(r, 50));
  return { result, text };
}

export async function run(only) {
  const report = [];
  for (const [name, rows] of Object.entries(SCENARIOS)) {
    if (only && !only.includes(name)) continue;
    const ids = await seed(rows);
    for (const route of ROUTES) {
      if (route === 'edit' && ids.length === 0) continue;
      for (const w of WIDTHS) {
        const { result, text } = await open(route, w, ids[0]);
        if (result.length) report.push({ scenario: name, route: route || 'home', width: w, problems: result.slice(0, 6), text });
      }
    }
  }
  await deleteDb();
  return report;
}
