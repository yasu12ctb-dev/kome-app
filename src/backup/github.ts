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


type Classified = { errorKind: BackupErrorKind; retryAfter: string | null; message: string };

/** 通信の結果。本文は読む必要があるときだけ、打ち切りの時間の中で読み終えておく */
interface Raw {
  status: number;
  headers: Headers;
  text: string | null;
}

/** 403・429 の rate limit 判定と、再試行してよい時刻 */
function rateLimit(raw: Raw, now: Date): { limited: boolean; retryAfter: string } {
  const retryAfterSec = raw.headers.get('retry-after');
  const remaining = raw.headers.get('x-ratelimit-remaining');
  const reset = raw.headers.get('x-ratelimit-reset');
  const limited = raw.status === 429 || retryAfterSec !== null || remaining === '0';
  let at = now.getTime() + 60_000;
  if (retryAfterSec !== null && Number.isFinite(Number(retryAfterSec))) at = now.getTime() + Number(retryAfterSec) * 1000;
  else if (reset !== null && Number.isFinite(Number(reset))) at = Number(reset) * 1000;
  return { limited, retryAfter: new Date(at).toISOString() };
}

/** 成功・404・409・422 以外の状態コードを §4.1 の種類に分ける */
function classify(raw: Raw, now: Date): Classified {
  const message = `HTTP ${raw.status}`;
  if (raw.status === 401) return { errorKind: 'auth', retryAfter: null, message };
  if (raw.status === 403 || raw.status === 429) {
    const rl = rateLimit(raw, now);
    if (rl.limited) return { errorKind: 'rate-limit', retryAfter: rl.retryAfter, message };
    return { errorKind: 'auth', retryAfter: null, message };
  }
  if (raw.status >= 500) return { errorKind: 'network', retryAfter: null, message };
  return { errorKind: 'invalid', retryAfter: null, message };
}

const NOT_JSON = Symbol('not-json');

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${options.token}`,
  };

  /** 要求から本文の読み終わりまでを 1 つの打ち切り時間（15 秒）に収める。途中で止まれば network */
  async function send(url: string, init: RequestInit, readBody: (status: number) => boolean): Promise<Raw | Classified> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
    try {
      const res = await doFetch(url, { ...init, headers, signal: controller.signal, cache: 'no-store' });
      const text = readBody(res.status) ? await res.text() : null;
      return { status: res.status, headers: res.headers, text };
    } catch (e) {
      // 通信断・打ち切り・本文の途中切断。鍵を含みうる要求の中身は記録しない（I10）
      return { errorKind: 'network', retryAfter: null, message: e instanceof Error ? e.name : 'network error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get(target) {
      const raw = await send(`${contentsUrl(target)}?ref=${encodeURIComponent(target.branch)}`, { method: 'GET' }, (st) => st === 200);
      if (!('status' in raw)) return { kind: 'error', ...raw };
      if (raw.status === 404) return { kind: 'not-found' };
      if (raw.status !== 200) return { kind: 'error', ...classify(raw, now()) };
      // 読めた本文の形が違うのは invalid（通信の失敗とは分ける）
      const body = parseJson(raw.text ?? '');
      if (!isRecord(body) || body.type !== 'file' || body.encoding !== 'base64' || typeof body.sha !== 'string' || typeof body.content !== 'string') {
        return { kind: 'error', errorKind: 'invalid', retryAfter: null, message: 'ファイルの形式が想定と違います' };
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = fromBase64(body.content);
      } catch {
        return { kind: 'error', errorKind: 'invalid', retryAfter: null, message: 'ファイルの中身を読めません' };
      }
      return { kind: 'ok', sha: body.sha, bytes };
    },

    async put(target, { bytes, message, sha }) {
      const payload: Record<string, string> = { message, content: toBase64(bytes), branch: target.branch };
      if (sha !== null) payload.sha = sha;
      const raw = await send(contentsUrl(target), { method: 'PUT', body: JSON.stringify(payload) }, (st) => st === 200 || st === 201);
      if (!('status' in raw)) return { kind: 'error', ...raw };
      if (raw.status === 200 || raw.status === 201) {
        // 確定はしたが成功の情報を読めない → network（届いたかは次回の照合で確かめる）
        const body = parseJson(raw.text ?? '');
        const content = isRecord(body) ? body.content : undefined;
        // 次回に使うのは content.sha（blob sha）。commit.sha は使わない
        const contentSha = isRecord(content) ? content.sha : undefined;
        if (typeof contentSha !== 'string') return { kind: 'error', errorKind: 'network', retryAfter: null, message: '成功の応答を読めません' };
        return { kind: 'ok', sha: contentSha };
      }
      if (raw.status === 409 || raw.status === 422) return { kind: 'conflict-candidate', status: raw.status };
      if (raw.status === 404) return { kind: 'error', errorKind: 'config', retryAfter: null, message: 'HTTP 404' };
      return { kind: 'error', ...classify(raw, now()) };
    },
  };
}
