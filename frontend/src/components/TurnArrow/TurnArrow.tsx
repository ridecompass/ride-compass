import type { PlanePoint } from "@/lib/localPlane";
import type { RouteTurn } from "@/types/route";

import { TURN_SHAPE_REACH_M, type TurnShape } from "./turnShape";

// 走行中の曲がる所の絵。**曲がる所のカードと地図の曲がる所の札は同じ絵**を出し、どちらを見ても同じ形に読めるようにする。

const LABELS = { left: "左折", right: "右折", uturn: "Uターン" } as const satisfies Record<
  RouteTurn["direction"],
  string
>;

/** 曲がる向きの読み上げの言葉。 */
export function turnLabel(direction: RouteTurn["direction"]): string {
  return LABELS[direction];
}

/** 絵の一辺（単位）。交差点を真ん中に置く。 */
const VIEW = 48;
const CENTER = VIEW / 2;
/** 1mの長さ（単位）。手前と先の端が縁の少し内に収まる。 */
const UNITS_PER_M = 22 / TURN_SHAPE_REACH_M;
/** ルートの線を進む向きの左へずらす幅（単位）。同じ道を引き返すUターンが、行きと帰りの2本の線に見える。 */
const LEFT_SHIFT = 3.5;
const HEAD_LENGTH = 8;
const HEAD_HALF_WIDTH = 7;
const OTHER_ROAD_LENGTH = 20;

/** 平面（m、`y`は上が正）の点を絵の単位（`y`は下が正）へ写す。 */
function toView({ x, y }: PlanePoint): PlanePoint {
  return { x: CENTER + x * UNITS_PER_M, y: CENTER - y * UNITS_PER_M };
}

function same(a: PlanePoint, b: PlanePoint): boolean {
  return a.x === b.x && a.y === b.y;
}

function unit(from: PlanePoint, to: PlanePoint): PlanePoint {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

/** 絵の単位の線`points`を、進む向きの左へ`LEFT_SHIFT`ずらす。点の向きは、その点の前後の辺の向きを均したもの。 */
// 地図のライブラリの線のずらし（`line-offset`）は地図の上の線にだけ効き、この絵（SVG）には使えないので自前で持つ。
function shiftLeft(points: readonly PlanePoint[]): PlanePoint[] {
  const line = points.filter((point, i) => i === 0 || !same(point, points[i - 1]));
  if (line.length < 2) return line;
  return line.map((point, i) => {
    const incoming = i > 0 ? unit(line[i - 1], point) : null;
    const outgoing = i < line.length - 1 ? unit(point, line[i + 1]) : null;
    const sum = { x: (incoming?.x ?? 0) + (outgoing?.x ?? 0), y: (incoming?.y ?? 0) + (outgoing?.y ?? 0) };
    const length = Math.hypot(sum.x, sum.y);
    const along = length === 0 ? (incoming ?? outgoing)! : { x: sum.x / length, y: sum.y / length };
    // 絵の単位は`y`が下向きなので、進む向き(x, y)の左は(y, -x)。
    return { x: point.x + along.y * LEFT_SHIFT, y: point.y - along.x * LEFT_SHIFT };
  });
}

function pathOf(points: readonly PlanePoint[], close = false): string {
  const d = points.map(({ x, y }, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return close ? `${d} Z` : d;
}

/** 曲がる所の絵: 交差点へ入る向きを上にした前後のルートの線と矢じりに、交差点に集まるほかの道を薄く描き足す。 */
export function TurnArrow({ shape, size }: { shape: TurnShape; size: number }) {
  const before = shiftLeft(shape.before.map(toView));
  const after = shiftLeft(shape.after.map(toView));
  const line = [...before, ...after];
  const tip = after.at(-1);
  const behindTip = after.at(-2);
  let head: PlanePoint[] = [];
  if (tip !== undefined && behindTip !== undefined) {
    const forward = unit(behindTip, tip);
    const base = { x: tip.x - forward.x * HEAD_LENGTH, y: tip.y - forward.y * HEAD_LENGTH };
    head = [
      tip,
      { x: base.x + forward.y * HEAD_HALF_WIDTH, y: base.y - forward.x * HEAD_HALF_WIDTH },
      { x: base.x - forward.y * HEAD_HALF_WIDTH, y: base.y + forward.x * HEAD_HALF_WIDTH },
    ];
    // 線は矢じりの付け根で止め、丸い端が矢じりの先から覗かないようにする。
    line[line.length - 1] = base;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <g opacity={0.38} strokeWidth={4}>
        {shape.otherRoadsDeg.map((deg, i) => {
          const rad = (deg * Math.PI) / 180;
          const end = { x: CENTER + Math.sin(rad) * OTHER_ROAD_LENGTH, y: CENTER - Math.cos(rad) * OTHER_ROAD_LENGTH };
          return <path key={i} d={pathOf([{ x: CENTER, y: CENTER }, end])} />;
        })}
        <circle cx={CENTER} cy={CENTER} r={3.2} fill="currentColor" stroke="none" />
      </g>
      <path d={pathOf(line)} strokeWidth={5} />
      {head.length > 0 && <path d={pathOf(head, true)} fill="currentColor" stroke="none" />}
    </svg>
  );
}
