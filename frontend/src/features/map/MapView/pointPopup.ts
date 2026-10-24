// 地点のピンを押したときの小窓の本文。
import { pinMarkName } from "@/components/PinMark/PinMark";
import type { PointTarget } from "@/types/route";

/** 地点のピンの地点の名前（見るだけの間にピンを押すと、小窓に呼び名と並べて出す）。名前の無い地点はnull。 */
export interface PinNames {
  origin: string | null;
  waypoints: readonly (string | null)[];
  destination: string | null;
}

/** 地点のピンを押したときの小窓の本文:「<ピンの呼び名>: <名前>」。地点の名前が無ければnull（呼び名だけなら小窓を開かない）。 */
export function pinPopupText(target: PointTarget, pinNames: PinNames): string | null {
  const index = target.role === "waypoint" ? (target.index ?? 0) : 0;
  const name =
    target.role === "origin"
      ? pinNames.origin
      : target.role === "destination"
        ? pinNames.destination
        : (pinNames.waypoints[index] ?? null);
  if (name === null) return null;
  return `${pinMarkName(target.role, target.role === "waypoint" ? String(index + 1) : undefined)}: ${name}`;
}
