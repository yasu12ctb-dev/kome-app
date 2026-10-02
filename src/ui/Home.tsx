import { daysBetween } from '../data/date';
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { Lineage, Receipt, Ymd } from '../data/types';
import { displayStatus } from '../backup/lineage';
import { lastReceiptDate, predictNext, totalKg, unpaid, type Prediction } from '../domain/stats';
import { kg, monthDay, monthDayWeek, yen } from './format';
import { fitFontSize } from './fit';
import { Bag, BagOutline } from './icons';

const STATUS_TEXT = { unset: 'バックアップ未設定', saved: '保存済み', pending: '保存待ち', error: '保存が止まっています' } as const;

function stopMessage(l: Lineage): { text: string; action: string } | null {
  switch (l.errorKind) {
    case 'auth':
      return { text: 'バックアップが止まっています', action: '鍵を設定し直す' };
    case 'config':
      return { text: 'バックアップの保存先が見つかりません', action: '設定を確かめる' };
    case 'conflict':
      return { text: 'GitHub 側のデータと食い違っています', action: 'どちらを残すか選ぶ' };
    case 'invalid':
      return { text: 'バックアップを保存できませんでした', action: '設定を確かめる' };
    default:
      return null;
  }
}

function stateClass(p: Prediction): string {
  if (p.kind !== 'ok') return '';
  if (p.state === 'overdue') return 'state-over';
  if (p.state === 'soon' || p.state === 'today') return 'state-soon';
  return '';
}

/** 大きく過ぎていたら、記録し忘れの可能性を添える日数 */
const FORGOT_HINT_DAYS = 14;

/** 画面上端（時刻の帯）の色を、画面の地の色に合わせる（theme-color） */
function useThemeColorFrom(ref: RefObject<HTMLElement | null>, key: string) {
  useLayoutEffect(() => {
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const before = metas.map((m) => m.content);
    const el = ref.current;
    if (el) {
      const color = getComputedStyle(el).backgroundColor;
      for (const m of metas) m.content = color;
    }
    return () => metas.forEach((m, i) => (m.content = before[i]!));
  }, [ref, key]);
}

export function Home(props: { receipts: Receipt[]; lineage: Lineage; dataRevision: number; today: Ymd; standalone: boolean; onConflict: () => void }) {
  const { receipts, lineage, today } = props;
  const mainRef = useRef<HTMLElement | null>(null);
  const themeKey = receipts.length === 0 ? 'empty' : stateClass(predictNext(receipts, today));
  useThemeColorFrom(mainRef, themeKey);
  const status = displayStatus(lineage, props.dataRevision);
  const stop = stopMessage(lineage);
  const chip = (
    <a href="#settings" className={`status-chip ${status}`}>
      <span className="dot" aria-hidden="true" />
      {lineage.errorKind === 'network' || lineage.errorKind === 'rate-limit' ? '保存待ち（通信できません）' : STATUS_TEXT[status]}
    </a>
  );
  const banner = stop ? (
    <div className="banner" role="status">
      <span>{stop.text}</span>
      {lineage.errorKind === 'conflict' ? (
        <button type="button" className="textlink" onClick={props.onConflict}>
          {stop.action}
        </button>
      ) : (
        <a href="#settings" className="textlink">
          {stop.action}
        </a>
      )}
    </div>
  ) : null;
  const installHint = !props.standalone ? (
    <p className="sub" style={{ fontSize: 13, margin: '8px 0 0' }}>
      Safari の共有メニューから「ホーム画面に追加」して使ってください（Safari のままだと記録が消えることがあります）。
    </p>
  ) : null;

  if (receipts.length === 0) {
    return (
      <main className="screen" ref={mainRef}>
        {banner}
        <div className="topbar">
          <span className="label">お米の記録</span>
          {chip}
        </div>
        {installHint}
        <div className="empty-figure">
          <img src={`${import.meta.env.BASE_URL}icons/icon-512.png`} alt="" />
        </div>
        <h1 style={{ margin: '24px 0 0', fontSize: 30, fontWeight: 900, lineHeight: 1.3 }}>
          最初の一袋を
          <br />
          記録しましょう
        </h1>
        <p className="sub" style={{ margin: '12px 0 0', fontSize: 15, lineHeight: 1.7 }}>
          2回記録すると、次に頼む目安の日が出ます。
        </p>
        <a href="#settings" className="textlink" style={{ fontSize: 15 }}>
          機種変更した方は、バックアップから復元
        </a>
        <div className="home-foot">
          <a href="#add" className="primary">
            <BagOutline />
            お米を受け取った
          </a>
        </div>
      </main>
    );
  }

  const p = predictNext(receipts, today);
  const last = lastReceiptDate(receipts)!;
  const elapsed = daysBetween(last, today);
  const total = totalKg(receipts);
  const due = unpaid(receipts);
  const bagCount = receipts.length;

  let lead: string;
  let big: ReactNode;
  let when: ReactNode;
  let track: ReactNode;
  if (p.kind !== 'ok') {
    lead = 'あと';
    big = (
      <span className="num n" style={{ color: 'var(--line)' }} aria-label="未定">
        —
      </span>
    );
    when = <div style={{ marginTop: 18, fontSize: 22, fontWeight: 800, lineHeight: 1.5 }}>あと{p.datesNeeded}回記録すると、目安の日が出ます</div>;
    track = (
      <div className="track">
        <div className="dotted" />
      </div>
    );
  } else {
    const total = Math.max(1, daysBetween(last, p.nextDate));
    const ratio = Math.min(1, Math.max(0, elapsed / total));
    if (p.state === 'today') {
      lead = '今日が目安';
      big = <span className="word">今日</span>;
      when = <div className="when mincho">{monthDayWeek(p.nextDate)}　注文の目安</div>;
    } else if (p.state === 'overdue') {
      const over = String(-p.daysUntil);
      lead = '目安から';
      big = (
        <>
          <span className="num n" style={{ fontSize: fitFontSize(over, 250, 32 + 150) }}>
            {over}
          </span>
          <span className="unit" style={{ fontSize: 40 }}>
            日過ぎ
          </span>
        </>
      );
      when = (
        <>
          <div className="when mincho">目安は{monthDayWeek(p.nextDate)}でした</div>
          {-p.daysUntil >= FORGOT_HINT_DAYS && (
            <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.6, color: 'var(--sub)' }}>
              受け取ったのに記録していなければ、下の「お米を受け取った」から記録してください。
            </p>
          )}
        </>
      );
    } else {
      lead = p.state === 'soon' ? 'もうすぐ' : 'あと';
      const days = String(p.daysUntil);
      big = (
        <>
          <span className="num n" style={{ fontSize: fitFontSize(days, 250, 32 + 70) }}>
            {days}
          </span>
          <span className="unit">日</span>
        </>
      );
      when = <div className="when mincho">{monthDayWeek(p.nextDate)}ごろ注文</div>;
    }
    track = (
      <div className="track" aria-hidden="true">
        <div className="rail" />
        <div className="done" style={{ width: `${ratio * 100}%` }} />
        <div className="tick" style={{ left: `${ratio * 100}%` }} />
        {p.state !== 'overdue' && <div className="goal" />}
      </div>
    );
  }

  return (
    <main className={`screen poster ${stateClass(p)}`} ref={mainRef}>
      {banner}
      <div className="topbar">
        <span className="label">次の目安まで</span>
        {chip}
      </div>
      {installHint}
      <div className="lead">{lead}</div>
      <div className="big">{big}</div>
      {when}
      {track}
      <div className="track-label">
        <strong>
          前回 {monthDay(last)}から {elapsed}日
        </strong>
        {p.kind === 'ok' && <span className="sub">約{Math.round(p.avgIntervalDays)}日おき</span>}
      </div>
      <div className="stats-row">
        <div className="total">
          <span className="sub" style={{ fontSize: 13 }}>
            これまで
          </span>
          <span className="num value">
            {kg(total)}
            <small>kg</small>
          </span>
          <span className="bags" aria-label={`${bagCount}回`}>
            {Array.from({ length: Math.min(bagCount, 10) }, (_, i) => (
              <Bag key={i} />
            ))}
            {bagCount > 10 && <span className="more">×{bagCount}</span>}
          </span>
        </div>
        {due.count > 0 && (
          <a href="#records?unpaid" className="tag" aria-label={`未払い ${due.count}件 ${yen(due.totalYen)}`}>
            <span className="t1">未払い {due.count}件</span>
            <span className="t2 num">{due.totalYen > 0 ? yen(due.totalYen) : '金額なし'}</span>
          </a>
        )}
      </div>
      <div className="home-foot">
        <nav className="links" aria-label="メイン">
          <a href="#records">一覧</a>
          <a href="#stats">集計</a>
          <a href="#settings">設定</a>
        </nav>
        <a href="#add" className="primary">
          <BagOutline />
          お米を受け取った
        </a>
      </div>
    </main>
  );
}
