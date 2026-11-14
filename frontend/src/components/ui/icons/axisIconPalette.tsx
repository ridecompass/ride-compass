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
  StopPoiIcon,
  SurfaceQualityAxisIcon,
} from "@/components/ui/icons/layerIcons";
import {
  MountainIcon,
  RoadIcon,
  SigmaIcon,
  ClockIcon,
  WarningTriangleIcon,
  LayersStackIcon,
  ShieldIcon,
  TargetIcon,
  ThermometerIcon,
  WindIcon,
} from "@/components/ui/icons/lucideIcons";

// キー（icon_id）は形の名前にし、軸idに紐付けない（同じ形を複数の軸が選べる）。
const AXIS_ICON_PALETTE: Record<string, MapIconComponent> = {
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
  mountain: MountainIcon,
  wind: WindIcon,
  "traffic-light": StopPoiIcon,
  road: RoadIcon,
  vibration: SurfaceQualityAxisIcon,
  sum: SigmaIcon,
};

export function axisIconFor(iconId: string | null | undefined): MapIconComponent {
  return AXIS_ICON_PALETTE[iconId ?? ""] ?? AxisRampIcon;
}

function axisIcon(iconId: string | null, size: number) {
  const Icon = axisIconFor(iconId);
  return <Icon size={size} />;
}

/** 軸の絵（`color`があれば軸の色で塗る）。名前を画面に出さない所は`label`を渡し、読み上げにだけ出す。 */
export function AxisMark({
  iconId,
  label,
  color,
  size = 14,
}: {
  iconId: string | null;
  label?: string;
  color?: string;
  size?: number;
}) {
  return (
    <span className="inline-flex flex-none" style={color === undefined ? undefined : { color }}>
      {axisIcon(iconId, size)}
      {label !== undefined && <span className="sr-only">{label}</span>}
    </span>
  );
}
