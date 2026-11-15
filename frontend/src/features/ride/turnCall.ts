import { turnLabel } from "@/components/TurnArrow/TurnArrow";
import type { RouteTurn } from "@/types/route";

/** 曲がる所の手前で、道のりを添えて向きを読む所（m）。 */
export const TURN_CALL_AHEAD_M = 300;
/** 曲がる所の手前で、「まもなく」と向きを読む所（m）。 */
export const TURN_CALL_SOON_M = 50;
// 読む道のりの刻み。位置は1秒おきに数m進んで届くので、手前の所をまたいだ直後の道のりを、その所の切りのよい数で読む。
const SPOKEN_DISTANCE_STEP_M = 50;

/** 曲がる所の手前で読む段。 */
export type TurnCallStage = "ahead" | "soon";

/** 次に曲がる所までの道のり（m）から、読む段を決める。まだ遠ければnull。 */
export function turnCallStage(distanceM: number): TurnCallStage | null {
  if (distanceM <= TURN_CALL_SOON_M) return "soon";
  if (distanceM <= TURN_CALL_AHEAD_M) return "ahead";
  return null;
}

/** 読む段の言葉。道のりは刻みへ丸めて読む。 */
export function turnCallText(stage: TurnCallStage, direction: RouteTurn["direction"], distanceM: number): string {
  const label = turnLabel(direction);
  if (stage === "soon") return `まもなく${label}です`;
  const spokenM = Math.round(distanceM / SPOKEN_DISTANCE_STEP_M) * SPOKEN_DISTANCE_STEP_M;
  return `${spokenM}メートル先、${label}です`;
}
