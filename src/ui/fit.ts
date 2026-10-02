// 大きな数字を、文字数に応じて画面の幅に収まる大きさにする（縦画面専用。総点検 tools/layout-audit.js で確認）
// 太い数字（SF の 900）の 1 字の幅を 0.62em と見積もる（字間 −0.05em を含めても収まる側の見積もり）

const EM_PER_CHAR = 0.62;

/** reservePx: 画面の左右の余白と、数字の横に並ぶ単位などの幅（px） */
export function fitFontSize(text: string, maxPx: number, reservePx: number): string {
  const n = Math.max(1, [...text].length);
  return `min(${maxPx}px, calc((100vw - ${reservePx}px) / ${(n * EM_PER_CHAR).toFixed(2)}))`;
}
