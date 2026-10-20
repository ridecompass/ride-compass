// 軸のアイコンの固定のパレット（軸自身の`icon_id`→アイコン）。軸の定義はキーを選ぶだけで、形を足すにはここへ1件足す
// （任意のSVGの登録は意匠の揃いと無害化の費用が高く、頭文字の自動生成は形で意味が伝わる性質を失う）。
// 知らない・未設定の`icon_id`は汎用のアイコンにする。

import type { MapIconComponent } from "@/components/ui/icons/icons";
import {
  AccidentDensityAxisIcon,
  AxisRampIcon,
  GradientAxisIcon,
  NightAxisIcon,
  StopDensityAxisIcon,
  SurfaceQualityAxisIcon,
} from "@/components/ui/icons/layerIcons";
import {
  ClockIcon,
  WarningTriangleIcon,
  LayersStackIcon,
  ShieldIcon,
  TargetIcon,
  ThermometerIcon,
  WindIcon,
} from "@/components/ui/icons/lucideIcons";

// キー（icon_id）は形の名前にし、軸idに紐付けない（同じ形を複数の軸が選べる）。
export const AXIS_ICON_PALETTE: Record<string, MapIconComponent> = {
  incline: GradientAxisIcon,
  wave: SurfaceQualityAxisIcon,
  "crescent-moon": NightAxisIcon,
  "density-stack": StopDensityAxisIcon,
  "density-scatter": AccidentDensityAxisIcon,
  "warning-triangle": WarningTriangleIcon,
  "wind-flow": WindIcon,
  thermometer: ThermometerIcon,
  shield: ShieldIcon,
  target: TargetIcon,
  clock: ClockIcon,
  layers: LayersStackIcon,
};

/** icon_idからアイコンコンポーネントを引く。未知/未設定はAxisRampIcon（汎用フォールバック）。 */
export function axisIconFor(iconId: string | null | undefined): MapIconComponent {
  if (iconId == null) return AxisRampIcon;
  return AXIS_ICON_PALETTE[iconId] ?? AxisRampIcon;
}
