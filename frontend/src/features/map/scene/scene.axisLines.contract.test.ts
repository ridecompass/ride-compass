// @vitest-environment node
/** 評価軸の線を塗る状態を地図へ伝えたとき、**最後にどうなっているか**。入口は`scene.state.contract.test.ts`と同じ
 * `sceneInputsFrom`→`buildMapScene`→`applyScene`の1本。
 */
import { describe, expect, it } from "vitest";

import { createRecordingMap } from "@/testing/mapTrace/recordingMap";
import { dedicatedEntry, MATERIAL_VALUE_FORMULA } from "@/testing/catalogAxes";
import { rebuild, roadLayerId, shown } from "@/testing/sceneContract";
import { dedicatedWayValueAxesFromCatalogAxes } from "@/lib/mapDisplay/axisLayers";
import { ROAD_LINE_SOURCE_ID } from "@/features/map/scene/groups/roadLines";
import { applyScene, sceneInputsFrom } from "@/features/map/scene/applyToMap";
import { sceneState } from "@/testing/sceneState";
import { buildMapScene } from "@/features/map/scene/buildScene";
import { mapDisplay } from "@/types/generated/mapDisplay";

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

    expect(handle.trace.slice(callsBefore)).toEqual([{ call: "setGlobalStateProperty", args: ["bearing_deg", 135.5] }]);
  });

  it("式の木の無い軸は、塗っていても周りの道の線を持たない", () => {
    const { map, handle } = createRecordingMap();
    rebuild(map, shown({ surface: true }, { paintedAxisId: "unformulated" }));

    expect(handle.layerOrder().filter((id) => id.includes("unformulated"))).toEqual([]);
  });

  it("塗っている軸は、その材料のレイヤーが出ている間だけ下敷きになる", () => {
    const dedicatedAxes = dedicatedWayValueAxesFromCatalogAxes([
      dedicatedEntry("paved", [50], {
        road_layer_ids: ["surface"],
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
