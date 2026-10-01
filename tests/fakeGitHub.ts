// 試験用の GitHub Contents API。sha の照合・409／422・応答の喪失・待たせる barrier を再現する

export interface FakeRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Hook = (req: FakeRequest) => Promise<Response | void> | Response | void;

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  // GitHub と同じく 60 文字ごとに改行を入れて返す
  return btoa(s).replace(/(.{60})/g, '$1\n');
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function fakeGitHub() {
  const files = new Map<string, { bytes: Uint8Array; sha: string }>();
  const commits: string[] = [];
  const requests: FakeRequest[] = [];
  let n = 0;
  const hooks: {
    /** 応答を差し替える（返せばそれを応答にする）。投げれば通信失敗 */
    onRequest?: Hook | undefined;
    /** PUT が確定する直前に待たせる */
    beforeCommit?: ((req: FakeRequest) => Promise<void>) | undefined;
    /** PUT が確定した後、応答を返す代わりに通信失敗にする（1 回だけ） */
    dropResponseAfterCommit?: boolean;
  } = {};

  function setRemote(path: string, text: string): string {
    const sha = `blob-${++n}`;
    files.set(path, { bytes: new TextEncoder().encode(text), sha });
    commits.push(`external ${sha}`);
    return sha;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const u = new URL(url);
    // ファイルは「リポジトリ名/パス」で区別する
    const m = /^\/repos\/[^/]+\/([^/]+)\/contents\/(.*)$/.exec(u.pathname);
    const path = m ? `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}` : u.pathname;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const req: FakeRequest = { method: init?.method ?? 'GET', url, path, headers, body };
    requests.push(req);
    const override = await hooks.onRequest?.(req);
    if (override) return override;

    if (req.method === 'GET') {
      const f = files.get(path);
      if (!f) return json(404, { message: 'Not Found' });
      return json(200, { type: 'file', encoding: 'base64', sha: f.sha, content: b64(f.bytes) });
    }
    if (req.method === 'PUT' && body) {
      const existing = files.get(path);
      const sha = body.sha as string | undefined;
      if (sha === undefined && existing) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      // 実物（2026-10-01 に kome-data で実測）: ファイルが無ければ sha を付けても新規作成になり 201 を返す
      if (sha !== undefined && existing && existing.sha !== sha) return json(409, { message: `${path} does not match ${sha}` });
      await hooks.beforeCommit?.(req);
      const newSha = `blob-${++n}`;
      files.set(path, { bytes: unb64(String(body.content)), sha: newSha });
      commits.push(String(body.message));
      if (hooks.dropResponseAfterCommit) {
        hooks.dropResponseAfterCommit = false;
        throw new TypeError('Load failed');
      }
      return json(existing ? 200 : 201, { content: { sha: newSha }, commit: { sha: `commit-${n}` } });
    }
    return json(405, { message: 'unsupported' });
  };

  return {
    fetch: fetchImpl,
    files,
    commits,
    requests,
    hooks,
    setRemote,
    text(path: string): string | null {
      const f = files.get(path);
      return f ? new TextDecoder().decode(f.bytes) : null;
    },
  };
}
