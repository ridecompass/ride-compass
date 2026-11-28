// @vitest-environment node
/**
 * `applyMapScene.ts`——当て直すとき、ソースを差し替えるか作り直すか。
 *
 * ここで見ないもの: レイヤーの段の順・表示・絞り込み・paint → `applyMapScene.test.ts`
 */
import { describe, expect, it } from "vitest";

import {
  applied,
  LANDCOVER_SOURCE,
  lineLayer,
  recordingMap,
  ROAD_TILES,
  roadsSource,
  scene,
} from "@/testing/mapSceneDeclarations";
import { tilesContent } from "./sceneBuilders";

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

  it("作り直せない宣言が変わったソースは作り直され、レイヤーも戻る", () => {
    const { map, handle } = recordingMap();
    const before = scene([lineLayer("axis-line", "observedLine")], [roadsSource()]);
    applied(map, before);
    const roads = map.getSource("roads");

    applied(
      map,
      scene([lineLayer("axis-line", "observedLine")], [roadsSource({ spec: { type: "vector", maxzoom: 15 } })]),
      before,
    );

    expect(map.getSource("roads")).not.toBe(roads);
    expect(handle.sourceSpec("roads")).toEqual({ type: "vector", maxzoom: 15, tiles: ROAD_TILES });
    expect(handle.layer("axis-line")?.paint).toEqual({ "line-color": "#111111" });
  });
});
