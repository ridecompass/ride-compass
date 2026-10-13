import { GoalFlagIcon, StartFlagIcon } from "@/components/ui/icons/icons";
import palette from "@/types/generated/palette.json";
import type { PinRole } from "@/types/route";

// 地点（出発地・経由地・目的地）の印。**地図のピンと、ルート設定パネルの地点の印は同じ図形**
// ——パネルとピンが同じものを指していることを、色と形だけで読めるようにする。外形はどの役割も同じ面の色の丸で、
// 役割は中の記号（出発地はスタートの旗・経由地は番号・目的地はゴールの旗）と、その色で見分ける。

/** 印の丸の面。テーマに従う（ダークなら暗い台）ので、配信された1つの値ではなくCSSのトークンを読む（`lib/paletteCssVariables.ts`の決まり）。 */
export const PIN_MARK_BACKGROUND = "var(--color-surface)";

/** 印の記号の色（役割ごと）。 */
export const PIN_MARK_COLOR: Record<PinRole, string> = {
  origin: palette.semantic.pin_origin,
  waypoint: palette.semantic.pin_waypoint,
  destination: palette.semantic.pin_destination,
};

/** 出発地の印の色（位置が未取得の間は灰色にする）。 */
export const ORIGIN_MARK_FALLBACK_COLOR = palette.semantic.pin_origin_unresolved;

/** 出発地の印の色を、位置が取れているかで選ぶ（パネルの印と地図のピンが同じ色になるように1か所で決める）。 */
export function originMarkColor(located: boolean): string {
  return located ? PIN_MARK_COLOR.origin : ORIGIN_MARK_FALLBACK_COLOR;
}

/** 印が指す地点の名前（地図のピンの読み上げ名）。経由地は訪問の順の番号を添える。 */
export function pinMarkName(role: PinRole, label?: string): string {
  if (role === "origin") return "出発地";
  if (role === "destination") return "目的地";
  return `経由地 ${label ?? ""}`.trim();
}

interface PinMarkProps {
  role: PinRole;
  /** 経由地の中に出す番号（地図もパネルも訪問の順）。 */
  label?: string;
  /** 記号の大きさ（px）。 */
  size: number;
  /** 出発地の記号の色（位置が取れていない間の灰色を渡す）。ほかの役割は役割の色。 */
  originColor?: string;
}

/** 印の中身（丸の中の記号）。パネルの地点と、地図のピン（Markerの要素へportalで差し込む）が使う。 */
export function PinMark({ role, label, size, originColor = PIN_MARK_COLOR.origin }: PinMarkProps) {
  const color = role === "origin" ? originColor : PIN_MARK_COLOR[role];
  return (
    <span
      className="inline-flex items-center justify-center leading-none font-bold"
      style={{ color, fontSize: `${Math.round(size * 0.8)}px` }}
    >
      {role === "origin" ? (
        <StartFlagIcon size={size} />
      ) : role === "destination" ? (
        <GoalFlagIcon size={size} />
      ) : (
        label
      )}
    </span>
  );
}
