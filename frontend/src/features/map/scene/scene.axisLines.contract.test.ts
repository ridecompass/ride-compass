// @vitest-environment node
/** レンズの線を塗る状態を地図へ伝えたとき、**最後にどうなっているか**。入口は`scene.state.contract.test.ts`と同じ
 * `sceneInputsFrom`→`buildMapScene`→`applyScene`の1本。
 */
import { describe, expect, it } from "vitest";

import { createRecordingMap } from "@/testing/mapTrace/recordingMap";
import { rebuild, shown } from "@/testing/sceneContract";
import { LENS_SOURCE_ID } from "@/features/map/scene/groups/axisLines";
import { applyScene } from "@/features/map/scene/applyToMap";
import { sceneInputsFrom } from "@/features/map/scene/sceneInputs";
import { buildMapScene } from "@/features/map/scene/buildScene";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";

describe("レンズの線", () => {
  const LOOK = { lens: "ascent", lensTileUrl: "https://tiles.test/api/region/lens-tiles/ascent/{z}/{x}/{y}.pbf" };

  it("塗っているレンズのタイルを読み、その線だけが載る。タイルを取れない間は載らない", () => {
    const { map, handle } = createRecordingMap();
    rebuild(map, shown({ surface: true }, LOOK));

    expect(handle.sourceContent(LENS_SOURCE_ID)?.tiles).toEqual([LOOK.lensTileUrl]);
    expect(handle.layer(sceneLayerId(LENS_SOURCE_ID, "ascent"))?.visibility).toBe("visible");
    expect(handle.layer(sceneLayerId(LENS_SOURCE_ID, "vibration"))).toBeUndefined();

    applyScene(map as never, buildMapScene(sceneInputsFrom(shown({ surface: true }, { ...LOOK, lensTileUrl: null }))));

    expect(handle.sources()).not.toContain(LENS_SOURCE_ID);
  });

  it("走る条件だけを変えても、タイルを取り直さない", () => {
    const { map, handle } = createRecordingMap();
    rebuild(map, shown({ surface: true }, { ...LOOK, wayConditions: { bearing_deg: 0, speed_kmh: 20 } }));
    const callsBefore = handle.trace.length;

    applyScene(
      map as never,
      buildMapScene(
        sceneInputsFrom(shown({ surface: true }, { ...LOOK, wayConditions: { bearing_deg: 135.5, speed_kmh: 20 } })),
      ),
    );

    // 条件を読む式の当て直し（塗りと絞り込み）のほかは、地図に何もしない。
    expect(
      handle.trace.slice(callsBefore).filter(({ call }) => call !== "setPaintProperty" && call !== "setFilter"),
    ).toEqual([]);
  });
});
