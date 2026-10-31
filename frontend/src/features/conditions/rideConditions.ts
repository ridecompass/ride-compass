/** 走行条件（出発時刻）の整形と丸め。 */
import { MINUTE_MS } from "@/lib/duration";
import { formatJstMinute, isSameJstDay, jstParts } from "@/lib/time";

/** 出発時刻として選べる値の刻み。「今」もこの刻みで進む。 */
export const DEPARTURE_STEP_MS = 5 * MINUTE_MS;

/** 時刻（ms）を出発時刻の刻みへ切り下げる。 */
export function floorToDepartureStep(ms: number): number {
  return Math.floor(ms / DEPARTURE_STEP_MS) * DEPARTURE_STEP_MS;
}

/** 出発時刻の表示ラベルを、日付と時刻に分けたもの。`now`と同じ日（日本時間）は`["9:30"]`、別日は`["9/6", "9:30"]`。
 * 時は0埋めしない——札は地図右上のアイコン列の幅に収める。 */
export function departureLabelParts(time: Date, now: Date): string[] {
  const { month, day, hour } = jstParts(time);
  const hm = `${hour}:${formatJstMinute(time)}`;
  return isSameJstDay(time, now) ? [hm] : [`${month}/${day}`, hm];
}
