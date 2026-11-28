// デバッグモードの間、地図が1コマに長くかかったとき、1コマの段ごとの時間の上位をデバッグログへ出す。重さの原因の段とソース・層を、
// 利用者の端末で決めるため。段は、スタイルの更新・ソースごとのタイルの更新・地形・記号の配置・ソースごとの描く前の準備・層ごとの描く処理。
// 層を1つ描くたびに GPU の描き終わりを待って（`gl.finish`）測るので、測る間は地図が遅くなる（待つ時間は「その他」に入る）。
// MapLibre の1コマの中の処理（`map._render`・`painter.renderLayer`・`style.tileManagers` 等）は公開の API ではないので、無ければそう出して何もしない。

import type { Map as MapLibreMap } from "maplibre-gl";

import { debugLog } from "@/lib/debugLog";

/** この時間（ms）を超えたコマだけを出す。 */
const SLOW_FRAME_MS = 100;
/** 1コマで出す段の数。 */
const TOP_STAGES = 8;

type Method = (...args: unknown[]) => unknown;
type Methods = Record<string, unknown>;
interface TileManagerLike extends Methods {
  update: Method;
  prepare: Method;
}
interface MapInternals extends Methods {
  _render: Method;
  painter?: Methods & { renderLayer: Method; context: { gl: WebGLRenderingContext | WebGL2RenderingContext } };
  style?: Methods & { update: Method; _updatePlacement: Method; tileManagers: Record<string, TileManagerLike> };
  terrain?: { tileManager: TileManagerLike } | null;
}

/** 1コマの段ごとの時間の記録を始め、止める関数を返す。 */
export function observeMapFrameTimes(map: MapLibreMap): () => void {
  const internals = map as unknown as MapInternals;
  const painter = internals.painter;
  if (typeof internals._render !== "function" || !painter || typeof painter.renderLayer !== "function") {
    debugLog("frame:map", "地図の1コマを測れません（地図のライブラリの中の形が違う）");
    return () => {};
  }
  const { gl } = painter.context;
  let stages = new Map<string, number>();
  /** 入れ子の段ごとの、中で呼んだ段の時間の合計（段には自分の分だけを足す）。 */
  const children: number[] = [];
  const restores: (() => void)[] = [];
  const wrapped = new WeakSet<object>();

  /** `target[name]` を、かかった時間のうち中で呼んだ段を除いた分を `stageOf(引数)` の段へ足す形に差し替える。 */
  function measure(target: Methods, name: string, stageOf: (args: unknown[]) => string | undefined, waitGpu = false) {
    const original = target[name] as Method;
    target[name] = function (this: unknown, ...args: unknown[]) {
      if (waitGpu) gl.finish();
      children.push(0);
      const started = performance.now();
      try {
        const result = original.apply(this, args);
        if (waitGpu) gl.finish();
        return result;
      } finally {
        const elapsed = performance.now() - started;
        const own = elapsed - (children.pop() ?? 0);
        if (children.length > 0) children[children.length - 1] += elapsed;
        const stage = stageOf(args);
        if (stage !== undefined) stages.set(stage, (stages.get(stage) ?? 0) + own);
      }
    };
    restores.push(() => {
      target[name] = original;
    });
  }

  /** ソースや地形やスタイルは途中で足され・作り直されるので、1コマごとにまだ測っていないものを差し替える。 */
  function measureNewParts() {
    const { style, terrain } = internals;
    if (style && !wrapped.has(style)) {
      wrapped.add(style);
      measure(style, "update", () => "スタイルの更新");
      measure(style, "_updatePlacement", () => "記号の配置");
    }
    for (const [id, tileManager] of Object.entries(style?.tileManagers ?? {})) {
      if (wrapped.has(tileManager)) continue;
      wrapped.add(tileManager);
      measure(tileManager, "update", () => `タイルの更新 ${id}`);
      measure(tileManager, "prepare", () => `描く前の準備 ${id}`);
    }
    if (terrain && !wrapped.has(terrain.tileManager)) {
      wrapped.add(terrain.tileManager);
      measure(terrain.tileManager, "update", () => "地形のタイルの更新");
    }
  }

  measure(
    painter,
    "renderLayer",
    (args) => {
      const layer = args.find((a): a is { id: string } => typeof (a as { id?: unknown })?.id === "string");
      return layer && `層 ${layer.id}`;
    },
    true,
  );
  const render = internals._render;
  internals._render = function (this: unknown, ...args: unknown[]) {
    measureNewParts();
    stages = new Map();
    const started = performance.now();
    const result = render.apply(this, args);
    const total = performance.now() - started;
    if (total > SLOW_FRAME_MS) {
      const measured = [...stages.values()].reduce((sum, ms) => sum + ms, 0);
      const top = [...stages, ["その他", total - measured] as const]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_STAGES)
        .map(([stage, ms]) => ({ 段: stage, ms: Math.round(ms) }));
      debugLog("frame:map", `地図の1コマ ${Math.round(total)}ms`, top);
    }
    return result;
  };
  restores.push(() => {
    internals._render = render;
  });

  return () => {
    for (const restore of restores.reverse()) restore();
  };
}
