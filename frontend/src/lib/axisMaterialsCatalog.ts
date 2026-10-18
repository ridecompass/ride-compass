// 軸スタジオが扱う材料の一覧と、材料idを表示へ変える関数。
// 一覧はbackendの材料の宣言をビルド時に書き出した生成物から作る（材料はコードで決まり、
// 再デプロイでしか変わらない）。実行時に取りに行かないので、読み込み中も取得失敗も無い。

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
