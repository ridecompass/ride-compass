import { queryOptions, useQueries } from "@tanstack/react-query";

import { areaAt } from "@/features/route/placeSearchApi";
import { samePosition } from "@/lib/geoDistance";
import { getQueryClient } from "@/lib/queryClient";
import type { Coordinates } from "@/types/route";

/** 置いた位置の辺りを引く問い合わせ（同じ位置は、地点の詳しくと名前で同じ答えを使い回す）。`at`がnullなら引かない。 */
export function placeAreaQuery(at: Coordinates | null) {
  return queryOptions({
    queryKey: ["place-area", at?.latitude, at?.longitude],
    queryFn: () => areaAt(at!),
    enabled: at !== null,
  });
}

/** `points`の位置の辺りを引き、位置から辺り（引いている間・引けなければnull）を返す関数を返す。 */
export function usePlaceAreas(points: readonly Coordinates[]): (at: Coordinates) => string | null {
  const results = useQueries({ queries: points.map((at) => placeAreaQuery(at)) }, getQueryClient());
  return (at) => {
    const index = points.findIndex((point) => samePosition(point, at));
    return index < 0 ? null : (results[index].data ?? null);
  };
}
