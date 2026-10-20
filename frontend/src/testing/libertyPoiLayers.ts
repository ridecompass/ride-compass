// 基礎地図（OpenFreeMapのliberty）の店・施設のレイヤーの絞り（OpenFreeMapのスタイルから写した）。点を順位で3段に分け、
// 駅・バス・空港は別に描く。先頭の道路の線は、店・施設でないレイヤーが混ざっていても絞りを当てられることを見るため。
import type { StyleLayer } from "@/testing/mapTrace/recordingMap";

const POINT = ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false];

export const LIBERTY_POI_LAYERS: readonly StyleLayer[] = [
  { id: "road_minor", type: "line", "source-layer": "transportation" },
  { id: "poi_r20", type: "symbol", "source-layer": "poi", filter: ["all", POINT, [">=", ["get", "rank"], 20]] },
  {
    id: "poi_r7",
    type: "symbol",
    "source-layer": "poi",
    filter: ["all", POINT, [">=", ["get", "rank"], 7], ["<", ["get", "rank"], 20]],
  },
  {
    id: "poi_r1",
    type: "symbol",
    "source-layer": "poi",
    filter: ["all", POINT, [">=", ["get", "rank"], 1], ["<", ["get", "rank"], 7]],
  },
  {
    id: "poi_transit",
    type: "symbol",
    "source-layer": "poi",
    filter: ["match", ["get", "class"], ["airport", "bus", "rail"], true, false],
  },
];
