// @vitest-environment node
/** 出せるものを全部出した状態を地図へ伝えたとき、どのレイヤーにも当たる要求。入口は`scene.state.contract.test.ts`と同じ
 * `sceneInputsFrom`→`buildMapScene`→`applyScene`の1本。
 */
import { latest, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { createRecordingMap } from "@/testing/mapTrace/recordingMap";
import { CATALOG, DEDICATED_AXES, rebuild, ROAD_LAYERS } from "@/testing/sceneContract";
import { AREA_SOURCE_ID } from "@/features/map/scene/groups/areaRasters";
import { POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import { ROAD_LINE_SOURCE_ID } from "@/features/map/scene/groups/roadLines";
import { pointLegendAxes, roadLegendAxes } from "@/features/map/scene/legends";
import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { valueBands } from "@/lib/mapDisplay/valueScale";
import { sceneState, type SceneState } from "@/testing/sceneState";
import { mapDisplay } from "@/types/generated/mapDisplay";

describe("レイヤーを横断する要求", () => {
  const EMPTY_GEOJSON: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

  /** 地図へ足したレイヤーの宣言（足した順）。 */
  const addedLayers = (handle: ReturnType<typeof createRecordingMap>["handle"]) =>
    handle.trace.filter((entry) => entry.call === "addLayer").map((entry) => entry.args[2]);

  /** 宣言された描き方に合う中身を、全要素ぶん作る。**名指ししない**——母集団は源泉の
   * 宣言（生成物）なので、backendが要素を増やせばそのまま対象になる。 */
  function everyWeatherGroupState(): Record<string, Record<string, unknown>> {
    const groups: Record<string, Record<string, unknown>> = {};
    for (const element of mapDisplay.weatherElements) {
      const payload =
        element.kind === "rasterTile"
          ? { kind: "rasterTile", tileUrlTemplate: "https://example.test/{z}/{x}/{y}.png" }
          : element.kind === "vectorTile"
            ? { kind: "vectorTile", tileUrlTemplate: "https://example.test/{z}/{x}/{y}.pbf" }
            : { kind: element.kind, geojson: EMPTY_GEOJSON };
      groups[element.group] = { ...groups[element.group], [element.source]: { visible: true, payload } };
    }
    return groups;
  }

  /** 出せるものを全部出した状態。チップのidは各グループの宣言から取る。 */
  function everythingVisible(): SceneState {
    const visibility: Record<string, boolean> = {};
    for (const layer of ROAD_LAYERS) visibility[layer.id] = true;
    for (const layer of POINT_LAYERS) visibility[layer.attr_id] = true;
    for (const role of Object.keys(AREA_SOURCE_ID)) visibility[role] = true;
    visibility.route = true;
    const mode = { id: "difficulty", label: "難易度", colorExpression: ["literal", "#16a34a"], legend: [] };
    const line = {
      type: "LineString",
      coordinates: [
        [139.7, 35.6],
        [139.71, 35.61],
      ],
    };
    const candidate = {
      id: "a",
      geometry: line,
      segments: [
        { start_longitude: 139.7, start_latitude: 35.6, end_longitude: 139.71, end_latitude: 35.61, geometry: line },
      ],
    };
    // 絞り込みの式も検証の対象にするため、凡例の先頭の行と「値なし」を隠しておく。
    const firstKeyHidden = (axes: readonly { axisId: string; entries: readonly { key: string }[] }[]) =>
      Object.fromEntries(axes.map((axis) => [axis.axisId, axis.entries.slice(0, 1).map((entry) => entry.key)]));
    const firstBandAndNoData = (bands: readonly { key: string }[]) => [bands[0].key, LEGEND_NO_DATA_KEY];
    // 評価軸は一度に1本しか塗らないが、どの軸のレイヤーも常に宣言され、塗るかは表示だけが変わる。
    return sceneState({
      catalog: { ...CATALOG, routeStyleModes: [mode] as never },
      look: {
        layerVisibility: visibility,
        paintedAxisId: DEDICATED_AXES[0].axisId,
        lens: "difficulty",
        hiddenLegendKeys: {
          ...firstKeyHidden(roadLegendAxes(ROAD_LAYERS)),
          ...firstKeyHidden(pointLegendAxes()),
          ...Object.fromEntries(
            DEDICATED_AXES.map((axis) => [axis.axisId, firstBandAndNoData(valueBands(axis.display))]),
          ),
        },
        dynamicWeather: everyWeatherGroupState() as never,
      },
      routes: [candidate] as never,
      selectedRouteId: "a",
    });
  }

  // 「差し替え後に戻るか」はレイヤーごとの性質ではないので、家族ごとに繰り返さず
  // **全部を載せた状態で1回**見る。新しいレイヤーが増えればそのまま対象になる。
  it("スタイルを差し替えても、同じ状態を伝え直せば元へ戻る", () => {
    const { map, handle } = createRecordingMap();
    const state = everythingVisible();
    rebuild(map, state);
    const before = handle.layerOrder();
    // 空振りしていないこと（載っていなければ比較は常に通る）。
    expect(before.length).toBeGreaterThan(mapDisplay.weatherElements.length);

    handle.dropEverything();
    rebuild(map, state);

    expect(handle.layerOrder()).toEqual(before);
  });

  // 式の誤りは例外にならず、そのレイヤーだけが黙って描かれない（代役地図は式を検証しない）。
  // 出せるものを全部出した状態の宣言を、MapLibreと同じ版のstyle検証へ通す。
  it("地図へ渡すソースとレイヤーは、すべてMapLibreのstyle検証を通る", () => {
    const { map, handle } = createRecordingMap();
    rebuild(map, everythingVisible());
    const sources = Object.fromEntries(
      handle.trace.filter((entry) => entry.call === "addSource").map((entry) => [entry.args[0], entry.args[1]]),
    );
    const layers = addedLayers(handle);
    // 空振りしていないこと（載っていなければ検証は常に通る）。
    expect(layers.length).toBeGreaterThan(mapDisplay.weatherElements.length);

    const errors = validateStyleMin({
      version: 8,
      glyphs: "https://example.test/{fontstack}/{range}.pbf",
      sources,
      layers,
    } as never);

    expect(errors.map((error) => error.message)).toEqual([]);
  });

  // MapLibreはfeature-stateを読めるプロパティを限っている（例: 色・不透明度は読めるが、破線の刻み・絞り込みは読めない）。
  // 読めない場所に書いた式は検証も通り、例外も出さず、値が無いものとして評価される——配信値の軸の線が全部破線になる。
  // 可否はstyle-specの各プロパティの`expression.parameters`が持つ。
  it("feature-stateを読む式は、feature-stateを読めるプロパティにだけ置かれる", () => {
    const { map, handle } = createRecordingMap();
    rebuild(map, everythingVisible());
    const layers = addedLayers(handle) as (Record<string, unknown> & { id: string; type: string })[];
    const readsState = (expression: unknown): boolean =>
      Array.isArray(expression) && (expression[0] === "feature-state" || expression.some(readsState));
    const spec = latest as unknown as Record<string, Record<string, { expression?: { parameters?: string[] } }>>;

    const misplaced: string[] = [];
    let stateReaders = 0;
    for (const layer of layers) {
      if (readsState(layer.filter)) misplaced.push(`${layer.id}: filter`);
      for (const group of ["paint", "layout"] as const) {
        for (const [property, value] of Object.entries((layer[group] ?? {}) as Record<string, unknown>)) {
          if (!readsState(value)) continue;
          stateReaders += 1;
          const parameters = spec[`${group}_${layer.type}`]?.[property]?.expression?.parameters ?? [];
          if (!parameters.includes("feature-state")) misplaced.push(`${layer.id}: ${property}`);
        }
      }
    }
    // feature-stateを読む式が実際にあること（0件なら、この検査は何も見ていない）。
    expect(stateReaders).toBeGreaterThan(0);
    expect(misplaced).toEqual([]);
  });

  // 世代が届く前にソースを作ると、世代の違う中身がブラウザのキャッシュへ載って以後ずっと残る。
  it("世代を要るソースは、世代が届くまで1つも作られない", () => {
    const state = everythingVisible();

    const ready = createRecordingMap();
    rebuild(ready.map, state);

    const pending = createRecordingMap();
    rebuild(pending.map, { ...state, tileVersions: null });

    const gated = ready.handle.sources().filter((id) => !pending.handle.sources().includes(id));
    // 世代で守られているソースが実際にあること（0件なら、この検査は何も見ていない）。
    expect(gated.length).toBeGreaterThan(0);
    expect(gated).toContain(ROAD_LINE_SOURCE_ID);
  });
});
