// U2 の関門: 本番と同じ CSP のページから、PAT 付きで Contents API の GET → 新規 PUT → sha 付き更新 → 古い sha の拒否 を通しで確かめる。
// 確認用のファイルは最後に消す。鍵は表示・保存しない。

const API = 'https://api.github.com';
const form = document.querySelector<HTMLFormElement>('#form')!;
const log = document.querySelector<HTMLOListElement>('#log')!;
const result = document.querySelector<HTMLParagraphElement>('#result')!;

function line(text: string, ok: boolean): void {
  const li = document.createElement('li');
  li.textContent = `${ok ? '○' : '×'} ${text}`;
  li.className = ok ? 'ok' : 'ng';
  log.append(li);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/\n/g, ''));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  log.textContent = '';
  result.textContent = '';
  const tokenInput = document.querySelector<HTMLInputElement>('#token')!;
  const token = tokenInput.value.trim();
  const repo = document.querySelector<HTMLInputElement>('#repo')!.value.trim();
  const path = `spike/gate-${Date.now()}.json`;
  const url = `${API}/repos/${repo}/contents/${path}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
  };
  const enc = new TextEncoder();
  const body1 = enc.encode('{\n  "gate": 1\n}\n');
  const body2 = enc.encode('{\n  "gate": 2\n}\n');
  let allOk = true;
  const check = (label: string, cond: boolean) => {
    line(label, cond);
    if (!cond) allOk = false;
    return cond;
  };
  let created = false;
  let currentSha: string | null = null;
  try {
    const g0 = await fetch(`${url}?ref=main`, { headers });
    check(`1. 無いファイルの GET → 404（実際 ${g0.status}）`, g0.status === 404);

    const p1 = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ message: 'gate: create', content: toBase64(body1), branch: 'main' }) });
    const p1j = await p1.json();
    created = p1.status === 201;
    const sha1: string | undefined = p1j?.content?.sha;
    currentSha = sha1 ?? null;
    check(`2. sha なしの新規 PUT → 201（実際 ${p1.status}）、content.sha あり`, created && typeof sha1 === 'string');
    check(`   応答から X-RateLimit-Remaining が読める（${p1.headers.get('x-ratelimit-remaining') ?? '読めない'}）`, p1.headers.get('x-ratelimit-remaining') !== null);

    const g1 = await fetch(`${url}?ref=main`, { headers });
    const g1j = await g1.json();
    const same = g1j?.sha === sha1;
    const hashOk = g1.ok && (await sha256Hex(fromBase64(g1j.content))) === (await sha256Hex(body1));
    check(`3. GET の sha が PUT の content.sha と一致（${same}）、本文の SHA-256 が一致（${hashOk}）`, same && hashOk);

    const p2 = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ message: 'gate: update', content: toBase64(body2), branch: 'main', sha: sha1 }) });
    const p2j = await p2.json();
    const sha2: string | undefined = p2j?.content?.sha;
    if (sha2) currentSha = sha2;
    check(`4. sha 付きの更新 PUT → 200（実際 ${p2.status}）`, p2.status === 200 && typeof sha2 === 'string');

    const p3 = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ message: 'gate: stale', content: toBase64(body1), branch: 'main', sha: sha1 }) });
    check(`5. 古い sha の PUT → 409（実際 ${p3.status}）`, p3.status === 409);

    const p4 = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ message: 'gate: no sha', content: toBase64(body1), branch: 'main' }) });
    check(`6. 既にあるファイルへ sha なしの PUT → 422（実際 ${p4.status}）`, p4.status === 422);
  } catch (e) {
    check(`通信が失敗しました（${e instanceof Error ? e.name : 'error'}）。CORS か CSP で止められた可能性`, false);
  } finally {
    if (created && currentSha) {
      const d = await fetch(url, { method: 'DELETE', headers, body: JSON.stringify({ message: 'gate: cleanup', sha: currentSha, branch: 'main' }) }).catch(() => null);
      line(`後片付け: 確認用ファイルを DELETE（${d ? d.status : '失敗'}）`, d?.status === 200);
    }
    tokenInput.value = '';
    result.textContent = allOk ? '合格：ブラウザから通しで動きました' : '不合格：× の行を確認してください';
    result.className = allOk ? 'ok' : 'ng';
  }
});
