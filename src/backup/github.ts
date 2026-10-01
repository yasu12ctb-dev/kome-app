import type { BackupConfig, BackupErrorKind } from '../data/types';
import { fromBase64, toBase64 } from './format';

// GitHub Contents API の契約（設計書 §4.1）。api.github.com へ通信するのはこのファイルだけ

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

export type GetResult =
  | { kind: 'ok'; sha: string; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'not-found' }
  | { kind: 'error'; errorKind: BackupErrorKind; retryAfter: string | null; message: string };

export type PutResult =
  | { kind: 'ok'; sha: string }
  /** sha 衝突の候補（409・422）。本当に衝突かは呼び出し側が直後の GET で決める */
  | { kind: 'conflict-candidate'; status: 409 | 422 }
  | { kind: 'error'; errorKind: BackupErrorKind; retryAfter: string | null; message: string };

export interface GitHubClient {
  get(target: BackupConfig): Promise<GetResult>;
  put(target: BackupConfig, body: { bytes: Uint8Array; message: string; sha: string | null }): Promise<PutResult>;
}

export interface GitHubClientOptions {
  token: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

function contentsUrl(t: BackupConfig): string {
  const path = t.path.split('/').map(encodeURIComponent).join('/');
  return `${API}/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/contents/${path}`;
}

/** 403・429 の rate limit 判定と、再試行してよい時刻 */
function rateLimit(res: Response, now: Date): { limited: boolean; retryAfter: string } {
  const retryAfterSec = res.headers.get('retry-after');
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  const limited = res.status === 429 || retryAfterSec !== null || remaining === '0';
  let at = now.getTime() + 60_000;
  if (retryAfterSec !== null && Number.isFinite(Number(retryAfterSec))) at = now.getTime() + Number(retryAfterSec) * 1000;
  else if (reset !== null && Number.isFinite(Number(reset))) at = Number(reset) * 1000;
  return { limited, retryAfter: new Date(at).toISOString() };
}

type Classified = { errorKind: BackupErrorKind; retryAfter: string | null; message: string };

/** 成功・404・409・422 以外の状態コードを §4.1 の種類に分ける */
function classify(res: Response, now: Date): Classified {
  const message = `HTTP ${res.status}`;
  if (res.status === 401) return { errorKind: 'auth', retryAfter: null, message };
  if (res.status === 403 || res.status === 429) {
    const rl = rateLimit(res, now);
    if (rl.limited) return { errorKind: 'rate-limit', retryAfter: rl.retryAfter, message };
    return { errorKind: 'auth', retryAfter: null, message };
  }
  if (res.status >= 500) return { errorKind: 'network', retryAfter: null, message };
  return { errorKind: 'invalid', retryAfter: null, message };
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${options.token}`,
  };

  async function send(url: string, init: RequestInit): Promise<Response | Classified> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
    try {
      return await doFetch(url, { ...init, headers, signal: controller.signal, cache: 'no-store' });
    } catch (e) {
      // 鍵を含みうる要求の中身は記録しない（I10）
      return { errorKind: 'network', retryAfter: null, message: e instanceof Error ? e.name : 'network error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get(target) {
      const res = await send(`${contentsUrl(target)}?ref=${encodeURIComponent(target.branch)}`, { method: 'GET' });
      if (!(res instanceof Response)) return { kind: 'error', ...res };
      if (res.status === 404) return { kind: 'not-found' };
      if (res.status !== 200) return { kind: 'error', ...classify(res, now()) };
      let body: { type?: unknown; encoding?: unknown; sha?: unknown; content?: unknown };
      try {
        body = await res.json();
      } catch {
        return { kind: 'error', errorKind: 'invalid', retryAfter: null, message: '応答が JSON ではありません' };
      }
      if (body.type !== 'file' || body.encoding !== 'base64' || typeof body.sha !== 'string' || typeof body.content !== 'string') {
        return { kind: 'error', errorKind: 'invalid', retryAfter: null, message: 'ファイルの形式が想定と違います' };
      }
      return { kind: 'ok', sha: body.sha, bytes: fromBase64(body.content) };
    },

    async put(target, { bytes, message, sha }) {
      const payload: Record<string, string> = { message, content: toBase64(bytes), branch: target.branch };
      if (sha !== null) payload.sha = sha;
      const res = await send(contentsUrl(target), { method: 'PUT', body: JSON.stringify(payload) });
      if (!(res instanceof Response)) return { kind: 'error', ...res };
      if (res.status === 200 || res.status === 201) {
        let body: { content?: { sha?: unknown } };
        try {
          body = await res.json();
        } catch {
          return { kind: 'error', errorKind: 'network', retryAfter: null, message: '応答が JSON ではありません' };
        }
        // 次回に使うのは content.sha（blob sha）。commit.sha は使わない
        const contentSha = body.content?.sha;
        if (typeof contentSha !== 'string') return { kind: 'error', errorKind: 'network', retryAfter: null, message: 'content.sha がありません' };
        return { kind: 'ok', sha: contentSha };
      }
      if (res.status === 409 || res.status === 422) return { kind: 'conflict-candidate', status: res.status };
      if (res.status === 404) return { kind: 'error', errorKind: 'config', retryAfter: null, message: 'HTTP 404' };
      return { kind: 'error', ...classify(res, now()) };
    },
  };
}
