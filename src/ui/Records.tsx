import type { Receipt } from '../data/types';
import { totalKg, unitPriceYen } from '../domain/stats';
import { dotDate, kg, weekday, yen } from './format';

// 一覧（帳簿の罫線組み）。?unpaid で未払いだけに絞る

export function Records(props: { receipts: Receipt[]; onlyUnpaid: boolean }) {
  const list = props.onlyUnpaid ? props.receipts.filter((r) => !r.paid) : props.receipts;
  const byYear = new Map<string, Receipt[]>();
  for (const r of [...list].reverse()) {
    const y = r.date.slice(0, 4);
    byYear.set(y, [...(byYear.get(y) ?? []), r]);
  }
  return (
    <main className="screen">
      <a href="#" className="back">
        ← ホーム
      </a>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 className="title">{props.onlyUnpaid ? '未払い' : '一覧'}</h1>
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          {list.length}回・{kg(totalKg(list))} kg
        </span>
      </div>
      {props.onlyUnpaid && (
        <a href="#records" className="textlink" style={{ fontSize: 15 }}>
          すべて表示
        </a>
      )}
      {list.length === 0 && <p className="sub">記録はまだありません。</p>}
      {[...byYear.entries()].map(([year, rs]) => (
        <section key={year}>
          <h2 className="section-h">
            <span className="num" style={{ fontSize: 22 }}>
              {year}
            </span>
            <span className="sub" style={{ fontSize: 12, fontWeight: 400 }}>
              {rs.length}回・{kg(totalKg(rs))} kg・{yen(rs.reduce((s, r) => s + (r.priceYen ?? 0), 0))}
            </span>
          </h2>
          <ul className="ledger">
            {rs.map((r) => {
              const unit = unitPriceYen(r);
              return (
                <li key={r.id}>
                  <a href={`#edit/${r.id}`} aria-label={`${r.date} ${kg(r.kg)}kg を直す`}>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                      <span className="num md">{dotDate(r.date)}</span>
                      <span className="sub" style={{ fontSize: 12 }}>
                        {weekday(r.date)}
                      </span>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: 16, fontWeight: 800 }}>{kg(r.kg)} kg</span>
                      <span className="sub" style={{ fontSize: 12 }}>
                        {r.priceYen !== null ? `${yen(r.priceYen)}・${unit}円/kg` : '代金なし'}
                      </span>
                    </span>
                    {r.paid ? (
                      <span className="sub" style={{ fontSize: 13, fontWeight: 700 }}>
                        済み
                      </span>
                    ) : (
                      <span className="unpaid-tag">未払い</span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </main>
  );
}
