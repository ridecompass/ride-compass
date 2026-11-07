// sceneの契約テスト（`features/map/scene/scene.*.contract.test.ts`）が、本番と同じ入口
// （`sceneInputsFrom`→`buildMapScene`→`applyScene`）で地図へ伝えるためのレンズ・道の線の層と道具。
import { applyScene, sceneInputsFrom } from "@/features/map/scene/applyToMap";
import { buildMapScene } from "@/features/map/scene/buildScene";
import { ROAD_LINE_SOURCE_ID } from "@/features/map/scene/groups/roadLines";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import { roadClass, roadMapLayer } from "@/testing/clientConfig";
import { mapCatalogFor } from "@/testing/mapCatalog";
import { sceneState, type SceneState, type SceneStateOverrides } from "@/testing/sceneState";

/** 総合と費用の軸2本（`testing/costAxes.ts: TWO_COST_AXES`）のレンズ。 */
export const LENSES = mapCatalogFor().lenses;

// 道の線の層はテストが組む（本番の区分は管理DBが持つ）。絞り込みの式も検証の対象にするため、どの層も区分の条件を持つ。
export const ROAD_LAYERS = ["surface", "highway"].map((id) =>
  roadMapLayer(id, {
    has_no_data: true,
    classes: [roadClass("first")],
  }),
);

export const CATALOG = { lenses: LENSES, roadLayers: ROAD_LAYERS };

/** 表示ONのレイヤーだけを持つ状態。 */
export function shown(layerVisibility: Record<string, boolean>, look: SceneStateOverrides["look"] = {}) {
  return sceneState({ catalog: CATALOG, look: { ...look, layerVisibility } });
}

// レイヤーidは**ソース名＋役割**で決まる。綴りは`sceneLayerId`からしか作らない
// ——ここで組み立て直すと、規則を変えたときテストだけが古い綴りのまま残る。
export const roadLayerId = (role: string) => sceneLayerId(ROAD_LINE_SOURCE_ID, role);

/** 空から作り直す経路（スタイルを差し替えた後に通るのはこちら）。 */
export function rebuild(map: unknown, state: SceneState) {
  applyScene(map as never, buildMapScene(sceneInputsFrom(state)), { reset: true });
}
