// @vitest-environment node
/** 点の層の状態を地図へ伝えたとき、**最後にどうなっているか**（点の層と、点の層が隠す基礎地図の店・施設の印）。
 *
 * 入口は本番と同じ`sceneInputsFrom`→`buildMapScene`→`applyScene`の1本。
 *
 * ここで見ないもの: 面・道路の線・ルート → `scene.state.contract.test.ts`
 */
import { describe, expect, it } from "vitest";

import { LIBERTY_POI_LAYERS } from "@/testing/libertyPoiLayers";
import { matchesFilter, matchesFilterAtPoint } from "@/testing/mapExpressions";
import { createRecordingMap, type StyleLayer } from "@/testing/mapTrace/recordingMap";
import { rebuild, shown } from "@/testing/sceneContract";
import { POINT_TILE_SOURCES, pointAxisKey } from "@/features/map/scene/groups/points";
import { POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import { applyScene } from "@/features/map/scene/applyToMap";
import { sceneInputsFrom } from "@/features/map/scene/sceneInputs";
import { buildMapScene } from "@/features/map/scene/buildScene";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";

const pointLayerId = (role: string) =>
  sceneLayerId(POINT_TILE_SOURCES[POINT_LAYERS.find((layer) => layer.attr_id === role)!.tile_kind].sourceId, role);

describe("点（事故・停止要因POI・補給休憩POI）", () => {
  it("表示ONにした点が見え、同じタイルを分け合う点は互いの種別を混ぜない", () => {
    const { map, handle } = createRecordingMap();

    rebuild(map, shown({ stop_poi: true }));

    const stop = handle.layer(pointLayerId("stop_poi"));
    expect(stop?.visibility).toBe("visible");
    // 停止要因と補給は同じタイルを分け合う。分ける条件を持たないと、補給の点が停止要因の色で出る。
    expect(stop?.filter).toBeDefined();
  });

  // 東西に1kmずつ離れた2本の線。緯度0.001度（約110m）より近い点だけを通す。
  const ROUTE: [number, number][] = [
    [139.7, 35.7],
    [139.71, 35.7],
  ];
  const EDITED: [number, number][] = [
    [139.7, 35.71],
    [139.71, 35.71],
  ];
  const CONVENIENCE = { kind: "convenience" };
  it.each([
    {
      case: "周りを出す間は、どちらの線からも遠い点も描く",
      surroundingsShown: true,
      splicedRoute: null,
      near: [true, true, true],
    },
    {
      case: "ルート沿いだけの間は、ルートの線の近くだけ",
      surroundingsShown: false,
      splicedRoute: null,
      near: [true, false, false],
    },
    {
      case: "編集中は、編集している線の近くだけ",
      surroundingsShown: false,
      splicedRoute: EDITED,
      near: [false, true, false],
    },
  ])("$case", ({ surroundingsShown, splicedRoute, near }) => {
    const { map, handle } = createRecordingMap();

    rebuild(map, {
      ...shown({ supply_poi: true }, { surroundingsShown }),
      routePath: ROUTE,
      splicedRoute,
    });

    const filter = handle.layer(pointLayerId("supply_poi"))?.filter;
    const at: [number, number][] = [
      [139.705, 35.7001],
      [139.705, 35.7101],
      [139.705, 35.705],
    ];
    expect(at.map((lngLat) => matchesFilterAtPoint(filter, CONVENIENCE, lngLat))).toEqual(near);
  });
});

describe("基礎地図の店・施設の印", () => {
  const CONVENIENCE = { class: "shop", subclass: "convenience" };
  const RANKS = [3, 8, 25];

  /** 基礎地図を読んだ地図へ、状態を伝える。 */
  function drawBasemap() {
    const recording = createRecordingMap();
    recording.handle.loadStyle(LIBERTY_POI_LAYERS);
    return recording;
  }

  /** その種類の地物（点）を、どれかの順位で基礎地図が描くか。 */
  function drawsAnyRank(map: { getStyle: () => { layers: StyleLayer[] } | undefined }, kind: object): boolean {
    const layers = map.getStyle()!.layers.filter((layer) => layer["source-layer"] === "poi");
    return RANKS.some((rank) => layers.some((layer) => matchesFilter(layer.filter, { ...kind, rank }, 1)));
  }

  const stopPlace = POINT_LAYERS.find((layer) => layer.attr_id === "stop_place")!;
  const stopPlaceAxisKey = pointAxisKey(stopPlace, stopPlace.display_axes[0]);

  it("立ち寄り先を出しても、補給休憩のコンビニは基礎地図に描く", () => {
    const { map } = drawBasemap();

    rebuild(map, shown({ stop_place: true }));

    expect(drawsAnyRank(map, CONVENIENCE)).toBe(true);
  });

  it("凡例で隠した群の種類は、立ち寄り先を出していても基礎地図に描く", () => {
    const { map } = drawBasemap();

    rebuild(map, shown({ stop_place: true }, { hiddenLegendKeys: { [stopPlaceAxisKey]: ["eat_drink"] } }));

    expect(drawsAnyRank(map, { class: "restaurant", subclass: "restaurant" })).toBe(true);
    expect(drawsAnyRank(map, { class: "park", subclass: "park" })).toBe(false);
  });

  it("補給休憩を出している間だけ、コンビニを基礎地図に描かない", () => {
    const { map } = drawBasemap();

    applyScene(map as never, buildMapScene(sceneInputsFrom(shown({ supply_poi: true }))));
    expect(drawsAnyRank(map, CONVENIENCE)).toBe(false);
    expect(drawsAnyRank(map, { class: "restaurant", subclass: "restaurant" })).toBe(true);

    applyScene(map as never, buildMapScene(sceneInputsFrom(shown({ supply_poi: false }))));
    expect(drawsAnyRank(map, CONVENIENCE)).toBe(true);
  });
});
