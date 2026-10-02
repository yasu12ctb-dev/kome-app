// 端末の日付が変わるまでの時間（開いたまま 0 時をまたいだときに「今日」を更新するため）

/** 次の日の 0 時 0 分 5 秒（端末の時刻帯）までのミリ秒 */
export function msUntilNextLocalDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  return next.getTime() - now.getTime();
}
