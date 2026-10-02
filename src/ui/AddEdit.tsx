import { useState } from 'react';
import type { Receipt, Ymd } from '../data/types';
import type { ReceiptInput, WriteResult, DeleteResult } from '../data/repo';
import { unitPriceYen } from '../domain/stats';
import { kg as fmtKg } from './format';

// 記録の追加・編集（設計書 §0 の画面表・I1: 保存に失敗したら入力を残す）

const QUICK = [10, 20, 30];

/** 桁が増えたら字を小さくし、どの値でも画面の幅に収める（「30」はいちばん大きく） */
function kgFontSize(text: string): string {
  const n = Math.max(2, text.length);
  if (n <= 2) return 'clamp(120px, 48vw, 190px)';
  if (n === 3) return 'clamp(96px, 36vw, 150px)';
  if (n === 4) return 'clamp(76px, 28vw, 120px)';
  return 'clamp(56px, 20vw, 90px)';
}

export function AddEdit(props: {
  today: Ymd;
  editing: Receipt | null;
  lastKg: number | null;
  onSave: (input: ReceiptInput) => Promise<WriteResult>;
  onDelete: (id: string) => Promise<DeleteResult>;
  onDone: () => void;
}) {
  const e = props.editing;
  const [date, setDate] = useState<Ymd>(e?.date ?? props.today);
  const [kgText, setKgText] = useState<string>(fmtKg(e?.kg ?? props.lastKg ?? 30));
  const [priceText, setPriceText] = useState<string>(e?.priceYen != null ? String(e.priceYen) : '');
  const [paid, setPaid] = useState<boolean>(e?.paid ?? false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dirty, setDirty] = useState(false);

  const kgValue = Number(kgText);
  const priceValue = priceText.trim() === '' ? null : Number(priceText.replace(/[,，]/g, ''));
  const unit = Number.isFinite(kgValue) && kgValue > 0 && priceValue !== null && Number.isFinite(priceValue) ? unitPriceYen({ kg: kgValue, priceYen: priceValue } as Receipt) : null;

  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };
  const step = (delta: number) => {
    const next = Math.max(0.5, Math.round(((Number.isFinite(kgValue) ? kgValue : 30) + delta) * 10) / 10);
    touch(setKgText)(fmtKg(next));
  };

  async function save() {
    setSaving(true);
    setErrors([]);
    const result = await props.onSave({ date, kg: kgValue, priceYen: priceValue, paid });
    setSaving(false);
    if (result.ok) {
      setDirty(false);
      props.onDone();
      return;
    }
    // 入力はそのまま残す（I1）
    if (result.kind === 'invalid') setErrors(result.errors.map((x) => x.message));
    else if (result.kind === 'not-found') setErrors(['この記録はもうありません（別の画面で消された可能性があります）']);
    else setErrors(['保存できませんでした。もう一度お試しください']);
  }

  async function remove() {
    if (!e) return;
    const r = await props.onDelete(e.id);
    setConfirmDelete(false);
    if (r.ok || r.kind === 'not-found') props.onDone();
    else setErrors(['削除できませんでした。もう一度お試しください']);
  }

  return (
    <main className="screen" data-screen={props.editing ? 'edit' : 'add'} data-dirty={dirty ? 'true' : 'false'}>
      <div className="topbar">
        <button type="button" className="back" onClick={props.onDone}>
          やめる
        </button>
        <span className="label">{e ? '記録を直す' : '受け取りを記録'}</span>
        <span style={{ width: 48 }} />
      </div>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
        style={{ display: 'contents' }}
      >
        <label htmlFor="kg" className="field-label" style={{ marginTop: 18 }}>
          量
        </label>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
          {/* 入力欄の幅は、同じ文字・同じ書体の見えない写しの実際の幅に合わせる（太い数字が欄からはみ出して切れないように） */}
          <span className="kg-field" style={{ ['--kg-size' as string]: kgFontSize(kgText) }}>
            <span className="kg-mirror" aria-hidden="true">
              {kgText || '0'}
            </span>
            <input id="kg" className="kg-input" inputMode="decimal" size={1} value={kgText} onChange={(ev) => touch(setKgText)(ev.target.value)} aria-describedby="kg-unit" />
          </span>
          <span id="kg-unit" style={{ fontSize: 44, fontWeight: 800, paddingBottom: 10 }}>
            kg
          </span>
        </div>
        <div className="steps">
          <button type="button" aria-label="0.5kg 減らす" onClick={() => step(-0.5)}>
            −
          </button>
          {QUICK.map((q) => (
            <button key={q} type="button" aria-pressed={kgValue === q} onClick={() => touch(setKgText)(String(q))}>
              {q}
            </button>
          ))}
          <button type="button" aria-label="0.5kg 増やす" onClick={() => step(0.5)}>
            ＋
          </button>
        </div>
        <div style={{ marginTop: 26, borderTop: '2.5px solid var(--ink)' }}>
          <div className="row">
            <label htmlFor="date" className="field-label">
              受取日
            </label>
            <input id="date" type="date" className="date-input mincho" value={date} max={props.today} onChange={(ev) => touch(setDate)(ev.target.value)} />
          </div>
          <div className="row">
            <label htmlFor="price" className="field-label">
              代金<span className="sub" style={{ fontWeight: 400, fontSize: 13, marginLeft: 6 }}>任意{unit !== null ? `・1kg ${unit}円` : ''}</span>
            </label>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
              <input id="price" className="price-input" inputMode="numeric" placeholder="—" value={priceText} onChange={(ev) => touch(setPriceText)(ev.target.value)} />
              <span style={{ fontWeight: 700 }}>円</span>
            </span>
          </div>
          <div className="row">
            <span className="field-label" id="paid-label">
              支払い
            </span>
            <div className="seg" role="radiogroup" aria-labelledby="paid-label">
              <button type="button" role="radio" aria-checked={!paid} className="unpaid" onClick={() => touch(setPaid)(false)}>
                まだ
              </button>
              <button type="button" role="radio" aria-checked={paid} onClick={() => touch(setPaid)(true)}>
                済み
              </button>
            </div>
          </div>
        </div>
        {errors.length > 0 && (
          <ul className="errors" role="alert">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        <div className="home-foot">
          {e && (
            <button type="button" className="textlink" style={{ color: 'var(--shu)' }} onClick={() => setConfirmDelete(true)}>
              この記録を削除
            </button>
          )}
          <button type="submit" className="primary" disabled={saving}>
            {saving ? '保存中…' : e ? '直す' : '記録する'}
          </button>
        </div>
      </form>
      {confirmDelete && e && (
        <div className="dialog screen" role="dialog" aria-modal="true" aria-labelledby="del-title">
          <div style={{ height: 44 }} />
          <h1 id="del-title" style={{ margin: '20px 0 0', fontSize: 30, fontWeight: 900 }}>
            この記録を削除しますか
          </h1>
          <p className="notice">
            {e.date}・{fmtKg(e.kg)} kg。削除しても GitHub の履歴には前の内容が残ります。
          </p>
          <div className="dialog-actions">
            <button type="button" className="primary" style={{ background: 'var(--shu)', color: '#fff' }} onClick={() => void remove()}>
              削除する
            </button>
            <button type="button" className="textlink" style={{ alignSelf: 'center' }} onClick={() => setConfirmDelete(false)}>
              やめる
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
