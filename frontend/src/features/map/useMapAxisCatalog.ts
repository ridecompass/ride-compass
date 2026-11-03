"use client";

import { useCallback } from "react";

import { useAxisCatalogSelect } from "@/hooks/useAxisCatalog";
import type { MapTheme } from "@/lib/mapTheme";
import { EMPTY_MAP_AXIS_CATALOG, mapAxisCatalogFromResponse, type MapAxisCatalog } from "@/features/map/mapAxisCatalog";

/** 軸カタログのうち地図だけが読むもの（地図の表示の軸・タイルの世代）。取得は共有の軸カタログと1つで、届くまで・
 * 失敗の間は軸もタイルの世代も無い。届いたかどうかは共有の軸カタログの`loaded`・`failed`で見る。`theme`は塗る地図の地の明るさ。 */
export function useMapAxisCatalog(theme: MapTheme): MapAxisCatalog {
  const select = useCallback(
    (response: Parameters<typeof mapAxisCatalogFromResponse>[0]) => mapAxisCatalogFromResponse(response, theme),
    [theme],
  );
  return useAxisCatalogSelect(select).data ?? EMPTY_MAP_AXIS_CATALOG;
}
