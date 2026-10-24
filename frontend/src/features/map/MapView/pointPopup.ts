// 地点のピンを押したときの小窓の本文。
import { pinMarkName } from "@/components/PinMark/PinMark";
import type { PointTarget } from "@/types/route";

/** 地点のピンの名前（見るだけの間にピンを押すと、小窓に呼び名と並べて出す）。 */
export interface PinNames {
  origin: string;
  waypoints: readonly string[];
  destination: string;
}

/** 地点のピンを押したときの小窓の本文:「<ピンの呼び名>: <名前>」。 */
export function pinPopupText(target: PointTarget, pinNames: PinNames): string {
  const index = target.role === "waypoint" ? (target.index ?? 0) : 0;
  const name =
    target.role === "origin"
      ? pinNames.origin
      : target.role === "destination"
        ? pinNames.destination
        : pinNames.waypoints[index];
  return `${pinMarkName(target.role, target.role === "waypoint" ? String(index + 1) : undefined)}: ${name}`;
}
