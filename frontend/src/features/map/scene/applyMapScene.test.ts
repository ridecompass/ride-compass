// @vitest-environment node
/**
 * `applyMapScene.ts`——宣言したレイヤーが段の順で地図に載り、当て直した後も宣言どおりになること。
 *
 * ここで見ないもの: ソースの差し替え・作り直しと、feature-state・地図全体の状態の置き直し → `applyMapScene.sources.test.ts`
 */
import type { FilterSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import {
  applied,
  BASEMAP_ANCHORS,
  BASEMAP_LAYER_IDS,
  fillLayer,
  lineLayer,
  recordingMap,
  ROAD_TILES,
  scene,
} from "@/testing/mapSceneDeclarations";
import type { RecordingMap } from "@/testing/mapTrace/recordingMap";

import { applyMapScene, type MapSceneTarget } from "./applyMapScene";
import {
  EMPTY_MAP_SCENE,
  interactiveSceneLayerIds,
  type MapSceneImage,
  type MapSceneImageOptions,
  type MapSceneLayer,
} from "./mapScene";

/** 地図に載っているレイヤー（並び・塗り・配置・絞り込み）とソース（宣言・流し込んだ中身）。 */
function snapshot(handle: RecordingMap): unknown {
  return {
    layers: handle.layerOrder().map((id) => handle.layer(id)),
    sources: handle
      .sources()
      .sort()
      .map((id) => ({ id, spec: handle.sourceSpec(id), content: handle.sourceContent(id) })),
  };
}

const SCENE_LAYERS: readonly MapSceneLayer[] = [
  fillLayer("landcover-fill"),
  lineLayer("surface-line", "observedLine", { hitTargets: ["road"] }),
  lineLayer("lens-line", "lensLine"),
  lineLayer("poi", "point", { hitTargets: ["poi"] }),
  lineLayer("route", "route", { hitTargets: ["routeSegment"] }),
];
const SHUFFLED_LAYERS = [...SCENE_LAYERS].reverse();

const EXPECTED_ORDER = [
  "basemap-water",
  "landcover-fill",
  "basemap-road",
  "basemap-label",
  "surface-line",
  "lens-line",
  "poi",
  "route",
];

describe("mapScene", () => {
  it("押せるレイヤーの一覧は、当たり判定の宣言から段の順で導ける", () => {
    const shuffled = scene(SHUFFLED_LAYERS);

    expect(interactiveSceneLayerIds(shuffled)).toEqual(["surface-line", "poi", "route"]);
  });
});

describe("applyMapScene", () => {
  it("宣言したソースとレイヤーが、渡した配列の並びによらず段の順で地図に載り、面の段だけ呼び出し側が渡した位置より下へ入る", () => {
    const { map, handle } = recordingMap();

    applied(map, scene(SHUFFLED_LAYERS));

    expect(handle.layerOrder()).toEqual(EXPECTED_ORDER);
    expect(handle.sourceSpec("roads")).toEqual({ type: "vector", tiles: ROAD_TILES });
    expect(handle.layer("surface-line")?.visibility).toBe("visible");
  });

  it("記号の絵は、地図に無いものだけを描いて、記号のレイヤーより先に足す", () => {
    const { map, handle } = recordingMap();
    const drawn: string[] = [];
    const added: { id: string; options: MapSceneImageOptions; layersOnMap: readonly string[] }[] = [];
    const image = (id: string, options: MapSceneImageOptions): MapSceneImage => ({
      id,
      draw: () => {
        drawn.push(id);
        return { data: {} as ImageData, options };
      },
    });
    const target: MapSceneTarget = {
      ...map,
      // スタイルを差分で差し替えた後のように、前回の宣言に無くても地図には残っている絵。
      hasImage: (id) => id === "kept",
      addImage: (id, _data, options) => added.push({ id, options, layersOnMap: handle.layerOrder() }),
    };

    applyMapScene(target, {
      scene: { ...scene(SHUFFLED_LAYERS), images: [image("kept", { sdf: true }), image("arrow", { pixelRatio: 2 })] },
      previous: EMPTY_MAP_SCENE,
      basemapAnchors: BASEMAP_ANCHORS,
    });

    expect(drawn).toEqual(["arrow"]);
    expect(added).toEqual([{ id: "arrow", options: { pixelRatio: 2 }, layersOnMap: BASEMAP_LAYER_IDS }]);
  });

  it("文字に場所を譲る点の段は、呼び出し側が渡した基礎地図の文字の位置より下へ入る", () => {
    const { map, handle } = recordingMap();

    applied(map, scene([lineLayer("thinned-poi", "pointUnderLabels"), ...SHUFFLED_LAYERS]));

    expect(handle.layerOrder()).toEqual([
      "basemap-water",
      "landcover-fill",
      "basemap-road",
      "thinned-poi",
      "basemap-label",
      "surface-line",
      "lens-line",
      "poi",
      "route",
    ]);
  });

  it("scene が名指ししていない基礎地図のレイヤーは、scene を空にしても残る", () => {
    const { map, handle } = recordingMap();
    const first = scene(SCENE_LAYERS);
    applied(map, first);

    applied(map, EMPTY_MAP_SCENE, first);

    expect(handle.layerOrder()).toEqual(BASEMAP_LAYER_IDS);
    expect(handle.sources()).toEqual([]);
  });

  it("表示ON/OFF・絞り込み・paint は当て直した後の宣言どおりになる", () => {
    const { map, handle } = recordingMap();
    const before = scene([
      lineLayer("surface-line", "observedLine", {
        paint: { "line-color": "#111111", "line-opacity": 0.4 },
        filter: ["==", ["get", "kind"], "paved"] as FilterSpecification,
      }),
    ]);
    applied(map, before);

    applied(
      map,
      scene([lineLayer("surface-line", "observedLine", { paint: { "line-color": "#222222" }, visible: false })]),
      before,
    );

    const layer = handle.layer("surface-line");
    expect(layer?.paint).toEqual({ "line-color": "#222222" });
    expect(layer?.visibility).toBe("none");
    expect(layer?.filter).toBeUndefined();
  });

  it("途中の scene を経由しても、同じ scene を当てた地図と同じ状態になる", () => {
    const first = scene([
      fillLayer("landcover-fill", "#999999"),
      lineLayer("axis-line", "observedLine"),
      lineLayer("surface-line", "observedLine"),
      lineLayer("route", "route"),
    ]);
    const second = scene([
      fillLayer("landcover-fill"),
      lineLayer("axis-line", "observedLine", { visible: false }),
      lineLayer("tunnel-line", "observedLine"),
      lineLayer("poi", "point", { hitTargets: ["poi"] }),
      lineLayer("route", "route"),
    ]);

    const stepwise = recordingMap();
    applied(stepwise.map, first);
    applied(stepwise.map, second, first);

    const direct = recordingMap();
    applied(direct.map, second);

    expect(stepwise.handle.layerOrder()).toEqual(direct.handle.layerOrder());
    expect(snapshot(stepwise.handle)).toEqual(snapshot(direct.handle));
  });
});
