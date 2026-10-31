// ルートを通る時刻に当たる、警報級の時系列の種別ごとの注意報級の時間帯。段は気象庁の3時間のコマのまま使い、コマの境を通る時刻で切り詰めない
// （気象庁が出していない時間帯を出さない）。

import type { components } from "@/types/generated/api";
import type { WarningBadgeItem } from "@/features/conditions/WarningBadge/WarningBadge";
import { formatJstDateTime, formatJstHourMinute, isSameJstDay } from "@/lib/time";

type RouteWarningTimeline = components["schemas"]["RouteWarningTimeline"];

/**
 * 時系列`timeline`の区域の通過のうち、通る間に注意報級のコマを、種別ごとに続くコマをつないだ時間帯にしてバッジの項目で返す。
 * `pointKms`は要求に送った点のルートの上の距離（通過の点の番号で引く）、`clock`はルートの上の距離を通る時刻（ms）。
 * `fromKm`より手前（もう走った所）は見ない。
 */
export function routeWarningTimelineItems(
  timeline: RouteWarningTimeline,
  pointKms: readonly number[],
  clock: (km: number) => number,
  fromKm: number,
): WarningBadgeItem[] {
  const items = new Map<string, WarningBadgeItem>();
  for (const area of timeline.areas) {
    const endKm = pointKms[area.end_index];
    if (endKm < fromKm) continue;
    const passStart = clock(Math.max(fromKm, pointKms[area.start_index]));
    const passEnd = clock(endKm);
    for (const [kind, levels] of Object.entries(area.kinds)) {
      const windows: { start: number; end: number }[] = [];
      for (const slot of levels.slots) {
        const start = Date.parse(slot.start);
        const end = Date.parse(slot.end);
        if (!slot.advisory || start > passEnd || end <= passStart) continue;
        const previous = windows.at(-1);
        if (previous !== undefined && previous.end === start) previous.end = end;
        else windows.push({ start, end });
      }
      for (const { start, end } of windows) {
        // 区域を離れてまた通っても、同じ時間帯は1件にする。
        const id = `route-${kind}-${area.area_code}-${start}`;
        items.set(id, {
          id,
          label: `${levels.advisory_label}${area.area_name}`,
          level: "advisory",
          source: "jma",
          title: [
            `${timeRange(start, end)}に通る見込み`,
            ...(levels.additions.length > 0 ? [`付加事項: ${levels.additions.join("・")}`] : []),
          ].join("。"),
        });
      }
    }
  }
  return [...items.values()];
}

/** 「10/21 21:00〜10/22 00:00」。同じ日に終わるなら終わりは時刻だけ。 */
function timeRange(startMs: number, endMs: number): string {
  const start = new Date(startMs);
  const end = new Date(endMs);
  return `${formatJstDateTime(start)}〜${isSameJstDay(start, end) ? formatJstHourMinute(end) : formatJstDateTime(end)}`;
}
