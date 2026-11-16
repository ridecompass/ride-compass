import { formatJstHourMinute, toJstLocalValue } from "@/lib/time";

import type { RideMetricsLog } from "@/lib/rideMetrics";

/** 区切りの文字（`,`・`;`・`=`・改行）を空白に替える。 */
const plain = (text: string) => text.replace(/[,;=\r\n]/g, " ");

/** 1つの欄。無い値は `-`、真偽は 1・0、数の表は多い順に `名前=数` を `;` でつなぐ。 */
function cell(column: string, value: unknown): string {
  if (column === "at" && typeof value === "string") return formatJstHourMinute(new Date(value));
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (Array.isArray(value))
    return (value as { source: string; ms: number }[]).map(({ source, ms }) => `${plain(source)}=${ms}`).join(";");
  if (typeof value === "object")
    return Object.entries(value as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${plain(name)}=${count}`)
      .join(";");
  return plain(String(value));
}

/** 写す形。1行目に始まりと端末、2行目に列の名前（行の項目の名前と順）、続けて1分1行の CSV（時刻は日本時間）。
 * 項目を名前つきで行ごとに繰り返さないので、長い走行でも貼れる長さに収まる。 */
export function formatRideMetrics(log: RideMetricsLog): string {
  const { device } = log;
  // 前の版の記録には無い項目もあるので、どれかの行にある項目を、初めて出た順に並べる。
  const columns = [...new Set(log.rows.flatMap((row) => Object.keys(row)))];
  const head = `# 走行の記録 ${toJstLocalValue(new Date(log.startedAt))} JST ${device.screen} x${device.pixelRatio} ${plain(device.userAgent)}`;
  const lines = log.rows.map((row) =>
    columns.map((column) => cell(column, (row as Record<string, unknown>)[column])).join(","),
  );
  return [head, columns.join(","), ...lines].join("\n");
}
