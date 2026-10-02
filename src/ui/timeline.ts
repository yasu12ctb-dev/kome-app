// 買う間隔の線の上に置く数字の位置。前の数字と重なるもの・はみ出すものは置かない（すべての間隔は下の一覧に出す）

export interface GapLabel {
  /** 線の中での中心（%） */
  center: number;
  show: boolean;
}

/** 画面幅 320px を 100% とした、数字 1 つの概算の半幅（%） */
export function labelHalfWidth(days: number): number {
  return (String(days).length * 9 + 6) / 2 / 3.2;
}

export function placeGapLabels(days: readonly number[]): GapLabel[] {
  const span = days.reduce((s, d) => s + d, 0);
  if (span <= 0) return days.map(() => ({ center: 0, show: false }));
  let acc = 0;
  let lastRight = -Infinity;
  return days.map((d) => {
    const center = ((acc + d / 2) / span) * 100;
    acc += d;
    const half = labelHalfWidth(d);
    const show = center - half >= lastRight && center + half <= 100 + half && (d / span) * 100 >= half;
    if (show) lastRight = center + half;
    return { center, show };
  });
}

/** ホームの未払いの帯に出す文字（0 円は「0 円」、金額のないものは件数を分けて出す） */
export function unpaidText(due: { count: number; totalYen: number; countWithoutPrice: number }, yen: (n: number) => string) {
  const allMissing = due.countWithoutPrice === due.count;
  return {
    amount: allMissing ? '金額未入力' : yen(due.totalYen),
    extra: due.countWithoutPrice > 0 && !allMissing ? `ほか金額未入力 ${due.countWithoutPrice}件` : null,
    aria: `未払い ${due.count}件 ${allMissing ? '金額未入力' : yen(due.totalYen)}${due.countWithoutPrice > 0 && !allMissing ? `（ほか金額未入力 ${due.countWithoutPrice}件）` : ''}`,
  };
}
