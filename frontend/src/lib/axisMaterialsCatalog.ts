// 軸スタジオが扱う材料の一覧と、材料idを表示へ変える関数。
// 一覧はbackendがコードで宣言した材料をビルド時に書き出した生成物から作る。実行時に取りに行かないので、
// 読み込み中も取得失敗も無い。道の区分から作る材料（`class:<分け方>`）は管理DBで実行時に決まり、一覧に無い。

import materialCatalog from "@/types/generated/material-catalog.json";

interface AxisMaterialOption {
  id: string;
  /** 「論理名 - 物理名」形式（例: "道路種別 - highway"）。 */
  label: string;
}

/** 材料の一覧（backendの`MATERIAL_CATALOG`の登録順）。 */
export const MATERIAL_CATALOG: readonly AxisMaterialOption[] = materialCatalog.map((material) => ({
  id: material.material_id,
  label: material.label,
}));

/** 軸スタジオ（管理画面）に出す材料名（「論理名 - 物理名」）。物理名を見せるのが目的の
 * 画面なので、カタログに無いidはidのまま返す。一般向けの画面では使わない。 */
export function materialCatalogLabel(materialId: string): string {
  return MATERIAL_CATALOG.find((m) => m.id === materialId)?.label ?? materialId;
}
