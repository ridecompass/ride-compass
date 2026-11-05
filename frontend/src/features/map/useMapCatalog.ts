"use client";

import { useCallback, useMemo } from "react";

import { useClientConfigSelect } from "@/hooks/useClientConfig";
import { useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import type { MapTheme } from "@/lib/mapTheme";
import { costLenses, costRouteStyleModes } from "@/features/map/costLens";
import { EMPTY_MAP_CONFIG, mapCatalogOf, mapConfigFromResponse, type MapCatalog } from "@/features/map/mapCatalog";

/** 地図だけが読むもの（レンズ・ルートの線のモード・タイルの世代・道の線の層）。取得は共有の画面の設定と費用の軸の一覧で、
 * 届くまで・失敗の間はどれも無い。`theme`は塗る地図の地の明るさ。 */
export function useMapCatalog(theme: MapTheme): MapCatalog {
  const select = useCallback(
    (response: Parameters<typeof mapConfigFromResponse>[0]) => mapConfigFromResponse(response, theme),
    [theme],
  );
  const config = useClientConfigSelect(select).data ?? EMPTY_MAP_CONFIG;
  const costCatalog = useCostAxisCatalog();
  return useMemo(
    () => mapCatalogOf(config, costLenses(costCatalog, theme), costRouteStyleModes(costCatalog, theme)),
    [config, costCatalog, theme],
  );
}
