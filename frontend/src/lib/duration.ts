// 時間の長さの単位と、画面での書き方。所要時間・待ち時間・保持時間を、どの画面でも同じ「N分」の形で書く。

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;

/** 分の単位の書き方。 */
export const MINUTE_UNIT = "分";

/** 秒を分へ（丸めない）。 */
export function secondsToMinutes(seconds: number): number {
  return (seconds * SECOND_MS) / MINUTE_MS;
}

/** 秒を、分へ丸めて「38分」の形にする。 */
export function formatMinutes(seconds: number): string {
  return `${Math.round(secondsToMinutes(seconds))}${MINUTE_UNIT}`;
}

/** 秒を「102分」「38分」の形にする（1時間を超えても分で書く）。1分未満は「1分未満」。 */
export function formatDurationShort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (Math.round(secondsToMinutes(seconds)) < 1) return `1${MINUTE_UNIT}未満`;
  return formatMinutes(seconds);
}
