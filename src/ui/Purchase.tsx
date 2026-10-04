import { useState } from 'react';
import type { PurchaseResult } from '../data/repo';
import type { Purchase, Receipt, Ymd } from '../data/types';
import { remaining } from '../domain/stats';
import { kg, monthDay } from './format';

// 購入の記録と残り（設計書 §10）。購入の記録は端末の中だけに置き、バックアップには含めない

/** ホームの「これまで」の下に出す残り。購入の記録が無ければ設定への案内 */
export function RemainingLine(props: { receipts: readonly Receipt[]; purchase: Purchase | null }) {
  const { purchase } = props;
  if (purchase === null) {
    return (
      <a href="#settings" className="remain-hint">
        購入した量を記録すると、残りが出ます
      </a>
    );
  }
  const { remainingKg } = remaining(props.receipts, purchase);
  const label = `${monthDay(purchase.date)}に${kg(purchase.kg)}kg購入`;
  if (remainingKg < 0) {
    return (
      <span className="remain" aria-label={`${label}。購入より ${kg(-remainingKg)}kg 多く受け取っています`}>
        購入より <b className="num">{kg(-remainingKg)}</b>kg 多く受け取り
      </span>
    );
  }
  return (
    <span className="remain" aria-label={`残り ${kg(remainingKg)}kg（${label}）`}>
      残り <b className="num">{kg(remainingKg)}</b>kg
    </span>
  );
}

/** 設定画面の「購入した量」 */
export function PurchaseSection(props: {
  purchase: Purchase | null;
  today: Ymd;
  onSave: (input: { kg: number; date: string }) => Promise<PurchaseResult>;
  onClear: () => Promise<PurchaseResult>;
}) {
  const p = props.purchase;
  // 状態は設計書 §10「設定の購入欄の状態」: 比べる相手は常に今の記録（latest）。持つのは下書きと待機だけ
  const latestForm = { kg: p ? kg(p.kg) : '', date: p?.date ?? props.today };
  const latestKey = p?.updatedAt ?? 'none';
  const [draft, setDraft] = useState<{ kg: string; date: string; from: string } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const sameAsLatest = (v: { kg: string; date: string }) => v.kg === latestForm.kg && v.date === latestForm.date;
  // 下書きの終わり: 最新と同じになった下書きは捨てる（入力でも、ほかの画面の変更でも）。
  // 描画中に確かめ、次の描画では下書きが無いので繰り返さない
  const live = draft !== null && !sameAsLatest(draft) ? draft : null;
  if (draft !== null && live === null) setDraft(null);
  // 未保存（自動アップデートの再読み込みを待たせる。I11）・表示する値・お知らせはすべて計算で決める
  const dirty = live !== null;
  const shown = live ?? latestForm;
  const changedElsewhere = live !== null && live.from !== latestKey;

  function edit(field: 'kg' | 'date', value: string) {
    if (busy) return;
    const next = { ...shown, [field]: value, from: live ? live.from : latestKey };
    setDraft(sameAsLatest(next) ? null : next);
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setErrors([]);
    setSaved(false);
    const text = shown.kg.trim().replace(/[,，]/g, '');
    const r = await props.onSave({ kg: text === '' ? Number.NaN : Number(text), date: shown.date });
    setBusy(false);
    if (r.ok) {
      // 自分の読み直しで、最新は保存した値になっている
      setDraft(null);
      setSaved(true);
    } else if (r.kind === 'invalid') setErrors(r.errors.map((e) => e.message));
    else setErrors(['保存できませんでした。もう一度お試しください']);
  }

  async function clear() {
    setBusy(true);
    setErrors([]);
    setSaved(false);
    const r = await props.onClear();
    setBusy(false);
    if (r.ok) setDraft(null);
    else setErrors(['消せませんでした。もう一度お試しください']);
  }

  return (
    <section data-dirty={dirty ? 'true' : 'false'}>
      <h2 className="section-h">購入した量</h2>
      <p className="sub" style={{ fontSize: 13, margin: '4px 0 0', lineHeight: 1.6 }}>
        ホームに、まだ受け取っていない量（購入した量 − 購入日から受け取った量）が出ます。新しく購入したら書き換えてください。この端末の中だけに保存します（バックアップには入りません）。
      </p>
      <div className="row">
        <label htmlFor="purchase-kg">量</label>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
          <input
            id="purchase-kg"
            className="price-input"
            inputMode="decimal"
            placeholder="240"
            disabled={busy}
            value={shown.kg}
            onChange={(ev) => edit('kg', ev.target.value)}
          />
          <span style={{ fontWeight: 700 }}>kg</span>
        </span>
      </div>
      <div className="row">
        <label htmlFor="purchase-date">購入日</label>
        <input
          id="purchase-date"
          type="date"
          className="date-input mincho"
          value={shown.date}
          disabled={busy}
          max={props.today}
          onChange={(ev) => edit('date', ev.target.value)}
        />
      </div>
      {errors.length > 0 && (
        <ul className="errors" role="alert">
          {errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {changedElsewhere && (
        <p className="errors" role="status">
          ほかの画面で購入の記録が変わりました（今は {p ? `${kg(p.kg)}kg・${monthDay(p.date)}` : '記録なし'}）。保存すると、この入力で書き換えます。{' '}
          <button type="button" className="textlink" style={{ fontSize: 14, minHeight: 32 }} disabled={busy} onClick={() => setDraft(null)}>
            今の記録に戻す
          </button>
        </p>
      )}
      {saved && !dirty && (
        <p className="sub" role="status" style={{ fontSize: 14 }}>
          保存しました
        </p>
      )}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 12 }}>
        <button type="button" className="secondary" style={{ flex: 1 }} disabled={busy || !dirty} onClick={() => void save()}>
          保存
        </button>
        {p && (
          <button type="button" className="textlink" style={{ color: 'var(--shu)', flex: 'none', whiteSpace: 'nowrap' }} disabled={busy} onClick={() => void clear()}>
            消す
          </button>
        )}
      </div>
    </section>
  );
}
