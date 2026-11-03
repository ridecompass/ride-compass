"use client";

import { useCallback, useMemo } from "react";

import { useAxisCatalogSelect } from "@/hooks/useAxisCatalog";
import { useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import type { MapTheme } from "@/lib/mapTheme";
import { costLensAxes } from "@/features/map/costLens";
import { EMPTY_MAP_AXIS_CATALOG, mapAxisCatalogFromResponse, type MapAxisCatalog } from "@/features/map/mapAxisCatalog";

/** 軸カタログのうち地図だけが読むもの（地図の表示の軸・タイルの世代）。取得は共有の軸カタログと1つで、届くまで・
 * 失敗の間は軸もタイルの世代も無い。届いたかどうかは共有の軸カタログの`loaded`・`failed`で見る。`theme`は塗る地図の地の明るさ。
 * 道ごとの値で塗る軸には、費用の軸のレンズ（総合と軸ごと。`features/map/costLens.ts`）も足す。 */
export function useMapAxisCatalog(theme: MapTheme): MapAxisCatalog {
  const select = useCallback(
    (response: Parameters<typeof mapAxisCatalogFromResponse>[0]) => mapAxisCatalogFromResponse(response, theme),
    [theme],
  );
  const catalog = useAxisCatalogSelect(select).data ?? EMPTY_MAP_AXIS_CATALOG;
  const costCatalog = useCostAxisCatalog();
  return useMemo(() => {
    const lenses = costLensAxes(costCatalog, theme);
    return lenses.length === 0 ? catalog : { ...catalog, dedicatedAxes: [...catalog.dedicatedAxes, ...lenses] };
  }, [catalog, costCatalog, theme]);
}
