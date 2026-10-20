import type { RouteCandidate } from "@/types/route";
import { measureMapOverlayEdges, type RouteFitObscuredPx } from "@/lib/mapOverlayEdges";

// ルート全体を収めるときの基本余白（全辺）。
const ROUTE_FIT_BASE_PADDING_PX = 40;
// フィット後に必ず残す可視領域の幅・高さ。覆うUIが大きいと、余白同士が地図を食い尽くしてズームが破綻する。
const ROUTE_FIT_MIN_VISIBLE_PX = 80;

/** 候補の線を全部含む範囲（`[[西, 南], [東, 北]]`）。候補が無ければnull。 */
export function computeRouteBounds(routes: readonly RouteCandidate[]): [[number, number], [number, number]] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const route of routes) {
    for (const [lng, lat] of route.geometry.coordinates) {
      west = Math.min(west, lng);
      south = Math.min(south, lat);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
    }
  }
  return west === Infinity
    ? null
    : [
        [west, south],
        [east, north],
      ];
}

/** 覆われている高さを基本余白へ足したフィット用paddingを返す。対向する2辺の合計が
 * 地図の幅・高さを食い尽くす場合は、可視領域がROUTE_FIT_MIN_VISIBLE_PX残るところまで
 * その2辺を同じ比率で縮める。 */
function computeRouteFitPadding(
  obscured: Required<RouteFitObscuredPx>,
  canvas: { width: number; height: number },
): Required<RouteFitObscuredPx> {
  const base = ROUTE_FIT_BASE_PADDING_PX;
  const padding = {
    top: base + obscured.top,
    bottom: base + obscured.bottom,
    left: base + obscured.left,
    right: base + obscured.right,
  };

  const shrink = (a: number, b: number, size: number): [number, number] => {
    const available = Math.max(0, size - ROUTE_FIT_MIN_VISIBLE_PX);
    const total = a + b;
    if (total <= available) return [a, b];
    const ratio = total > 0 ? available / total : 0;
    return [a * ratio, b * ratio];
  };

  [padding.top, padding.bottom] = shrink(padding.top, padding.bottom, canvas.height);
  [padding.left, padding.right] = shrink(padding.left, padding.right, canvas.width);
  return padding;
}

/** 地図のキャンバスの上に重なる印の付いた部品（`mapOverlayEdge`）を避けた、見えている所までの辺ごとの余白。 */
export function visiblePadding(canvas: HTMLElement): Required<RouteFitObscuredPx> {
  const { top = 0, bottom = 0, left = 0, right = 0 } = measureMapOverlayEdges(canvas.getBoundingClientRect());
  return computeRouteFitPadding(
    { top, bottom, left, right },
    { width: canvas.clientWidth, height: canvas.clientHeight },
  );
}

/** 地図の中心から、見えている所の中ほどへのずれ（px）。寄せるときの`offset`に渡す。 */
export function visibleCenterOffset(canvas: HTMLElement): [number, number] {
  const padding = visiblePadding(canvas);
  return [(padding.left - padding.right) / 2, (padding.top - padding.bottom) / 2];
}
