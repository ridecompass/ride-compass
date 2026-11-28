import { turnLabel } from "@/components/TurnArrow/TurnArrow";
import { translate } from "@/i18n/config";
import type { RouteTurn } from "@/types/route";

/** 曲がる所の手前で向きを読む所（m）。遠い順で、最後の所だけは道のりの代わりに「まもなく」と読む。 */
export const TURN_CALL_POINTS_M = [500, 200, 50] as const;
// 読む道のりの刻み。位置は1秒おきに数m進んで届くので、手前の所をまたいだ直後の道のりを、その所の切りのよい数で読む。
const SPOKEN_DISTANCE_STEP_M = 50;

/**
 * 次に曲がる所について読む段。0は手前の所のどれより遠い（次の曲がる所として知らせる）段で、1からは手前の所を
 * 遠い方からいくつ過ぎたか。近いほど大きい。
 */
export type TurnCallStage = number;

/** 次に曲がる所までの道のり（m）から、読む段を決める。 */
export function turnCallStage(distanceM: number): TurnCallStage {
  return TURN_CALL_POINTS_M.filter((pointM) => distanceM <= pointM).length;
}

function spokenDistance(distanceM: number): string {
  const roundedM = Math.round(distanceM / SPOKEN_DISTANCE_STEP_M) * SPOKEN_DISTANCE_STEP_M;
  if (roundedM < 1000) return translate("ride.voice.meters", { meters: String(roundedM) });
  return translate("ride.voice.kilometers", { km: String(Number((distanceM / 1000).toFixed(1))) });
}

/** 読む段の言葉。道のりは刻みへ丸め、1km からはキロで小数1桁まで読む。 */
export function turnCallText(stage: TurnCallStage, direction: RouteTurn["direction"], distanceM: number): string {
  const label = turnLabel(direction);
  if (stage === TURN_CALL_POINTS_M.length) return translate("ride.voice.callNear", { label });
  if (stage === 0) return translate("ride.voice.callFirst", { distance: spokenDistance(distanceM), label });
  return translate("ride.voice.call", { distance: spokenDistance(distanceM), label });
}
