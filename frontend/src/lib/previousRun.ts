import { parseJstLocalValue } from "@/lib/time";

/** 予報の時刻`time`の値が、最新のrunの予報の終わり`latestRunEnd`（backendが日本時間をオフセット無しで返す時刻。この時刻を
 * 含まない）から先の、配信が止まっている間に前に出たrunの値か。 */
export function isPreviousRunTime(time: Date, latestRunEnd: string): boolean {
  return time.getTime() >= parseJstLocalValue(latestRunEnd).getTime();
}

/** 前に出た予報の値を見せている所に添える但し書き。`what`はその所が見せている値（「この時刻の風」等）。 */
export function previousRunNotice(what: string): string {
  return `予報の新しい配信が止まっているため、${what}は前に出た予報の値です。外れやすくなっています。`;
}
