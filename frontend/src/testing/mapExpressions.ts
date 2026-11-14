// 地図の式（色・線種・凡例の行の述語）を、MapLibreと同じ評価器で1本の地物に当てる。式の形ではなく、その地物が
// どう描かれるか・どの行に当てはまるかを見るために使う。ズームは既定で固定し、ズームで変わる式は`evaluateExpressionAtZoom`で倍率を名指す。
import { createExpression, featureFilter, type FilterSpecification } from "@maplibre/maplibre-gl-style-spec";

const GLOBALS = { zoom: 14 } as never;

/** 式を評価器に読ませたもの。式として読めなければ、評価器の指摘を並べて投げる。 */
function compile(expression: unknown, globalState: Record<string, unknown>) {
  const compiled = createExpression(expression, "paint", null, globalState);
  if (compiled.result !== "success") {
    throw new Error(compiled.value.map((error) => `${error.key}: ${error.message}`).join("; "));
  }
  return compiled.value;
}

/** 式を、地物のプロパティ（と feature-state・地図全体の global-state）へ当てた値。 */
export function evaluateExpression(
  expression: unknown,
  properties: Record<string, unknown>,
  state: Record<string, unknown> = {},
  globalState: Record<string, unknown> = {},
): unknown {
  return compile(expression, globalState).evaluateWithoutErrorHandling(
    GLOBALS,
    { type: 2, properties } as never,
    state,
  );
}

/** 式を、地図の倍率`zoom`で地物のプロパティへ当てた値。 */
export function evaluateExpressionAtZoom(
  expression: unknown,
  properties: Record<string, unknown>,
  zoom: number,
): unknown {
  return compile(expression, {}).evaluateWithoutErrorHandling({ zoom } as never, { type: 2, properties } as never);
}

/** 絞り（凡例の行の述語・レイヤーの`filter`）が、そのプロパティの地物に当てはまるか。`geometry`は地物の形
 * （MapLibreの番号で1が点・2が線・3が面。絞りが`geometry-type`を読むときに効く）。 */
export function matchesFilter(filter: unknown, properties: Record<string, unknown>, geometry: 1 | 2 | 3 = 2): boolean {
  return featureFilter(filter as FilterSpecification, "filter").filter(GLOBALS, {
    type: geometry,
    properties,
  } as never);
}

// 形を読む絞り（`distance`等）は、地物の形をタイルの中の座標で読む。この倍率のタイルに当てる。
const TILE_ZOOM = 14;
const TILE_EXTENT = 8192;

/** 絞り（レイヤーの`filter`）が、`lngLat`にある点の地物に当てはまるか。`distance`のように形を読む絞りも、点を含むタイルの座標へ
 * 落として MapLibre と同じ評価器で当てる。 */
export function matchesFilterAtPoint(
  filter: unknown,
  properties: Record<string, unknown>,
  [lng, lat]: readonly [number, number],
): boolean {
  const n = 2 ** TILE_ZOOM;
  const x = ((lng + 180) / 360) * n;
  const radians = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * n;
  const canonical = { z: TILE_ZOOM, x: Math.floor(x), y: Math.floor(y) };
  const point = { x: Math.round((x - canonical.x) * TILE_EXTENT), y: Math.round((y - canonical.y) * TILE_EXTENT) };
  return featureFilter(filter as FilterSpecification, "filter").filter(
    GLOBALS,
    { type: 1, properties, geometry: [[point]] } as never,
    canonical as never,
  );
}
