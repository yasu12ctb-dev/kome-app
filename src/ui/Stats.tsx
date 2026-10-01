import { useState } from 'react';
import type { Receipt } from '../data/types';
import { byYear, intervals, monthlyKg, predictNext } from '../domain/stats';
import { kg, yen } from './format';

// 集計（年の合計・月ごとの量・買う間隔）

export function Stats(props: { receipts: Receipt[]; today: string }) {
  const years = byYear(props.receipts);
  const [year, setYear] = useState<number>(years[0]?.year ?? Number(props.today.slice(0, 4)));
  const current = years.find((y) => y.year === year);
  const months = monthlyKg(props.receipts, year);
  const maxMonth = Math.max(30, ...months);
  const gaps = intervals(props.receipts).slice(-8);
  const p = predictNext(props.receipts, props.today);
  const first = gaps[0]?.from;
  const span = gaps.length > 0 ? gaps.reduce((s, g) => s + g.days, 0) : 0;
  let acc = 0;

  return (
    <main className="screen">
      <a href="#" className="back">
        ← ホーム
      </a>
      {props.receipts.length === 0 ? (
        <>
          <h1 className="title">集計</h1>
          <p className="sub">記録がたまると、年ごとの量や買う間隔がここに出ます。</p>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4 }}>
            <span className="num" style={{ fontSize: 96, lineHeight: 0.9, letterSpacing: '-0.04em' }}>
              {kg(current?.kg ?? 0)}
            </span>
            <span style={{ fontSize: 24, fontWeight: 800 }}>kg</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700 }}>
            {year}年　{current?.count ?? 0}回・{yen(current?.yen ?? 0)}
          </div>
          {years.length > 1 && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
              {years.map((y) => (
                <button key={y.year} type="button" className="textlink" style={{ fontSize: 14, fontWeight: y.year === year ? 900 : 500 }} aria-pressed={y.year === year} onClick={() => setYear(y.year)}>
                  {y.year}年 {kg(y.kg)}kg
                </button>
              ))}
            </div>
          )}
          <h2 className="section-h">
            月ごとの量<span className="sub" style={{ fontWeight: 400, fontSize: 12 }}>{year}年・kg</span>
          </h2>
          <div className="bars" style={{ marginTop: 10 }} role="img" aria-label={`${year}年の月ごとの量: ${months.map((m, i) => `${i + 1}月 ${kg(m)}kg`).join('、')}`}>
            {months.map((m, i) => (
              <div key={i} className={m === 0 ? 'zero' : ''} style={m === 0 ? undefined : { height: `${Math.max(6, (m / maxMonth) * 100)}%` }} />
            ))}
          </div>
          <div className="bar-labels sub" aria-hidden="true">
            {months.map((_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </div>
          <h2 className="section-h">
            買う間隔
            {p.kind === 'ok' && <span className="sub" style={{ fontWeight: 400, fontSize: 12 }}>直近の平均 約{Math.round(p.avgIntervalDays)}日</span>}
          </h2>
          {gaps.length === 0 ? (
            <p className="sub">2回以上記録すると、間隔が出ます。</p>
          ) : (
            <>
              <div className="timeline" style={{ marginTop: 10 }} role="img" aria-label={`買う間隔: ${gaps.map((g) => `${g.days}日`).join('、')}`}>
                <div className="rail" />
                <div className="tick" style={{ left: '0%' }} />
                {gaps.map((g) => {
                  const start = acc;
                  acc += g.days;
                  return (
                    <span key={g.to}>
                      <div className="tick" style={{ left: `${(acc / span) * 100}%` }} />
                      <span className="gap num" style={{ left: `${((start + g.days / 2) / span) * 100}%`, color: g.days < 30 ? 'var(--shu)' : undefined }}>
                        {g.days}
                      </span>
                    </span>
                  );
                })}
              </div>
              <div className="sub" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span>{first?.replaceAll('-', '.')}</span>
                <span>{gaps.at(-1)?.to.replaceAll('-', '.')}</span>
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}
