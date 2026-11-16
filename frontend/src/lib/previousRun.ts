import { formatJstDateTime, parseJstLocalValue } from "@/lib/time";

/** 予報の時刻`time`の値が、最新のrunの予報の終わり`latestRunEnd`（backendが日本時間をオフセット無しで返す時刻。この時刻を
 * 含まない）から先の、前に出たrunの値か。 */
export function isPreviousRunTime(time: Date, latestRunEnd: string): boolean {
  return time.getTime() >= parseJstLocalValue(latestRunEnd).getTime();
}

/** 最新のrunの予報の終わり`latestRunEnd`から先の、前に出た予報の値を見せている所に添える但し書き。`what`はその所が
 * 見せている値（「風」等）で、無ければその所の値の全部を指す。原因を書かないのは、配信が止まっていなくても、最新のrunの
 * 届く先より後の時刻を見せればこの但し書きが要るため。 */
export function previousRunNotice(latestRunEnd: string, what?: string): string {
  const from = formatJstDateTime(parseJstLocalValue(latestRunEnd));
  return `${from}から先${what === undefined ? "" : `の${what}`}は、前の予報の値です。`;
}

/** backendが応答に載せる、前に出た予報の風を引いた素性（`wind_previous_run_from`。引いていなければnull）に添える但し書き。 */
export function windPreviousRunNotice(windPreviousRunFrom: string | null | undefined): string | null {
  return windPreviousRunFrom == null ? null : previousRunNotice(windPreviousRunFrom, "風");
}
