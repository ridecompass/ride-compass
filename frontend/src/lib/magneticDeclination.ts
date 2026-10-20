import { normalizeDeg } from "@/lib/cardinalLabel";
import type { Coordinates } from "@/types/route";

/**
 * 日本付近の偏角（度。真北から西回りを正＝西偏）。国土地理院の磁気図2020.0年値の2次の近似式
 * （https://vldb.gsi.go.jp/sokuchi/geomag/menu_04/index.html の「近似式から求める」。係数は分の単位、Δφ・Δλは北緯37度・
 * 東経138度からの差の度）。日本の磁場を大局で表した式で、地域の磁気異常は入らず、離島では精度が落ちる。
 */
export function magneticDeclinationDeg({ latitude, longitude }: Coordinates): number {
  const dPhi = latitude - 37;
  const dLambda = longitude - 138;
  const minutes =
    8 * 60 +
    15.822 +
    18.462 * dPhi -
    7.726 * dLambda +
    0.007 * dPhi ** 2 -
    0.007 * dPhi * dLambda -
    0.655 * dLambda ** 2;
  return minutes / 60;
}

/** 磁北を基準にした方角（時計回りの度）を、地点`at`の偏角で真北の基準へ直す。 */
export function trueHeadingDeg(magneticDeg: number, at: Coordinates): number {
  return normalizeDeg(magneticDeg - magneticDeclinationDeg(at));
}
