// 地図が読む一覧を、テストが架空の費用の軸と画面の設定から組む。本番と同じ応答からの導出（`useMapCatalog`の中身）を通す。
import { costAxisCatalogFromResponse } from "@/hooks/useCostAxisCatalog";
import { costLenses, costRouteStyleModes } from "@/features/map/costLens";
import { mapCatalogOf, mapConfigFromResponse, type MapCatalog } from "@/features/map/mapCatalog";
import { clientConfigResponse } from "@/testing/clientConfig";
import { TWO_COST_AXES } from "@/testing/costAxes";
import type { ClientConfigResponse, CostAxisCatalogResponse } from "@/types/route";

export function mapCatalogFor(
  costAxes: CostAxisCatalogResponse = TWO_COST_AXES,
  config: Partial<ClientConfigResponse> = {},
): MapCatalog {
  const costCatalog = costAxisCatalogFromResponse(costAxes);
  return mapCatalogOf(
    mapConfigFromResponse(clientConfigResponse(config)),
    costLenses(costCatalog, "light"),
    costRouteStyleModes(costCatalog, "light"),
  );
}
