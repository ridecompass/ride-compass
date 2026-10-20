// 地図・パネル・ヘッダーが共有するアイコンの土台と、このアプリ固有の操作・地点の形。天気・警告・操作のような
// 意味の決まった汎用の形はlucide-reactの同じ意味の形を使い（lucideIcons.tsx）、このアプリ固有の概念の形だけを
// 自前のSVGで持つ（レイヤーと評価軸の形はlayerIcons.tsx）。自前の形はlucideと同じ線画の様式（線の色は文字色・
// 丸い端・塗りなし基調）で描き、線の太さを表示の大きさに対する比でそろえる。
import type { ReactElement } from "react";

export interface IconProps {
  size?: number;
}

/** アイコン1つぶん。 */
export type MapIconComponent = (props: IconProps) => ReactElement;

const VIEWBOX_SIZE = 20;
const STROKE_WIDTH = 1.6;
/** lucideの形は24単位の枠で描かれているので、同じ比の太さへ直す。 */
export const LUCIDE_STROKE_WIDTH = (STROKE_WIDTH * 24) / VIEWBOX_SIZE;

// 線の色・太さ・端は親に置き、子は既定と違うときだけ書く（線を持たない形は`stroke="none"`）。
export const svgProps = {
  viewBox: `0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`,
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: STROKE_WIDTH,
  strokeLinecap: "round" as const,
  "aria-hidden": true as const,
};

/** 環境（地図チップ最上位グループ）: 標高（terrain）・降水/風/雷等（weather）をまとめて
 * 表す雲のシルエット。 */
export function EnvironmentDataIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path
        d="M6 15a3.3 3.3 0 0 1 .4-6.58A4.6 4.6 0 0 1 15.3 9.6 3 3 0 0 1 14.7 15H6Z"

        strokeLinejoin="round"
      />
    </svg>
  );
}

/** スポット（地図チップ最上位グループ）: 停止要因・補給・事故等の点データを
 * まとめて表す地図ピンのシルエット。 */
export function SpotDataIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path
        d="M10 18s6-6.7 6-11a6 6 0 0 0-12 0c0 4.3 6 11 6 11Z"

        strokeLinejoin="round"
        strokeLinecap="butt"
      />
      <circle cx="10" cy="7" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** ルート: 起点・終点のドットと曲がりくねった経路 */
export function RouteIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path
        d="M3.5 16c2.8-1 2.8-5.2 6-6s3.2-5.2 6-6"

        strokeDasharray="0.2 3"
      />
      <circle cx="3.5" cy="16" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="4" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** ルートを外れている: ルートの道なり（点線）が途中で切れ、先に×。 */
export function OffRouteIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M3.5 16c2.8-1 2.8-5.2 6-6" strokeDasharray="0.2 3" />
      <circle cx="3.5" cy="16" r="1.6" fill="currentColor" stroke="none" />
      <path d="M12 3.5l4.5 4.5M16.5 3.5L12 8" />
    </svg>
  );
}

/** ログ: 記録済みの行を表す簡易ターミナル/リスト */
export function LogIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <rect x="2" y="2.5" width="16" height="15" rx="2" strokeLinecap="butt" />
      <path d="M5 7h10M5 10.2h10M5 13.4h6" strokeWidth="1.4" />
    </svg>
  );
}

/** 区間の乗り換え: 2本の道が合流して1本になる形。「別の候補の道を取り込んで1本にする」
 * という操作そのものを絵にする（鉛筆の「編集」だと、どのルートの何を変えるのかが伝わらない）。
 * 分岐点・合流点に節を置き、取り込む側の道を太く描く。 */
export function RouteSpliceIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path
        d="M3 15.5c2.6 0 3.4-3 5-5.5s2.4-5.5 5-5.5"

        strokeWidth="1.2"

        opacity="0.55"
      />
      <path
        d="M3 15.5c2.6 0 4.6 0 6.2-2.2 1.6-2.2 2-8.8 4.6-8.8"

        strokeWidth="1.8"
      />
      <circle cx="3" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="13.8" cy="4.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 元と組み合わせ後を比べる: 天秤。`RouteSpliceIcon`（編集の入口）と並ぶため、
 * 道の形を持たない絵にして「経路そのものではなく、経路同士の比較」を表す。 */
export function RouteDiffIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M10 3v11M4.4 5.4h11.2M5.6 13.4h8.8" strokeWidth="1.4" />
      <path
        d="M4.4 5.4 2.2 10.2h4.4zM15.6 5.4 13.4 10.2h4.4z"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="butt"
      />
    </svg>
  );
}

/** 選んだ組み合わせで新しい候補を作る: 道＋追加。`RouteSpliceIcon`と同じ道の形へ
 * ＋を添えることで、同じ編集の中の「実行」であることを示す。 */
export function NewRouteIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M2.6 15.4c2.4 0 3.2-2.6 4.7-5s2.2-5 4.6-5" />
      <circle cx="2.6" cy="15.4" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="11.9" cy="5.4" r="1.4" fill="currentColor" stroke="none" />
      <path d="M15.4 11.4v5M12.9 13.9h5" />
    </svg>
  );
}

/** 直前の1手を戻す: 左へ回り込む矢印。 */
export function UndoIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M4.2 8.4h6.6a4.2 4.2 0 0 1 0 8.4H6.4" />
      <path d="M7.4 4.6 3.6 8.4l3.8 3.8" strokeLinejoin="round" />
    </svg>
  );
}

/** 全部戻す: 同じ矢印の行き止まりに壁を置く（＝これ以上は戻れない元の状態まで）。 */
export function UndoAllIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M6.6 8.4h5.2a4.2 4.2 0 0 1 0 8.4H8" />
      <path d="M9.4 4.6 5.8 8.4l3.6 3.8" strokeLinejoin="round" />
      <path d="M3.2 3.6v9.6" strokeWidth="1.8" />
    </svg>
  );
}

/** 全レイヤー一括OFF: 重なり（レイヤー）＋バツ。
 * 「表示」の一覧の末尾には「戻す」操作が複数並ぶため、バツは「消す」の意味だけに使い、
 * 何を消すのかは対象の形（重なり／漏斗）で示す——バツ単体だと対象を表せない。 */
export function ClearAllLayersIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M7.5 2.6 13.6 6 7.5 9.4 1.4 6 7.5 2.6Z" strokeLinejoin="round" strokeLinecap="butt" />
      <path d="M1.4 9.6 7.5 13" />
      <path d="M12.4 12.4 17.6 17.6M17.6 12.4 12.4 17.6" />
    </svg>
  );
}

/** 絞り込み一括クリア: 漏斗＋バツ。レイヤーは出したまま、隠していた項目を戻す操作
 * （ClearAllLayersIconとは対象が違う。上記参照）。 */
export function ClearAllFiltersIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M1.8 3.4h11.4L8.9 8.3v4.4L6.1 14V8.3L1.8 3.4Z" strokeLinejoin="round" strokeLinecap="butt" />
      <path d="M12.4 12.4 17.6 17.6M17.6 12.4 12.4 17.6" />
    </svg>
  );
}

/** 地図に出す情報を選ぶ（「表示」のボタン）: 中抜きのつまみが付いた横線2本。RouteSettingsIcon（短い縦線のつまみが3つ）とは、つまみの形と本数で見分ける。 */
export function DisplayItemsIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M3 6.5h4.7M12.3 6.5H17M3 13.5h1.2M8.8 13.5H17" />
      <circle cx="10" cy="6.5" r="2.3" />
      <circle cx="6.5" cy="13.5" r="2.3" />
    </svg>
  );
}

/** 出発地の印: 竿に、塗った旗。目的地の`GoalFlagIcon`と竿をそろえ、旗の模様だけで見分ける。 */
export function StartFlagIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M4 18V2.5" />
      <path d="M4 3h11.5l-2.8 3.75L15.5 10.5H4Z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

/** 目的地の印: 竿に、市松の旗（ゴールの旗）。 */
export function GoalFlagIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M4 18V2.5" />
      <rect x="4" y="3" width="12" height="7.5" strokeLinejoin="round" />
      <path
        d="M4 3h3v2.5H4ZM10 3h3v2.5h-3ZM7 5.5h3V8H7ZM13 5.5h3V8h-3ZM4 8h3v2.5H4ZM10 8h3v2.5h-3Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

/** 周回（終点を出発地にする）: 角の丸い横長の輪と、左下の塗った起点の点・右上の進む向きの矢じり。 */
export function LoopRouteIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M6 6h8a4 4 0 0 1 0 8H6a4 4 0 0 1 0-8Z" />
      <circle cx="6" cy="14" r="1.8" fill="currentColor" stroke="none" />
      <path d="M12.5 4 14.5 6 12.5 8" strokeLinejoin="round" />
    </svg>
  );
}

/** 現在地（現在地へ移動）: 照準の輪と、塗った中心の点。lucideの`LocateFixed`は中心が輪で、
 * 行頭の印の大きさ（13px）では点に見えない。この形だけ24単位の枠で描く。 */
export function LocateIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps} viewBox="0 0 24 24" strokeWidth={LUCIDE_STROKE_WIDTH}>
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z" />
    </svg>
  );
}

// 走行モードの倍率の段ごとの、ファインダーの角の中心からの距離。
const FINDER_HALF_SIZE = { near: 4, middle: 6, far: 8.5 } as const;
const FINDER_ARM = 2.5;

/** 走行モードの倍率の段: 現在地の点を囲むファインダーの角。角が外ほど遠くまで見える。 */
export function RideZoomIcon({ size = 16, reach }: IconProps & { reach: keyof typeof FINDER_HALF_SIZE }) {
  const h = FINDER_HALF_SIZE[reach];
  const [lo, hi] = [10 - h, 10 + h];
  return (
    <svg width={size} height={size} {...svgProps} strokeLinejoin="round">
      <path
        d={`M${lo} ${lo + FINDER_ARM}V${lo}h${FINDER_ARM}M${hi - FINDER_ARM} ${lo}H${hi}v${FINDER_ARM}M${hi} ${hi - FINDER_ARM}V${hi}h${-FINDER_ARM}M${lo + FINDER_ARM} ${hi}H${lo}v${-FINDER_ARM}`}
      />
      <circle cx="10" cy="10" r="1.6" fill="var(--color-accent)" stroke="none" />
    </svg>
  );
}

/** 方位磁針の針: 赤い先が北（上）、灰色の先が南。地図の向きのぶん回して使う。 */
export function CompassNeedleIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps} stroke="none">
      <path d="M10 2 13 10H7Z" fill="var(--color-danger)" />
      <path d="M10 18 7 10h6Z" fill="var(--color-muted)" />
    </svg>
  );
}

/** 走行中の曲がる所の案内: Uターン。上へ進んで折り返し、下へ戻る矢印。 */
export function UTurnIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...svgProps}>
      <path d="M13.5 17V7.5a3.5 3.5 0 0 0-7 0V13" strokeLinejoin="round" />
      <path d="M3.5 10.5 6.5 13.5 9.5 10.5" strokeLinejoin="round" />
    </svg>
  );
}
