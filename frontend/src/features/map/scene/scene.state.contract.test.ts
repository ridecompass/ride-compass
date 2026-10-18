// @vitest-environment node
/** 画面の状態を地図へ伝えたとき、**最後にどうなっているか**。
 *
 * 入口は本番と同じ`sceneInputsFrom`→`buildMapScene`→`applyScene`の1本で、面・道路の線・点・
 * 評価軸・気象・ルートのすべてがここを通る。
 */
import { latest, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { LIBERTY_POI_LAYERS } from "@/testing/libertyPoiLayers";
import { evaluateExpression, matchesFilter } from "@/testing/mapExpressions";
import { createRecordingMap, type StyleLayer } from "@/testing/mapTrace/recordingMap";
import { catalogEntry, dedicatedEntry, MATERIAL_VALUE_FORMULA } from "@/testing/catalogAxes";
import { dedicatedWayValueAxesFromCatalogAxes } from "@/lib/mapDisplay/axisLayers";
import { AREA_SOURCE_ID } from "@/features/map/scene/groups/areaRasters";
import { POINT_TILE_SOURCES, pointAxisKey } from "@/features/map/scene/groups/points";
import { POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import { ROAD_LINE_SOURCE_ID } from "@/features/map/scene/groups/roadLines";
import { ROAD_TRACKS } from "@/lib/mapDisplay/roadTracks";
import { pointLegendAxes, roadLegendAxes } from "@/features/map/scene/legends";
import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { valueBands } from "@/lib/mapDisplay/valueScale";
import { applyScene, sceneInputsFrom } from "@/features/map/scene/applyToMap";
import { sceneState, type SceneState, type SceneStateOverrides } from "@/testing/sceneState";
import { buildMapScene } from "@/features/map/scene/buildScene";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import { mapDisplay } from "@/types/generated/mapDisplay";

const DEDICATED_AXES = dedicatedWayValueAxesFromCatalogAxes([
  catalogEntry({ axis_id: "ded1", way_value_formula: MATERIAL_VALUE_FORMULA }),
  catalogEntry({ axis_id: "ded2", way_value_formula: MATERIAL_VALUE_FORMULA }),
  catalogEntry({ axis_id: "unformulated" }),
]);

const CATALOG = { dedicatedAxes: DEDICATED_AXES };

/** 表示ONのレイヤーだけを持つ状態。 */
function shown(layerVisibility: Record<string, boolean>, look: SceneStateOverrides["look"] = {}) {
  return sceneState({ catalog: CATALOG, look: { ...look, layerVisibility } });
}

// レイヤーidは**ソース名＋役割**で決まる。綴りは`sceneLayerId`からしか作らない
// ——ここで組み立て直すと、規則を変えたときテストだけが古い綴りのまま残る。
const areaLayerId = (role: keyof typeof AREA_SOURCE_ID) => sceneLayerId(AREA_SOURCE_ID[role], role);
const roadLayerId = (role: string) => sceneLayerId(ROAD_LINE_SOURCE_ID, role);
const pointLayerId = (role: string) =>
  sceneLayerId(POINT_TILE_SOURCES[POINT_LAYERS.find((layer) => layer.attr_id === role)!.tile_kind].sourceId, role);

/** 空から作り直す経路（スタイルを差し替えた後に通るのはこちら）。 */
function rebuild(map: unknown, state: SceneState) {
  applyScene(map as never, buildMapScene(sceneInputsFrom(state)), { reset: true });
}

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

      const offsets = ROAD_TRACKS.map((track) => handle.layer(roadLayerId(track.attr_id))?.paint["line-offset"]).filter(
        (value) => value !== undefined,
      );
      expect(new Set(offsets).size).toBeGreaterThan(1);
      expect(offsets).toContain(0);
    });

    it("凡例で隠した分類は、その線から落ちる", () => {
      const { map, handle } = createRecordingMap();

      // 行の鍵は源泉の宣言から取る（書き写すと、行の鍵を変えたときにこの検査だけが黙って何も隠さなくなる）。
      const firstRow = ROAD_TRACKS.find((track) => track.attr_id === "surface")!.display_axes[0].categories[0].key;
      rebuild(map, shown({ surface: true }, { hiddenLegendKeys: { surface: [firstRow] } }));

      expect(handle.layer(roadLayerId("surface"))?.filter).toBeDefined();
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
    // OpenMapTilesのスキーマの値（`class`は束ねた種類、`subclass`は元のOSMのタグの値）と、それを出す立ち寄り先の群。
    const STOP_PLACE_KINDS = [
      ["飲食店", "eat_drink", { class: "restaurant", subclass: "restaurant" }],
      ["カフェ", "eat_drink", { class: "cafe", subclass: "cafe" }],
      ["酒場", "eat_drink", { class: "beer", subclass: "pub" }],
      ["自転車の店", "bicycle", { class: "bicycle", subclass: "bicycle" }],
      ["公園", "scenic", { class: "park", subclass: "park" }],
      ["展望地", "scenic", { class: "attraction", subclass: "viewpoint" }],
      ["宿", "lodging", { class: "lodging", subclass: "hotel" }],
      ["キャンプ場", "lodging", { class: "campsite", subclass: "camp_site" }],
      ["礼拝の場所", "temple_shrine", { class: "place_of_worship", subclass: "place_of_worship" }],
    ] as const;
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

    it("立ち寄り先・補給休憩を出していないときは、基礎地図の店・施設を全部描く", () => {
      const { map } = drawBasemap();

      rebuild(map, shown({}));

      for (const [, , kind] of STOP_PLACE_KINDS) expect(drawsAnyRank(map, kind)).toBe(true);
      expect(drawsAnyRank(map, CONVENIENCE)).toBe(true);
    });

    it.each(STOP_PLACE_KINDS)("立ち寄り先を出している間は、%s を基礎地図に描かない", (_, _group, kind) => {
      const { map } = drawBasemap();

      rebuild(map, shown({ stop_place: true }));

      expect(drawsAnyRank(map, kind)).toBe(false);
    });

    it("立ち寄り先を出しても、病院・銀行・郵便局・学校・ほかの店・駅と、補給休憩のコンビニは基礎地図に描く", () => {
      const { map } = drawBasemap();

      rebuild(map, shown({ stop_place: true }));

      for (const kind of [
        { class: "hospital", subclass: "hospital" },
        { class: "bank", subclass: "bank" },
        { class: "post", subclass: "post_office" },
        { class: "school", subclass: "school" },
        { class: "shop", subclass: "bakery" },
        { class: "rail", subclass: "station" },
        CONVENIENCE,
      ])
        expect(drawsAnyRank(map, kind)).toBe(true);
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

  describe("評価軸の線", () => {
    const fetched = (byAxis: Record<string, Record<string, Record<string, number>>>) =>
      new Map(
        Object.entries(byAxis).map(([axisId, byWay]) => [
          axisId,
          { materials: new Map(Object.entries(byWay)), loading: false },
        ]),
      );
    const MATERIALS = fetched({ ded1: { w1: { value: 3 } }, ded2: { w1: { value: 7 } } });

    it("取った材料は道路のソースの地物へ軸ごとに載り、塗っている軸の線が見える", () => {
      const { map, handle } = createRecordingMap();
      rebuild(map, shown({ surface: true }, { paintedAxisId: "ded1", wayMaterials: MATERIALS }));

      expect(handle.featureState(ROAD_LINE_SOURCE_ID, "w1")).toEqual({ "ded1:value": 3, "ded2:value": 7 });
      expect(handle.layer(roadLayerId("ded1"))?.visibility).toBe("visible");
      expect(handle.layer(roadLayerId("ded2"))?.visibility).toBe("none");
    });

    it("走る条件だけを変えると、地図全体の状態だけを置き直し、材料もレイヤーも当て直さない", () => {
      const { map, handle } = createRecordingMap();
      const look = { paintedAxisId: "ded1", wayMaterials: MATERIALS };
      rebuild(map, shown({ surface: true }, { ...look, wayConditions: { bearing_deg: 0, speed_kmh: 20 } }));
      const callsBefore = handle.trace.length;

      applyScene(
        map as never,
        buildMapScene(
          sceneInputsFrom(shown({ surface: true }, { ...look, wayConditions: { bearing_deg: 135.5, speed_kmh: 20 } })),
        ),
      );

      expect(handle.trace.slice(callsBefore)).toEqual([
        { call: "setGlobalStateProperty", args: ["bearing_deg", 135.5] },
      ]);
    });

    it("式の木の無い軸は、塗っていても周りの道の線を持たない", () => {
      const { map, handle } = createRecordingMap();
      rebuild(map, shown({ surface: true }, { paintedAxisId: "unformulated" }));

      expect(handle.layerOrder().filter((id) => id.includes("unformulated"))).toEqual([]);
    });

    it("塗っている軸は、その材料のレイヤーが出ている間だけ下敷きになる", () => {
      const dedicatedAxes = dedicatedWayValueAxesFromCatalogAxes([
        dedicatedEntry("paved", [50], {
          primary_attribute_ids: ["surface"],
          way_value_formula: MATERIAL_VALUE_FORMULA,
        }),
      ]);
      const opacityWith = (surface: boolean) => {
        const { map, handle } = createRecordingMap();
        rebuild(
          map,
          sceneState({ catalog: { dedicatedAxes }, look: { paintedAxisId: "paved", layerVisibility: { surface } } }),
        );
        return handle.layer(roadLayerId("paved"))?.paint["line-opacity"];
      };

      expect(opacityWith(true)).toBe(mapDisplay.road.underlayOpacity);
      expect(opacityWith(false)).not.toBe(mapDisplay.road.underlayOpacity);
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
  });
});

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
    for (const track of ROAD_TRACKS) visibility[track.attr_id] = true;
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
          ...firstKeyHidden(roadLegendAxes()),
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
