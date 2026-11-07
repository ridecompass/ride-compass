// @vitest-environment node
/**
 * `applyMapScene.ts`——当て直すとき、ソースを差し替えるか作り直すかと、ソースへ置く feature-state・地図全体の状態を、
 * 前回の宣言との差分だけで置き直すこと。
 *
 * ここで見ないもの: レイヤーの段の順・表示・絞り込み・paint → `applyMapScene.test.ts`
 */
import { describe, expect, it } from "vitest";

import {
  applied,
  fillLayer,
  LANDCOVER_SOURCE,
  lineLayer,
  recordingMap,
  ROAD_TILES,
  roadsSource,
  scene,
} from "@/testing/mapSceneDeclarations";
import type { RecordingMap } from "@/testing/mapTrace/recordingMap";

import { EMPTY_MAP_SCENE, type MapScene, type MapSceneFeatureStateValue } from "./mapScene";
import { tilesContent } from "./sceneBuilders";

/** 地物の状態。本物の `getFeatureState` と同じく、置かれていなければ空として読む。 */
function roadStateOf(handle: RecordingMap, featureId: string): Record<string, unknown> {
  return { ...handle.featureState("roads", featureId) };
}

/** キーごと・地物ごとの値を、ソースへ置く feature-state の形にする。 */
function featureStates(
  byKey: Record<string, Record<string, MapSceneFeatureStateValue>>,
): ReadonlyMap<string, ReadonlyMap<string, MapSceneFeatureStateValue>> {
  return new Map(Object.entries(byKey).map(([key, byFeature]) => [key, new Map(Object.entries(byFeature))]));
}

function statesScene(byKey: Record<string, Record<string, MapSceneFeatureStateValue>>): MapScene {
  return scene(
    [fillLayer("landcover-fill"), lineLayer("axis-line", "observedLine")],
    [roadsSource({ featureStates: featureStates(byKey) }), LANDCOVER_SOURCE],
  );
}

describe("applyMapScene", () => {
  it("中身だけが変わったソースは、作り直さずに差し替わる", () => {
    const { map, handle } = recordingMap();
    const before = scene([lineLayer("axis-line", "observedLine")]);
    applied(map, before);
    const roads = map.getSource("roads");

    const nextTiles = ["https://tiles.test/v2/{z}/{x}/{y}.pbf"];
    applied(
      map,
      scene(
        [lineLayer("axis-line", "observedLine")],
        [roadsSource({ content: tilesContent(nextTiles) }), LANDCOVER_SOURCE],
      ),
      before,
    );

    expect(map.getSource("roads")).toBe(roads);
    expect(handle.sourceContent("roads")?.tiles).toEqual(nextTiles);
  });

  it("作り直せない宣言が変わったソースは作り直され、レイヤーとfeature-stateも戻る", () => {
    const { map, handle } = recordingMap();
    const states = featureStates({ windValue: { w1: 3 } });
    const before = scene([lineLayer("axis-line", "observedLine")], [roadsSource({ featureStates: states })]);
    applied(map, before);
    const roads = map.getSource("roads");

    applied(
      map,
      scene(
        [lineLayer("axis-line", "observedLine")],
        [roadsSource({ spec: { type: "vector", maxzoom: 15 }, featureStates: states })],
      ),
      before,
    );

    expect(map.getSource("roads")).not.toBe(roads);
    expect(handle.sourceSpec("roads")).toEqual({ type: "vector", maxzoom: 15, tiles: ROAD_TILES });
    expect(handle.layer("axis-line")?.paint).toEqual({ "line-color": "#111111" });
    expect(roadStateOf(handle, "w1")).toEqual({ windValue: 3 });
  });

  it("1つのキーだけが消えても、同じソースに残る別のキーの値は消えない", () => {
    const { map, handle } = recordingMap();
    const before = statesScene({ windValue: { w1: 1, w2: 2 }, gradientValue: { w1: 5 } });
    applied(map, before);
    expect(roadStateOf(handle, "w1")).toEqual({ windValue: 1, gradientValue: 5 });
    expect(roadStateOf(handle, "w2")).toEqual({ windValue: 2 });

    applied(map, statesScene({ gradientValue: { w1: 5 } }), before);

    expect(roadStateOf(handle, "w1")).toEqual({ gradientValue: 5 });
    expect(roadStateOf(handle, "w2")).toEqual({});
  });

  it("feature-state が1つも残らないときだけ、ソース単位で消える", () => {
    const { map, handle } = recordingMap();
    const before = statesScene({ windValue: { w1: 1 }, gradientValue: { w2: 5 } });
    applied(map, before);

    applied(map, statesScene({}), before);

    expect(roadStateOf(handle, "w1")).toEqual({});
    expect(roadStateOf(handle, "w2")).toEqual({});
  });

  it("地図全体の状態だけが変わったら、変わった名前だけを置き直し、外した名前は値の無いことにし、他には触らない", () => {
    const { map, handle } = recordingMap();
    const before = { ...statesScene({ windValue: { w1: 1 } }), globalState: { bearing: 90, speed: 20 } };
    applied(map, before);
    const callsBefore = handle.trace.length;

    applied(map, { ...before, globalState: { bearing: 135.5 } }, before);

    expect(handle.trace.slice(callsBefore)).toEqual([
      { call: "setGlobalStateProperty", args: ["bearing", 135.5] },
      { call: "setGlobalStateProperty", args: ["speed", null] },
    ]);
  });

  it("スタイルを差し替えたあと作り直すと、地図全体の状態も置き直される", () => {
    const { map, handle } = recordingMap();
    const shown = { ...statesScene({}), globalState: { bearing: 90 } };
    applied(map, shown);

    handle.dropEverything();
    applied(map, shown, EMPTY_MAP_SCENE);

    expect(handle.globalState()).toEqual({ bearing: 90 });
  });
});
