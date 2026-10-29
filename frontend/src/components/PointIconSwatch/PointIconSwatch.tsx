// 地図の点の見本。点の絵の形の宣言を持ち、地図へ登録する画素（`features/map/layers/pointIcon.ts: drawPointIcon`）とここの見本は
// 同じ宣言を読む——別々に描くと、見本と地図の絵が食い違う。地図の凡例と地図の小窓の施設の行（別の機能）が同じ見本を出すので、
// 共有の層に置く。

import { cn } from "@/lib/cn";
import { LEGEND_SWATCH_RING_CLASS, type PointGlyph } from "@/lib/mapDisplay/legendFilter";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

/** 形を書く座標の一辺（SVGのviewBoxと同じ単位）。画面での大きさは源泉の`iconSizePx`が決める。 */
export const FRAME = 24;
const BOX_PATH = "M6 1h12a5 5 0 0 1 5 5v12a5 5 0 0 1-5 5H6a5 5 0 0 1-5-5V6a5 5 0 0 1 5-5Z";
const circle = (x: number, y: number, r: number) =>
  `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
/** 線の絵の枠。押せる点（名前のある点）は角丸の四角、押せない点（名前の無い点）は丸——枠の形で押せるかを、絵記号で何の点かを表す。
 * 標識の絵は枠を持たない。 */
export type PointFrame = "box" | "circle";
const FRAME_PATHS: Record<PointFrame, string> = {
  box: BOX_PATH,
  circle: circle(12, 12, 11),
};
/** 枠の縁取りの画面上の太さは源泉が決める。 */
const BOX_STROKE = (mapDisplay.point.strokeWidthPx * FRAME) / mapDisplay.point.iconSizePx;
/** 線の絵は枠の内側へ縮めて載せる。 */
const GLYPH_SCALE = 0.7;
const GLYPH_OFFSET = (FRAME * (1 - GLYPH_SCALE)) / 2;
const GLYPH_STROKE = 2;
/** 標識の絵の字の字体と太さ。端末の日本語の字体で描く（地図の字の置き場の字体は、絵へ焼く canvas から使えない）。 */
export const SIGN_FONT_FAMILY = "sans-serif";
export const SIGN_FONT_WEIGHT = 900;

/** 点の絵の部品（`FRAME`の座標）。形は塗り・線の色を持ち、`at`（[x, y, 倍率]）で動かして縮めて載せる。字は`x`・`y`を中心に置く。 */
export type IconPart =
  | {
      readonly d: string;
      readonly fill?: string;
      readonly stroke?: string;
      readonly width?: number;
      readonly at?: readonly [number, number, number];
    }
  | { readonly text: string; readonly x: number; readonly y: number; readonly size: number; readonly fill: string };

/** 点の絵の形。線の絵は行の色の枠に白い線で載せ、標識の絵は色を持つ部品を順に描く（枠も行の色も使わない）。名前を持たない層
 * （押せない点だけの層）の絵は標識の絵で、日本の道路標識・信号機に似せて何の点かを直感的に読ませる。 */
type PointGlyphShape = { readonly line: string } | { readonly sign: readonly IconPart[] };

const SIGN = palette.semantic;
const DOWN_TRIANGLE = "M1.2 2.4H22.8L12 22.8Z";
const DIAMOND = "M12 0.6L23.4 12L12 23.4L0.6 12Z";
const STAR =
  "M12 0.24L14.85 5.13L20.32 3.68L18.87 9.15L23.76 12L18.87 14.85L20.32 20.32L14.85 18.87L12 23.76L9.15 18.87" +
  "L3.68 20.32L5.13 14.85L0.24 12L5.13 9.15L3.68 3.68L9.15 5.13Z";
const BICYCLE =
  "M2.5 17a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0 M14.5 17a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0 M6 17l3.5-8h6l2.5 8 M9.5 9l3 8H6 M14 6h2.5";

/** 点の絵（絵記号の名前 → 形）。 */
export const POINT_GLYPHS: Record<PointGlyph, PointGlyphShape> = {
  bag: { line: "M6 9h12l-1 11H7Z M9 9V7.5a3 3 0 0 1 6 0V9" },
  bottle: { line: "M10 3h4 M10.5 3v3.5l-2 3V20a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V9.5l-2-3V3 M8.5 13h7" },
  question: { line: "M9 9a3 3 0 1 1 4.2 2.75c-.75.33-1.2 1-1.2 1.8V15 M12 19h.01" },
  toilet: { line: "M2.5 8l1.75 8L7 10l2.75 6L11.5 8 M21 9.5a4 4 0 1 0 0 5" },
  drop: { line: "M12 3c-3 4.5-6 7.5-6 11a6 6 0 0 0 12 0c0-3.5-3-6.5-6-11Z" },
  parking: { line: "M9 19V5h4.5a4 4 0 0 1 0 8H9" },
  cup: { line: "M5 8h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Z M16 10h1.5a2.5 2.5 0 0 1 0 5H16 M5 21h11" },
  steam: {
    line: "M4 14h16v2a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z M8 11c-1-1.5 1-2.5 0-4.5 M12 11c-1-1.5 1-2.5 0-4.5 M16 11c-1-1.5 1-2.5 0-4.5",
  },
  wrench: { line: "M14.5 4.5a4 4 0 0 0-5 5L4 15l2.5 2.5L12 12a4 4 0 0 0 5-5l-2.5 2.5-2-2Z" },
  mountain: { line: "M2.5 19L9 8l4 6.5L15.5 11l6 8Z" },
  bed: { line: "M3 7v12 M3 15h18v4 M21 15v-3a3 3 0 0 0-3-3h-7v6 M7 12h.01" },
  gate: { line: "M3 6c6 1 12 1 18 0 M5 10h14 M7 6.5V21 M17 6.5V21" },
  // 横長の信号機（青・黄・赤）。
  signal: {
    sign: [
      {
        d: "M4.2 6h15.6a3.6 3.6 0 0 1 3.6 3.6v4.8a3.6 3.6 0 0 1-3.6 3.6H4.2a3.6 3.6 0 0 1-3.6-3.6V9.6A3.6 3.6 0 0 1 4.2 6Z",
        fill: SIGN.sign_ink,
        stroke: SIGN.sign_face,
        width: 1.2,
      },
      { d: circle(5.4, 12, 2.9), fill: SIGN.signal_go },
      { d: circle(12, 12, 2.9), fill: SIGN.signal_caution },
      { d: circle(18.6, 12, 2.9), fill: SIGN.signal_stop },
    ],
  },
  // 青い四角に白い縞（横断歩道の指示標識）。
  crosswalk: {
    sign: [
      {
        d: "M4.8 1.2h14.4a3.6 3.6 0 0 1 3.6 3.6v14.4a3.6 3.6 0 0 1-3.6 3.6H4.8a3.6 3.6 0 0 1-3.6-3.6V4.8a3.6 3.6 0 0 1 3.6-3.6Z",
        fill: SIGN.sign_instruction,
        stroke: SIGN.sign_face,
        width: 1.2,
      },
      {
        d: "M4.2 6h2.4v12H4.2Z M8.52 6h2.4v12h-2.4Z M12.84 6h2.4v12h-2.4Z M17.16 6h2.4v12h-2.4Z",
        fill: SIGN.sign_face,
      },
    ],
  },
  // 赤い逆三角に「止」（一時停止の規制標識）。
  stop_sign: {
    sign: [
      { d: DOWN_TRIANGLE, fill: SIGN.sign_regulatory, stroke: SIGN.sign_face, width: 1.4 },
      { text: "止", x: 12, y: 9.4, size: 10.2, fill: SIGN.sign_face },
    ],
  },
  // 赤い縁の白い逆三角に「徐」（徐行の規制標識）。
  yield: {
    sign: [
      { d: DOWN_TRIANGLE, fill: SIGN.sign_face, stroke: SIGN.sign_regulatory, width: 2.6 },
      { text: "徐", x: 12, y: 9, size: 9.6, fill: SIGN.sign_regulatory_text },
    ],
  },
  // 黄色いひし形に汽車（踏切ありの警戒標識）。
  railway: {
    sign: [
      { d: DIAMOND, fill: SIGN.sign_warning, stroke: SIGN.sign_ink, width: 1.3 },
      { d: "M6 9.6h10.8V15H6Z M13.8 6.6h3v3.6h-3Z M7.2 7.8h1.9v2.4H7.2Z", fill: SIGN.sign_ink },
      { d: [circle(8.4, 16.3, 1.56), circle(12, 16.3, 1.56), circle(15.6, 16.3, 1.56)].join(" "), fill: SIGN.sign_ink },
    ],
  },
  // 紅白の柵。
  barrier: {
    sign: [
      { d: "M1.2 8.4h21.6v7.2H1.2Z", fill: SIGN.sign_face, stroke: SIGN.sign_regulatory, width: 1.2 },
      { d: "M3.6 8.4h3.6v7.2H3.6Z M10.8 8.4h3.6v7.2h-3.6Z M18 8.4h3.6v7.2H18Z", fill: SIGN.sign_regulatory },
      { d: "M3.6 15.6h1.8v6H3.6Z M18.6 15.6h1.8v6h-1.8Z", fill: SIGN.sign_post },
    ],
  },
  // 黄色いひし形に段差の線。
  hump: {
    sign: [
      { d: DIAMOND, fill: SIGN.sign_warning, stroke: SIGN.sign_ink, width: 1.4 },
      { d: "M4.8 15.6Q12 4.8 19.2 15.6", stroke: SIGN.sign_ink, width: 2.2 },
    ],
  },
  // ぶつかった印（星形）に「！」。
  crash: {
    sign: [
      { d: STAR, fill: SIGN.crash, stroke: SIGN.sign_face, width: 1.2 },
      { d: "M12 6.6V13.2", stroke: SIGN.sign_face, width: 2.6 },
      { d: circle(12, 16.3, 1.44), fill: SIGN.sign_face },
    ],
  },
  // ぶつかった印（星形）に自転車。
  bicycle_crash: {
    sign: [
      { d: STAR, fill: SIGN.crash_bicycle, stroke: SIGN.sign_face, width: 1.2 },
      { d: BICYCLE, stroke: SIGN.sign_face, width: 2.6, at: [5.4, 6, 0.552] },
    ],
  },
};

/** 点の絵の部品の列。標識の絵は宣言の部品のまま（枠も行の色も使わない）、線の絵は行の色`color`の枠`frame`に白い線を載せる。
 * 地図へ登録する画素（`features/map/layers/pointIcon.ts: drawPointIcon`）と見本が同じ列を描く。 */
export function pointIconParts(color: string, glyph: PointGlyph, frame: PointFrame): readonly IconPart[] {
  const shape = POINT_GLYPHS[glyph];
  if ("sign" in shape) return shape.sign;
  return [
    { d: FRAME_PATHS[frame], fill: color, stroke: palette.semantic.mark_stroke, width: BOX_STROKE },
    {
      d: shape.line,
      stroke: palette.semantic.mark_glyph,
      width: GLYPH_STROKE,
      at: [GLYPH_OFFSET, GLYPH_OFFSET, GLYPH_SCALE],
    },
  ];
}

/** 点の見本。地図と同じ形・同じ大きさで、線の絵は押せる点の枠（角丸四角）で出す。 */
export function PointIconSwatch({ color, glyph }: { color: string; glyph: PointGlyph }) {
  const size = mapDisplay.point.iconSizePx;
  return (
    <svg
      aria-hidden="true"
      className={"sign" in POINT_GLYPHS[glyph] ? undefined : cn("rounded-[4px]", LEGEND_SWATCH_RING_CLASS)}
      width={size}
      height={size}
      viewBox={`0 0 ${FRAME} ${FRAME}`}
    >
      {pointIconParts(color, glyph, "box").map((part, index) =>
        "text" in part ? (
          <text
            key={index}
            x={part.x}
            y={part.y}
            fontSize={part.size}
            fontWeight={SIGN_FONT_WEIGHT}
            fontFamily={SIGN_FONT_FAMILY}
            fill={part.fill}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {part.text}
          </text>
        ) : (
          <path
            key={index}
            d={part.d}
            transform={
              part.at === undefined ? undefined : `translate(${part.at[0]} ${part.at[1]}) scale(${part.at[2]})`
            }
            fill={part.fill ?? "none"}
            stroke={part.stroke}
            strokeWidth={part.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
    </svg>
  );
}
