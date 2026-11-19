import { useQueries } from "@tanstack/react-query";

import { areaAt } from "@/features/route/placeSearchApi";
import { samePosition } from "@/lib/geoDistance";
import { getQueryClient } from "@/lib/queryClient";
import type { Coordinates } from "@/types/route";

/** `points`の位置の辺りを引き、位置から辺り（引いている間・引けなければnull）を返す関数を返す。同じ位置は1回だけ引く
 * （`useQueries`は同じ鍵が並ぶと警告する）。 */
export function usePlaceAreas(placed: readonly Coordinates[]): (at: Coordinates) => string | null {
  const points = placed.filter((at, index) => placed.findIndex((other) => samePosition(other, at)) === index);
  const results = useQueries(
    {
      queries: points.map((at) => ({
        queryKey: ["place-area", at.latitude, at.longitude],
        queryFn: () => areaAt(at),
      })),
    },
    getQueryClient(),
  );
  return (at) => {
    const index = points.findIndex((point) => samePosition(point, at));
    return index < 0 ? null : (results[index].data ?? null);
  };
}
