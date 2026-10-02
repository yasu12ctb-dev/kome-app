import { useState } from 'react';
import type { RestorePreview } from '../backup/service';
import { fitFontSize } from './fit';
import { kg } from './format';

// 復元の確認（§6.1 手順 2・3）と、GitHub との食い違い（§4.3）

function shortDate(ymd: string | null): string {
  if (!ymd) return '—';
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}`;
}

export function RestoreDialog(props: { preview: RestorePreview; onConfirm: () => Promise<'ok' | 'changed' | 'error'>; onClose: () => void }) {
  const { preview } = props;
  const [state, setState] = useState<'idle' | 'busy' | 'changed' | 'error'>('idle');
  return (
    <div className="dialog screen" role="dialog" aria-modal="true" aria-labelledby="restore-title">
      <div style={{ height: 44 }} />
      <h1 id="restore-title" style={{ margin: '20px 0 0', fontSize: 30, fontWeight: 900, lineHeight: 1.3 }}>
        {preview.source === 'github' ? 'GitHub のバックアップで' : 'このファイルで'}
        <br />
        置き換えますか
      </h1>
      <div className="compare">
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>この端末</span>
          <span className="num count" style={{ color: 'var(--line)', fontSize: fitFontSize(String(preview.local.count), 110, 32 + 40 + 200) }}>
            {preview.local.count}
          </span>
          <span className="sub" style={{ fontSize: 14, marginTop: 6 }}>
            件・{kg(preview.local.totalKg)} kg・最後 {shortDate(preview.local.lastDate)}
          </span>
        </div>
        <span aria-hidden="true" style={{ fontSize: 36, fontWeight: 900, paddingBottom: 40, textAlign: 'center' }}>
          →
        </span>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>バックアップ</span>
          <span className="num count" style={{ fontSize: fitFontSize(String(preview.backup.count), 110, 32 + 40 + 200) }}>
            {preview.backup.count}
          </span>
          <span style={{ fontSize: 14, marginTop: 6 }}>
            件・{kg(preview.backup.totalKg)} kg・最後 {shortDate(preview.backup.lastDate)}
          </span>
        </div>
      </div>
      <p className="notice">
        端末の {preview.local.count} 件を、バックアップの {preview.backup.count} 件で置き換えます。置き換える前の端末の内容は、この端末の中に 1 つだけ残り、取り消せます。
        {preview.source === 'github' && ' 復元のあとは、この端末がこのバックアップを引き継いで GitHub を更新します。'}
      </p>
      {state === 'changed' && (
        <p className="errors" role="alert">
          確認している間に、端末か GitHub の内容が変わりました。もう一度やり直してください。
        </p>
      )}
      {state === 'error' && (
        <p className="errors" role="alert">
          GitHub と通信できませんでした。置き換えていません。
        </p>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="primary"
          disabled={state !== 'idle'}
          onClick={async () => {
            setState('busy');
            const r = await props.onConfirm();
            if (r === 'ok') props.onClose();
            else setState(r);
          }}
        >
          置き換える
        </button>
        <button type="button" className="textlink" style={{ alignSelf: 'center' }} onClick={props.onClose}>
          やめる
        </button>
      </div>
    </div>
  );
}

export function ConflictDialog(props: { onOverwrite: () => Promise<void>; onRestore: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  return (
    <div className="dialog screen" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div className="banner" style={{ background: 'var(--shu)', color: '#fff' }}>
        保存を止めています
      </div>
      <h1 id="conflict-title" style={{ margin: '22px 0 0', fontSize: 28, fontWeight: 900, lineHeight: 1.35 }}>
        GitHub に、この端末が送っていないデータがあります
      </h1>
      <p className="notice">
        GitHub 上で手で書き換えたか、別の端末から保存された可能性があります。どちらを残すか選んでください。「GitHub から復元」を選ぶと、両方の件数を並べて確認してから置き換えます。上書きしても、前の内容は GitHub の履歴に残ります。
      </p>
      <div className="dialog-actions">
        <button type="button" className="primary" disabled={busy} onClick={act(props.onOverwrite)}>
          この端末の内容で上書き
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={act(props.onRestore)}>
          GitHub から復元
        </button>
        <button type="button" className="textlink" style={{ alignSelf: 'center' }} onClick={props.onClose}>
          あとで決める
        </button>
      </div>
    </div>
  );
}
