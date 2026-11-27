// @vitest-environment node
/**
 * `mapScene.ts`——場の宣言から、地図へ渡す押せるレイヤーの一覧を導くこと。
 *
 * ここで見ないもの: 宣言したレイヤーが地図に載る順 → `applyMapScene.test.ts`
 */
import { describe, expect, it } from "vitest";

import { fillLayer, lineLayer, scene } from "@/testing/mapSceneDeclarations";

import { interactiveSceneLayerIds } from "./mapScene";

describe("interactiveSceneLayerIds", () => {
  it("押せるレイヤーの一覧は、当たり判定の宣言から段の順で導ける", () => {
    const shuffled = scene([
      lineLayer("route", "route", { hitTargets: ["routeSegment"] }),
      lineLayer("poi", "point", { hitTargets: ["poi"] }),
      lineLayer("lens-line", "lensLine"),
      lineLayer("surface-line", "observedLine", { hitTargets: ["road"] }),
      fillLayer("landcover-fill"),
    ]);

    expect(interactiveSceneLayerIds(shuffled)).toEqual(["surface-line", "poi", "route"]);
  });
});
