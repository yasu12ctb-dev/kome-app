// 米袋のシルエット（UI の記号。アプリアイコンとは別）

const BAG = 'M4 1h6l-1 3c3 1 5 4 5 8v5H0v-5c0-4 2-7 5-8z';

export function Bag() {
  return (
    <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true">
      <path d={BAG} fill="currentColor" />
    </svg>
  );
}

export function BagOutline() {
  return (
    <svg width="20" height="26" viewBox="0 0 14 18" aria-hidden="true">
      <path d={BAG} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
