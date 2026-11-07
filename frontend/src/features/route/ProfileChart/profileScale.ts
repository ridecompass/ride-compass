import { useMemo } from "react";

import { roundToDigits } from "@/lib/numberFormat";
import { routeStretches, type RouteStretch } from "@/lib/routeDistance";
import type { RouteSegmentDetail } from "@/types/route";

/** 描画の座標。横は距離を`PROFILE_VIEW_WIDTH`へ、縦は`PROFILE_VIEW_HEIGHT`の中へ描き、枠いっぱいへ伸ばす。 */
export const PROFILE_VIEW_WIDTH = 1000;
export const PROFILE_VIEW_HEIGHT = 100;

/** 図の目盛りと図の下の文字の大きさ。走行中は走りながら読めるよう、結果の図より大きくする。 */
export function profileTextClass(riding: boolean): string {
  return riding ? "text-base" : "text-[length:var(--font-size-xs)]";
}

export type ProfileScale = {
  readonly columns: readonly RouteStretch<RouteSegmentDetail>[];
  /** ルートの長さ。 */
  readonly routeKm: number;
  /** 横軸の右端の距離。 */
  readonly widthKm: number;
  /** 距離を描画の横座標へ。 */
  readonly xOf: (km: number) => number;
};

/** 区間の並びと横軸。横軸の右端は`scaleKm`とルートの長さの長い方。 */
export function useProfileScale(segments: readonly RouteSegmentDetail[], scaleKm: number): ProfileScale {
  const columns = useMemo(() => routeStretches(segments), [segments]);
  const routeKm = columns.length === 0 ? 0 : columns[columns.length - 1].endKm;
  const widthKm = Math.max(scaleKm, routeKm);
  return useMemo(
    () => ({
      columns,
      routeKm,
      widthKm,
      xOf: (km: number) => (widthKm > 0 ? roundToDigits((km / widthKm) * PROFILE_VIEW_WIDTH, 2) : 0),
    }),
    [columns, routeKm, widthKm],
  );
}
