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
  const [kgText, setKgText] = useState(p ? kg(p.kg) : '');
  const [date, setDate] = useState<string>(p?.date ?? props.today);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // 保存した値と違えば未保存（自動アップデートの再読み込みを待たせる。I11）
  const dirty = kgText !== (p ? kg(p.kg) : '') || date !== (p?.date ?? props.today);

  async function save() {
    setBusy(true);
    setErrors([]);
    setSaved(false);
    const text = kgText.trim().replace(/[,，]/g, '');
    const r = await props.onSave({ kg: text === '' ? Number.NaN : Number(text), date });
    setBusy(false);
    if (r.ok) {
      if (r.purchase) {
        setKgText(kg(r.purchase.kg));
        setDate(r.purchase.date);
      }
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
    if (r.ok) {
      setKgText('');
      setDate(props.today);
    } else setErrors(['消せませんでした。もう一度お試しください']);
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
            value={kgText}
            onChange={(ev) => {
              setKgText(ev.target.value);
              setSaved(false);
            }}
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
          value={date}
          max={props.today}
          onChange={(ev) => {
            setDate(ev.target.value);
            setSaved(false);
          }}
        />
      </div>
      {errors.length > 0 && (
        <ul className="errors" role="alert">
          {errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
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
