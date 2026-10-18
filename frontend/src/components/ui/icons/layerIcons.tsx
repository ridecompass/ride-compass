// 地図のレイヤーと評価軸の、このアプリ固有の形（自前のSVG）。
import { svgProps, type IconProps } from "./icons";

/** 標高図: 色別標高図のイメージに合わせた山並みのシルエット */
export function ElevationIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path
        d="M1.5 15.5 6 8l3 3.5 2.5-4 5.5 8H1.5Z"

        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 起伏（陰影）: 同じ山並みの片斜面だけに陰が乗った形。ElevationIcon（輪郭だけの山並み＝
 * 標高そのもの）と対にして、「塗るのは斜面だけ」を形で示す。 */
export function HillshadeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M1.5 15.5 6 8l3 3.5 2.5-4 5.5 8H1.5Z" fill="currentColor" opacity="0.28" stroke="none" />
      <path
        d="M1.5 15.5 6 8l3 3.5 2.5-4 5.5 8H1.5Z"

        strokeLinejoin="round"
      />
      <path d="M6 8 1.5 15.5h4.7Z" fill="currentColor" stroke="none" />
      <path d="M11.5 7.5 9 11.5h5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 土地被覆: 用途の違う区画が並ぶ様子を表す、大きさの違う4区画 */
export function LandcoverIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1" strokeWidth="1.4" strokeLinecap="butt" />
      <rect x="11" y="2.5" width="6.5" height="4" rx="1" strokeWidth="1.4" strokeLinecap="butt" />
      <rect x="2.5" y="11" width="4" height="6.5" rx="1" strokeWidth="1.4" strokeLinecap="butt" />
      <rect x="8.5" y="8.5" width="9" height="9" rx="1" strokeWidth="1.4" strokeLinecap="butt" />
    </svg>
  );
}

/** 評価軸の汎用のアイコン: 密度の濃淡を表す棒グラフ。各軸は`icon_id`
 * （軸自身のデータ）でaxisIconPalette.tsxの固定パレットから専用アイコンを選べる。
 * この汎用形はicon_id未設定の軸向けのフォールバックとして残す。 */
export function AxisRampIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M3.5 16.5v-4M8 16.5v-7M12.5 16.5V6M17 16.5V3.5" />
    </svg>
  );
}

/** 勾配（推定軸）: 地面から立ち上がる傾斜線+矢頭。標高図（ElevationIcon、山並みの
 * シルエット）は生の標高そのものを表すのに対し、こちらは傾き（変化率）という別概念を表す
 * ため意匠を分ける。 */
export function GradientAxisIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M2.5 16.5h15" />
      <path d="M3.5 16.5 13.5 5.5" />
      <path d="M9.5 5.5h4v4" strokeLinejoin="round" />
    </svg>
  );
}

/** 舗装質（推定軸）: 路面の滑らかさ/粗さを表す波線。路面の種類（RoadSurfaceIcon、材質の
 * テクスチャを表す帯+点）は観測データ（種別の分類）、こちらは推定指標（質のスコア）という
 * 別概念を表すため意匠を分ける。 */
export function SurfaceQualityAxisIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path
        d="M2 14c1.8-3.4 3.6-3.4 5.4 0s3.6 3.4 5.4 0 3.6-3.4 5.4 0"

        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 夜間（推定軸）: 三日月のシルエット */
export function NightAxisIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M17.5 10.66A7.5 7.5 0 1 1 9.34 2.5 5.83 5.83 0 0 0 17.5 10.66Z" strokeLinejoin="round" />
    </svg>
  );
}

/** 停止密度（推定軸）: 縦に積み重なり下ほど大きくなる点で、停止要因の集積を表す。
 * 停止要因（StopPoiIcon、信号機のシルエット）は観測データ（個々の要因の種類）、こちらは
 * 推定指標（密度）という別概念を表すため意匠を分ける。 */
export function StopDensityAxisIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <circle cx="10" cy="4.6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9.6" r="1.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="15.4" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 事故密度（推定軸）: 大小不揃いに散らばる点の集まりで、集積（ヒートマップ）を表す。
 * 事故（AccidentIcon、単一の衝突バースト）は観測データ（個々の事故地点）、こちらは
 * 推定指標（密度）という別概念を表すため意匠を分ける。停止密度（StopDensityAxisIcon）とは
 * 縦一列の整列 vs 不規則な散らばりで区別する。 */
export function AccidentDensityAxisIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <circle cx="5.5" cy="13.5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="11" cy="7" r="2.3" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="14.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="8" cy="16.3" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 道路の種類（「道路情報」から論理分割した1軸）: 消失点へ向かう道路と車線の破線 */
export function RoadIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M7 2 3 18M13 2l4 16" />
      <path d="M10 5v2M10 9.3v2M10 13.6v2" />
    </svg>
  );
}

/** 路面の種類（「道路情報」から論理分割した1軸）: 材質のテクスチャを表す帯+点の並び */
export function RoadSurfaceIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <rect x="2.5" y="6" width="15" height="8" rx="1.5" strokeWidth="1.4" strokeLinecap="butt" />
      <circle cx="6" cy="8.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="11.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14" cy="8.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="11.6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="14" cy="11.6" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 農道・林道の等級: 轍の2本線と、その間に生えた草。路面の種類（RoadSurfaceIcon）とは別のタグの話なので意匠を分ける */
export function TrackGradeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M6.5 2 4 18M13.5 2 16 18" />
      <path d="M9 15.5l1-2.5 1 2.5M9.4 9l.6-1.6.6 1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function TunnelIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M3 17V9a7 7 0 0 1 14 0v8" strokeLinejoin="round" />
      <path d="M3 17h14" />
    </svg>
  );
}

/** 一方通行（一次属性、OSM onewayタグ）: 一方向の矢印 */
export function OnewayIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M3 10h13" />
      <path d="M12 5.5 17 10l-5 4.5" strokeLinejoin="round" />
    </svg>
  );
}

/** 事故: 衝突を示す星形バースト */
export function AccidentIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M10 1.5v5M10 13.5v5M1.5 10h5M13.5 10h5M4 4l3.5 3.5M16 4l-3.5 3.5M4 16l3.5-3.5M16 16l-3.5-3.5" />
      <circle cx="10" cy="10" r="2.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 停止要因: 信号機のシルエット（3灯） */
export function StopPoiIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <rect x="7" y="2" width="6" height="13" rx="2" strokeWidth="1.5" strokeLinecap="butt" />
      <circle cx="10" cy="5.3" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="11.7" r="1" fill="currentColor" stroke="none" />
      <path d="M10 15v3" strokeWidth="1.5" />
    </svg>
  );
}

/** 補給・休憩ポイント: 買い物袋のシルエット */
export function SupplyPoiIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path
        d="M5 7h10l-1 10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 7Z"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="butt"
      />
      <path d="M7.5 7V5a2.5 2.5 0 0 1 5 0v2" strokeWidth="1.5" />
    </svg>
  );
}

/** 立ち寄り先: 旗を立てた地点 */
export function StopPlaceIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M6 18V3" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6 4h8l-1.5 3L14 10H6" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M3 18h6" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
