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
  const map = new maplibregl.Map({
    container,
    style: mapStyleUrl(),
    center,
    zoom,
    // 地図は傾けない（奥へ倒れると道とルートが読みにくい）。回すのは使うので、回す操作は残す。
    maxPitch: 0,
    touchPitch: false,
    pitchWithRotate: false,
    // 常に使うデータの出典は、どのレイヤーを出しているかと関係なく出す（宣言はbackend）。
    attributionControl: { compact: true, customAttribution: [...mapDisplay.alwaysShownAttributions] },
    // デバッグモードの間、MapLibreが出す要求を種別ごとにログする（無効の間debugLogは何もしない）。
    transformRequest: (url, resourceType) => {
      debugLog("map:request", `${resourceType ?? "unknown"} ${url}`);
      return { url };
    },
    locale: MAP_UI_LOCALE,
  });
  // 出典の表示は、データが載った時点でMapLibreが開いた状態（全文）にし、地図を一度ドラッグするまで閉じない。
  // その間地図とほかのUIを覆うため、同じイベントのたびに畳む。
  const attribution = container.querySelector(".maplibregl-ctrl-attrib");
  function collapseAttribution() {
    attribution?.classList.remove("maplibregl-compact-show");
  }
  map.on("styledata", collapseAttribution);
  map.on("sourcedata", collapseAttribution);
  return map;
}
