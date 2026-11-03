// @vitest-environment node
/** 画面の状態を地図へ伝えたとき、**最後にどうなっているか**。
 *
 * 入口は本番と同じ`sceneInputsFrom`→`buildMapScene`→`applyScene`の1本で、面・道路の線・点・
 * 評価軸・気象・ルートのすべてがここを通る。
 *
 * ここで見ないもの:
 * - 評価軸の線 → `scene.axisLines.contract.test.ts`
 * - 出せるものを全部出した状態で見る、レイヤーを横断する要求 → `scene.allLayers.contract.test.ts`
 */
import { describe, expect, it } from "vitest";

import { LIBERTY_POI_LAYERS } from "@/testing/libertyPoiLayers";
import { evaluateExpression, matchesFilter } from "@/testing/mapExpressions";
import { createRecordingMap, type StyleLayer } from "@/testing/mapTrace/recordingMap";
import { catalogEntry } from "@/testing/catalogAxes";
import { rebuild, ROAD_LAYERS, roadLayerId, shown } from "@/testing/sceneContract";
import { AREA_SOURCE_ID } from "@/features/map/scene/groups/areaRasters";
import { POINT_TILE_SOURCES, pointAxisKey } from "@/features/map/scene/groups/points";
import { POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import { ROAD_LINE_SOURCE_ID } from "@/features/map/scene/groups/roadLines";
import { applyScene, sceneInputsFrom } from "@/features/map/scene/applyToMap";
import { sceneState } from "@/testing/sceneState";
import { buildMapScene } from "@/features/map/scene/buildScene";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import { routeStyleModesFromCatalogAxes } from "@/lib/mapDisplay/routeStyleModes";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

const areaLayerId = (role: keyof typeof AREA_SOURCE_ID) => sceneLayerId(AREA_SOURCE_ID[role], role);
const pointLayerId = (role: string) =>
  sceneLayerId(POINT_TILE_SOURCES[POINT_LAYERS.find((layer) => layer.attr_id === role)!.tile_kind].sourceId, role);

describe("状態を地図へ伝えた結果", () => {
  describe("面（標高図・土地被覆・起伏）", () => {
    it("表示ONにしたものだけが見えている", () => {
      const { map, handle } = createRecordingMap();

      rebuild(map, shown({ elevation: true, landcover: false, hillshade: false }));

      expect(handle.layer(areaLayerId("elevation"))?.visibility).toBe("visible");
      expect(handle.layer(areaLayerId("landcover"))?.visibility).toBe("none");
      expect(handle.layer(areaLayerId("hillshade"))?.visibility).toBe("none");
    });
  });

  describe("道路の線", () => {
    it("世代が届いた後に同じ状態を伝えると、道路の線が見えている", () => {
      const { map, handle } = createRecordingMap();
      const state = shown({ surface: true });
      rebuild(map, { ...state, tileVersions: null });

      rebuild(map, state);

      expect(handle.sources()).toContain(ROAD_LINE_SOURCE_ID);
      expect(handle.layer(roadLayerId("surface"))?.visibility).toBe("visible");
    });

    // 同じ道へ複数の線を重ねると後から描いた方が隠す。ON中の本数から対称に割り付ける。
    it("路面と道路種別を同時に出すと、線が左右へ分かれる", () => {
      const { map, handle } = createRecordingMap();

      rebuild(map, shown({ surface: true, highway: true }));

      const offsets = ROAD_LAYERS.map((layer) => handle.layer(roadLayerId(layer.id))?.paint["line-offset"]).filter(
        (value) => value !== undefined,
      );
      expect(offsets).toHaveLength(2);
      expect(offsets[0]).not.toBe(0);
      expect(offsets[0]).toBe(-Number(offsets[1]));
    });
  });

  describe("点（事故・停止要因POI・補給休憩POI）", () => {
    it("表示ONにした点が見え、同じタイルを分け合う点は互いの種別を混ぜない", () => {
      const { map, handle } = createRecordingMap();

      rebuild(map, shown({ stop_poi: true }));

      const stop = handle.layer(pointLayerId("stop_poi"));
      expect(stop?.visibility).toBe("visible");
      // 停止要因と補給は同じタイルを分け合う。分ける条件を持たないと、補給の点が停止要因の色で出る。
      expect(stop?.filter).toBeDefined();
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

  describe("ルート", () => {
    // 北緯35.6度の上を東へ進む、長さ1kmの区間を2つつないだルート。
    const segment = (from: number, to: number) => ({
      distance_km: 1,
      start_longitude: from,
      start_latitude: 35.6,
      end_longitude: to,
      end_latitude: 35.6,
      geometry: {
        type: "LineString",
        coordinates: [
          [from, 35.6],
          [to, 35.6],
        ],
      },
    });
    const route = {
      id: "a",
      geometry: {
        type: "LineString",
        coordinates: [
          [139.7, 35.6],
          [139.72, 35.6],
        ],
      },
      segments: [segment(139.7, 139.71), segment(139.71, 139.72)],
    };

    it("走り終えた距離までの区間の線と縁取りを薄め、途中の区間はその地点で分ける", () => {
      const { map, handle } = createRecordingMap();
      rebuild(
        map,
        sceneState({
          look: { layerVisibility: { route: true } },
          routes: [route] as never,
          selectedRouteId: "a",
          travelledKm: 1.5,
        }),
      );

      for (const role of ["detailLine", "detailCasing"]) {
        const layerId = handle.layerOrder().find((id) => id.endsWith(`-${role}`))!;
        const layer = handle.layer(layerId)!;
        const { features } = handle.sourceContent(layer.source!)!.data as {
          features: { geometry: { coordinates: number[][] }; properties: Record<string, unknown> }[];
        };
        const drawn = features.map(({ geometry, properties }) => [
          geometry.coordinates.map(([lng]) => Number(lng.toFixed(4))),
          evaluateExpression(layer.paint["line-opacity"] ?? 1, properties),
        ]);
        const travelled = mapDisplay.route.opacities.travelled;
        expect(drawn, role).toEqual([
          [[139.7, 139.71], travelled],
          [[139.71, 139.715], travelled],
          [[139.715, 139.72], 1],
        ]);
      }
    });

    // 勾配は区間の平均だと登って下る区間が平坦の色になるので、backendが続く坂の斜度の欄を名指す。
    it.each([
      ["material_values", { material_values: { grade: -5 }, sustained_gradient_percent: 5 }],
      ["sustained_gradient_percent", { material_values: { grade: 5 }, sustained_gradient_percent: -5 }],
    ] as const)(
      "生値を塗るレンズは、backendが名指す区間の欄（%s）の値でルート線を塗る（負の値は下りの色）",
      (field, values) => {
        const axis = catalogEntry({
          axis_id: "slope",
          map_paint: {
            value: { kind: "signed_material", material: "grade", route_segment_field: field },
            thresholds: [-2, 2],
            legend: { boundaries: [-2, 2], unit: "%" },
          },
        });
        const { map, handle } = createRecordingMap();
        rebuild(
          map,
          sceneState({
            look: { layerVisibility: { route: true }, lens: "slope" },
            catalog: { routeStyleModes: routeStyleModesFromCatalogAxes([axis]) },
            routes: [
              { ...route, segments: [{ ...segment(139.7, 139.72), axis_difficulties: { slope: 99 }, ...values }] },
            ] as never,
            selectedRouteId: "a",
          }),
        );

        const layer = handle.layer(handle.layerOrder().find((id) => id.endsWith("-detailLine"))!)!;
        const { features } = handle.sourceContent(layer.source!)!.data as {
          features: { properties: Record<string, unknown> }[];
        };
        expect(evaluateExpression(layer.paint["line-color"], features[0].properties)).toBe(
          palette.semantic.signed_descent,
        );
      },
    );
  });
});
