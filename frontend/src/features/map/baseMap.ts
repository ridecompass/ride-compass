import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

import { configureMaplibreWorker } from "@/features/map/maplibreWorker";
import { mapStyleUrl } from "@/features/map/regionApi";
import { debugLog } from "@/lib/debugLog";
import { mapDisplay } from "@/types/generated/mapDisplay";

const MAP_UI_LOCALE: Record<string, string> = {
  "Map.Title": "地図",
  "AttributionControl.ToggleAttribution": "出典の表示を切り替える",
  "AttributionControl.MapFeedback": "地図の誤りを報告する",
  "Popup.Close": "閉じる",
};

/** 基礎地図のスタイルで地図を作る。載せるもの（ソース・レイヤー）は呼ぶ側が場面（`scene/applyToMap.ts: applyScene`）で当てる。 */
export function createBaseMap({
  container,
  center,
  zoom,
}: {
  container: HTMLElement;
  center: [number, number];
  zoom: number;
}): MapLibreMap {
  // Mapの生成がWorkerを起こすため、作る前に要る。
  configureMaplibreWorker();
  return new maplibregl.Map({
    container,
    style: mapStyleUrl(),
    center,
    zoom,
    // 常に使うデータの出典は、どのレイヤーを出しているかと関係なく出す（宣言はbackend）。
    attributionControl: { compact: true, customAttribution: [...mapDisplay.alwaysShownAttributions] },
    // デバッグモードの間、MapLibreが出す要求を種別ごとにログする（無効の間debugLogは何もしない）。
    transformRequest: (url, resourceType) => {
      debugLog("map:request", `${resourceType ?? "unknown"} ${url}`);
      return { url };
    },
    locale: MAP_UI_LOCALE,
  });
}
