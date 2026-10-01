import { useState } from 'react';
import { displayStatus } from '../backup/lineage';
import type { PreviewResult, RestorePreview } from '../backup/service';
import type { BackupConfig, Lineage, Receipt, Ymd } from '../data/types';
import { predictNext } from '../domain/stats';
import { buildIcs, saveFile } from '../app/ics';
import { dateTime, monthDay } from './format';
import type { KomeActions } from './useKome';

// 設定（GitHub バックアップ・復元・そのほか）。データを置き換える操作は「復元」の群に分ける

const STATUS = { unset: '未設定', saved: '保存済み', pending: '保存待ち', error: '止まっています' } as const;
const ERROR_TEXT: Record<string, string> = {
  auth: '鍵が使えません（期限切れ・取り消し・権限不足）。鍵を設定し直してください',
  config: 'リポジトリが見つからないか、鍵の権限がありません',
  conflict: 'GitHub 側に、この端末が送っていないデータがあります',
  invalid: 'GitHub が保存を受け付けませんでした',
  network: '通信できません。つながったら自動で送ります',
  'rate-limit': 'GitHub の回数制限です。少し待って自動で送ります',
};

function previewMessage(r: PreviewResult): string | null {
  switch (r.kind) {
    case 'ok':
      return null;
    case 'not-configured':
      return '先に GitHub バックアップを設定してください';
    case 'no-backup':
      return 'GitHub にバックアップがまだありません';
    case 'invalid':
      return r.reason === 'newer-schema' ? '新しい版のアプリで作られたバックアップです。アプリを更新してください' : `バックアップを読めません: ${r.errors.slice(0, 3).join('／')}`;
    case 'error':
      return ERROR_TEXT[r.errorKind] ?? '読み込めませんでした';
  }
}

export function Settings(props: {
  receipts: Receipt[];
  lineage: Lineage;
  dataRevision: number;
  deviceId: string;
  hasSnapshot: boolean;
  today: Ymd;
  version: string;
  actions: KomeActions;
  onPreview: (p: RestorePreview) => void;
  onConflict: () => void;
}) {
  const { lineage, actions } = props;
  const status = displayStatus(lineage, props.dataRevision);
  const [editing, setEditing] = useState(lineage.config === null);
  const [owner, setOwner] = useState(lineage.config?.owner ?? '');
  const [repo, setRepo] = useState(lineage.config?.repo ?? 'kome-data');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = predictNext(props.receipts, props.today);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  async function saveTarget() {
    const o = owner.trim();
    const r = repo.trim();
    if (!/^[A-Za-z0-9-]+$/.test(o) || !/^[A-Za-z0-9._-]+$/.test(r)) {
      setMessage('ユーザー名とリポジトリ名を英数字で入れてください');
      return;
    }
    const sameTarget = lineage.config?.owner === o && lineage.config?.repo === r;
    if (!token && !sameTarget) {
      setMessage('鍵（トークン）を入れてください');
      return;
    }
    const config: BackupConfig = { owner: o, repo: r, branch: 'main', path: 'kome-backup.json' };
    await run(async () => {
      const ok = await actions.saveConfig(config, token || undefined);
      // 鍵は画面に残さない（I10）
      setToken('');
      if (ok) setEditing(false);
      else setMessage('保存できませんでした。もう一度お試しください');
    });
  }

  async function restoreFromGitHub() {
    await run(async () => {
      const r = await actions.previewFromGitHub();
      if (r.kind === 'ok') props.onPreview(r.preview);
      else setMessage(previewMessage(r));
    });
  }

  async function restoreFromFile(file: File) {
    await run(async () => {
      const r = await actions.previewFromFile(new Uint8Array(await file.arrayBuffer()));
      if (r.kind === 'ok') props.onPreview(r.preview);
      else setMessage(previewMessage(r));
    });
  }

  return (
    <main className="screen">
      <a href="#" className="back">
        ← ホーム
      </a>
      <h1 className="title">設定</h1>

      <h2 className="section-h">GitHub バックアップ</h2>
      <div className="row">
        <span>状態</span>
        <span style={{ fontWeight: 800, color: status === 'error' ? 'var(--shu)' : undefined }}>
          {STATUS[status]}
          {status === 'saved' && lineage.lastPushedAt ? `　${dateTime(lineage.lastPushedAt)}` : ''}
        </span>
      </div>
      {lineage.errorKind && (
        <p role="status" style={{ margin: '8px 0', fontSize: 14, fontWeight: 700, color: 'var(--shu)' }}>
          {ERROR_TEXT[lineage.errorKind]}
          {lineage.errorKind === 'conflict' && (
            <>
              {' '}
              <button type="button" className="textlink" style={{ fontSize: 14, minHeight: 0 }} onClick={props.onConflict}>
                どちらを残すか選ぶ
              </button>
            </>
          )}
        </p>
      )}
      {!editing && lineage.config && (
        <>
          <div className="row">
            <span>保存先</span>
            <span className="sub">
              {lineage.config.owner} / {lineage.config.repo}
            </span>
          </div>
          <div className="row">
            <span>鍵（トークン）</span>
            <button type="button" className="textlink" style={{ fontSize: 15 }} onClick={() => setEditing(true)}>
              変更
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <button type="button" className="secondary" disabled={busy} onClick={() => void run(actions.retryNow)}>
              今すぐ保存
            </button>
          </div>
        </>
      )}
      {editing && (
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}
          onSubmit={(ev) => {
            ev.preventDefault();
            void saveTarget();
          }}
        >
          <label className="field-label" htmlFor="owner">
            GitHub のユーザー名
          </label>
          <input id="owner" className="text-input" autoComplete="off" autoCapitalize="off" spellCheck={false} value={owner} onChange={(ev) => setOwner(ev.target.value)} />
          <label className="field-label" htmlFor="repo">
            リポジトリ名（非公開のもの）
          </label>
          <input id="repo" className="text-input" autoComplete="off" autoCapitalize="off" spellCheck={false} value={repo} onChange={(ev) => setRepo(ev.target.value)} />
          <label className="field-label" htmlFor="token">
            鍵（トークン）{lineage.config ? '　変えるときだけ' : ''}
          </label>
          <input id="token" className="text-input" type="password" autoComplete="off" value={token} onChange={(ev) => setToken(ev.target.value)} />
          <p className="sub" style={{ margin: 0, fontSize: 12, lineHeight: 1.6 }}>
            Fine-grained の鍵で、このリポジトリだけ・Contents の読み書きだけにしてください。鍵はこの端末の中だけに置き、GitHub へ送るとき以外は使いません。
          </p>
          <button type="submit" className="primary" disabled={busy}>
            保存して送る
          </button>
          {lineage.config && (
            <button type="button" className="textlink" onClick={() => setEditing(false)}>
              やめる
            </button>
          )}
        </form>
      )}

      <h2 className="section-h">復元（端末の記録を置き換えます）</h2>
      <button type="button" className="row button" disabled={busy || !lineage.config} onClick={() => void restoreFromGitHub()}>
        GitHub から復元<span aria-hidden="true">→</span>
      </button>
      <label className="row button" style={{ cursor: 'pointer' }}>
        JSON ファイルから復元<span aria-hidden="true">→</span>
        <input
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(ev) => {
            const f = ev.target.files?.[0];
            ev.target.value = '';
            if (f) void restoreFromFile(f);
          }}
        />
      </label>
      <button
        type="button"
        className="row button"
        disabled={busy || !props.hasSnapshot}
        onClick={() =>
          void run(async () => {
            const r = await actions.undoRestore();
            setMessage(r === 'ok' ? '復元を取り消しました' : '取り消せませんでした');
          })
        }
      >
        復元の取り消し<span className="sub" style={{ fontSize: 12 }}>{props.hasSnapshot ? '直前の復元を戻す' : '復元した直後だけ'}</span>
      </button>

      <h2 className="section-h">そのほか</h2>
      <button
        type="button"
        className="row button"
        style={{ minHeight: 58 }}
        disabled={p.kind !== 'ok'}
        onClick={() => {
          if (p.kind !== 'ok') return;
          saveFile(document, buildIcs(p.nextDate, props.deviceId, new Date()), 'text/calendar;charset=utf-8', 'kome-next.ics');
        }}
      >
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <span>目安の日をカレンダーに入れる</span>
          <span className="sub" style={{ fontSize: 12 }}>{p.kind === 'ok' ? `${monthDay(p.nextDate)}・3日前に通知` : '2回記録すると使えます'}</span>
        </span>
        <span aria-hidden="true">→</span>
      </button>
      <button
        type="button"
        className="row button"
        onClick={() =>
          void run(async () => {
            const f = await actions.exportFile();
            saveFile(document, f.bytes, 'application/json', f.fileName);
          })
        }
      >
        JSON ファイルに書き出す<span aria-hidden="true">↓</span>
      </button>
      {lineage.config && !editing && (
        <button
          type="button"
          className="row button"
          style={{ color: 'var(--sub)' }}
          onClick={() =>
            void run(async () => {
              await actions.saveConfig(null);
              setEditing(true);
            })
          }
        >
          GitHub バックアップをやめる<span style={{ fontSize: 12 }}>鍵もこの端末から消します</span>
        </button>
      )}
      {message && (
        <p role="status" className="errors" style={{ marginTop: 14 }}>
          {message}
        </p>
      )}
      <div className="about">
        <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" />
        <span style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
          <span style={{ fontSize: 15, fontWeight: 800 }}>お米の記録</span>
          <span className="sub" style={{ fontSize: 12 }}>
            バージョン
          </span>
        </span>
        <span className="num" style={{ fontSize: 15 }}>
          {props.version}
        </span>
      </div>
    </main>
  );
}
