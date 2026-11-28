// @vitest-environment node
/** レンズの線を塗る状態を地図へ伝えたとき、**最後にどうなっているか**。入口は`scene.state.contract.test.ts`と同じ
 * `sceneInputsFrom`→`buildMapScene`→`applyScene`の1本。
 */
import { describe, expect, it } from "vitest";

import { createRecordingMap } from "@/testing/mapTrace/recordingMap";
import { rebuild, roadLayerId, shown } from "@/testing/sceneContract";
import { ROAD_LINE_SOURCE_ID } from "@/features/map/scene/groups/roadLines";
import { applyScene } from "@/features/map/scene/applyToMap";
import { sceneInputsFrom } from "@/features/map/scene/sceneInputs";
import { buildMapScene } from "@/features/map/scene/buildScene";

describe("レンズの線", () => {
  const fetched = (byLens: Record<string, Record<string, Record<string, number>>>) =>
    new Map(Object.entries(byLens).map(([lensId, byWay]) => [lensId, { materials: new Map(Object.entries(byWay)) }]));
  const MATERIALS = fetched({ ascent: { w1: { lens_along: 3 } }, vibration: { w1: { lens_along: 7 } } });

  it("取った材料から求めた道の値が、道路のソースの地物へレンズごとに1つずつ載り、塗っているレンズの線が見える", () => {
    const { map, handle } = createRecordingMap();
    rebuild(map, shown({ surface: true }, { lens: "ascent", wayMaterials: MATERIALS }));

    expect(Object.keys(handle.featureState(ROAD_LINE_SOURCE_ID, "w1") ?? {}).sort()).toEqual([
      "ascent:value",
      "vibration:value",
    ]);
    expect(handle.layer(roadLayerId("ascent"))?.visibility).toBe("visible");
    expect(handle.layer(roadLayerId("vibration"))?.visibility).toBe("none");
  });

  it("走る条件だけを変えると、道の値だけを置き直し、レイヤーは当て直さない", () => {
    const { map, handle } = createRecordingMap();
    const look = { lens: "ascent", wayMaterials: MATERIALS };
    rebuild(map, shown({ surface: true }, { ...look, wayConditions: { bearing_deg: 0, speed_kmh: 20 } }));
    const callsBefore = handle.trace.length;

    applyScene(
      map as never,
      buildMapScene(
        sceneInputsFrom(shown({ surface: true }, { ...look, wayConditions: { bearing_deg: 135.5, speed_kmh: 20 } })),
      ),
    );

    expect(handle.trace.slice(callsBefore).filter(({ call }) => call !== "setFeatureState")).toEqual([]);
  });
});
