// デバッグモードの間、地図が1コマを描くのに長くかかったとき、層ごとの描く時間の上位をデバッグログへ出す。重さの原因の層を、
// 利用者の端末で決めるため。層を1つ描くたびに GPU の描き終わりを待って（`gl.finish`）測るので、測る間は地図が遅くなる。
// MapLibre の描く処理（`painter.render`・`painter.renderLayer`）は公開の API ではないので、無ければそう出して何もしない。

import type { Map as MapLibreMap } from "maplibre-gl";

import { debugLog } from "@/lib/debugLog";

/** この時間（ms）を超えたコマだけを出す。 */
const SLOW_FRAME_MS = 100;
/** 1コマで出す層の数。 */
const TOP_LAYERS = 5;

type RenderFn = (...args: unknown[]) => unknown;
interface PainterLike {
  render: RenderFn;
  renderLayer: RenderFn;
  context: { gl: WebGLRenderingContext | WebGL2RenderingContext };
}

/** 層ごとの描く時間の記録を始め、止める関数を返す。 */
export function observeLayerRenderTimes(map: MapLibreMap): () => void {
  const painter = (map as unknown as { painter?: PainterLike }).painter;
  if (!painter || typeof painter.render !== "function" || typeof painter.renderLayer !== "function") {
    debugLog("frame:layers", "地図の描く処理を測れません（地図のライブラリの中の形が違う）");
    return () => {};
  }
  const { gl } = painter.context;
  const render = painter.render;
  const renderLayer = painter.renderLayer;
  let layers = new Map<string, number>();

  painter.renderLayer = function (this: PainterLike, ...args: unknown[]) {
    const layer = args.find((a): a is { id: string } => typeof (a as { id?: unknown })?.id === "string");
    gl.finish();
    const started = performance.now();
    const result = renderLayer.apply(this, args);
    gl.finish();
    if (layer) layers.set(layer.id, (layers.get(layer.id) ?? 0) + performance.now() - started);
    return result;
  };
  painter.render = function (this: PainterLike, ...args: unknown[]) {
    layers = new Map();
    const started = performance.now();
    const result = render.apply(this, args);
    const total = performance.now() - started;
    if (total > SLOW_FRAME_MS) {
      const top = [...layers]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_LAYERS)
        .map(([id, ms]) => ({ 層: id, ms: Math.round(ms) }));
      const layerMs = Math.round([...layers.values()].reduce((sum, ms) => sum + ms, 0));
      debugLog(
        "frame:layers",
        `地図の1コマ ${Math.round(total)}ms（層を描く時間の合計 ${layerMs}ms・層 ${layers.size}）`,
        top,
      );
    }
    return result;
  };
  return () => {
    painter.render = render;
    painter.renderLayer = renderLayer;
  };
}
