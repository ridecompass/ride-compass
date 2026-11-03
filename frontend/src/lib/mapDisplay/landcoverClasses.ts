// 土地被覆のクラス（表示名・色・割合列）。生成物の並びのまま使う（割合が同率のときの並びがこれで決まる）。

import landcoverClassesJson from "@/types/generated/landcover-classes.json";

interface LandcoverClass {
  /** 区間インスペクタの土地被覆（`InspectorValues.landcover`）の対応する割合列の名前。 */
  percentField: string;
  label: string;
  color: string;
  /** 凡例の行の（i）から開く説明。 */
  description: string;
  /** 地図の面レイヤーで塗るか。falseでも区間インスペクタの割合には出る。 */
  painted: boolean;
}

export const LANDCOVER_CLASSES: readonly LandcoverClass[] = landcoverClassesJson.map((cls) => ({
  percentField: cls.percent_field,
  label: cls.label,
  color: cls.color,
  description: cls.description,
  painted: cls.painted,
}));

/** 地図の面レイヤーに実際に出るクラス。凡例はこちらを使う——塗らないクラスを凡例へ
 * 並べると、色見本があるのに地図のどこにも無い、という読み方のできない表になる。 */
export const LANDCOVER_PAINTED_CLASSES: readonly LandcoverClass[] = LANDCOVER_CLASSES.filter((cls) => cls.painted);
