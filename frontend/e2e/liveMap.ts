import type { Page } from "@playwright/test";
import { ROAD_LINE_SOURCE_ID } from "@/features/map/scene/groups/roadLines";

declare global {
  interface Window {
    __liveMap(): import("maplibre-gl").Map;
    __liveScene(): import("@/features/map/scene/mapScene").MapScene;
  }
}

/** 本体の地図の要素。左下の俯瞰図（MapOverview.tsx）も MapLibre の地図で、DOM では本体より前に並ぶので、その中のものを除く。 */
export const MAIN_MAP = '.maplibregl-map:not([aria-label="俯瞰図"] *)';
/** 本体の地図の描画面。 */
export const MAIN_MAP_CANVAS = `${MAIN_MAP} canvas.maplibregl-canvas`;

/**
 * 地図のインスタンスと、地図に載っているべきものの宣言（scene）を、描画しているReactの部品の参照（useRef）から探す関数を
 * ページへ入れる。アプリは地図を外へ公開していないので、テストのために入口を足さず、Reactが要素へ付ける内部の印
 * （`__reactFiber$`）から祖先の部品のフックを辿る。Reactの内部の形が変わると見つからず、そのときは例外で止まる（黙って空を返さない）。
 */
function defineMapFinder(mainMap: string): void {
  const findRef = (what: string, holds: (current: Record<string, unknown>) => boolean) => {
    const container = document.querySelector(mainMap);
    const key = container && Object.keys(container).find((k) => k.startsWith("__reactFiber$"));
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { memoizedState: unknown; return: Fiber | null };
    let fiber = key ? ((container as unknown as Record<string, Fiber>)[key] ?? null) : null;
    for (; fiber; fiber = fiber.return) {
      let hook = fiber.memoizedState as Hook | null;
      while (hook && typeof hook === "object" && "next" in hook) {
        const state = hook.memoizedState as { current?: Record<string, unknown> } | null;
        if (state && typeof state === "object" && state.current && holds(state.current)) return state.current;
        hook = hook.next;
      }
    }
    throw new Error(`${what}が見つからない（Reactの内部の形が変わった可能性）`);
  };
  window.__liveMap = () =>
    findRef("地図のインスタンス", (current) => typeof current.queryRenderedFeatures === "function") as never;
  // 地図の部品は、いまのpropsの参照（MapView.tsx: latest）に scene を持つ。
  window.__liveScene = () =>
    findRef("地図の scene", (current) => Array.isArray((current.scene as { layers?: unknown })?.layers)).scene as never;
}

/** `page.addInitScript(installMapFinder)`で入れる。ページへは関数の文だけが渡るので、本体の地図の選び方を文に埋めて渡す。 */
export const installMapFinder = { content: `(${defineMapFinder.toString()})(${JSON.stringify(MAIN_MAP)});` };

/** 押す地物の選び方。`target`: scene が当たり判定の対象を宣言したレイヤーの地物で、押した所の一番上に来るもの。`source`: その
 * ソースを描くレイヤーの地物（当たり判定を持たない道等）で、押した所に当たり判定を持つ地物が無いもの（あればアプリはそれを開く）。 */
type PressWanted = { target: string } | { source: string };

/** `wanted` の地物を1つ押せる画面の点。押せなければ理由。 */
async function pressPoint(
  page: Page,
  wanted: PressWanted,
): Promise<{ point: { x: number; y: number } } | { error: string }> {
  return page.evaluate((wanted) => {
    const map = window.__liveMap();
    const layers = window.__liveScene().layers;
    let carrying: typeof layers;
    if ("target" in wanted) {
      const targets = [...new Set(layers.flatMap((layer) => layer.hitTargets))];
      if (!targets.includes(wanted.target)) return { error: `いまの地図に無い。押せる対象: ${targets.join(" / ")}` };
      carrying = layers.filter((layer) => layer.hitTargets.includes(wanted.target));
    } else {
      carrying = layers.filter((layer) => (layer.spec as { source?: string }).source === wanted.source);
      if (carrying.length === 0) return { error: "描くレイヤーがいまの地図に無い" };
    }
    const shown = carrying.filter((layer) => layer.visible && map.getLayer(layer.spec.id));
    if (shown.length === 0) {
      const hidden = carrying.map((layer) => layer.spec.id).join(" / ");
      return { error: `持つレイヤーが全部非表示（${hidden}。レイヤーの表示を ON にする）` };
    }
    const own = new Set(shown.map((layer) => layer.spec.id));
    const interactive = layers
      .filter((layer) => layer.hitTargets.length > 0 && map.getLayer(layer.spec.id))
      .map((layer) => layer.spec.id);
    const canvas = map.getCanvas();
    const box = canvas.getBoundingClientRect();
    const features = map.queryRenderedFeatures({ layers: [...own] });
    for (const feature of features) {
      const geometry = feature.geometry;
      const vertices: number[][] =
        geometry.type === "Point"
          ? [geometry.coordinates]
          : geometry.type === "LineString"
            ? geometry.coordinates
            : geometry.type === "MultiLineString"
              ? geometry.coordinates.flat()
              : [];
      // 線の端は別の道と接するので、真ん中の頂点から外へ向かって試す。
      const middle = Math.floor(vertices.length / 2);
      const order = vertices.map((_, i) => middle + (i % 2 === 0 ? i / 2 : -(i + 1) / 2));
      for (const index of order) {
        const vertex = vertices[index];
        if (!vertex) continue;
        const { x, y } = map.project([vertex[0], vertex[1]]);
        const client = { x: box.left + x, y: box.top + y };
        if (client.x < 0 || client.y < 0 || client.x >= window.innerWidth || client.y >= window.innerHeight) continue;
        if (document.elementFromPoint(client.x, client.y) !== canvas) continue;
        const top =
          interactive.length === 0 ? undefined : map.queryRenderedFeatures([x, y], { layers: interactive })[0];
        if ("target" in wanted ? top && own.has(top.layer.id) : top === undefined) return { point: client };
      }
    }
    return {
      error:
        features.length === 0
          ? "画面に描かれていない（位置・倍率を変える）"
          : `描かれた ${features.length} 件のどれも、地図の見えている所で押せる所に無い（位置・倍率を変える）`,
    };
  }, wanted);
}

/**
 * 地図に描かれた、押すと詳細や選択が開くもの（scene が当たり判定の対象 `target` を宣言したレイヤーの地物）を1つ押す
 * （`installMapFinder`を入れたページで）。押す点は、地図そのものが押され（上に部品が重ならない）、そこで一番上に来る
 * 押せる地物が `target` のものである点に限る——アプリはその地物を開く（ルートの線は道・点より上の段にある）。
 * 対象の名前は scene の宣言から読むので、当たり判定を足せばここを変えずに押せる。押せなければ理由を出して止める。
 */
export async function clickFeature(page: Page, target: string): Promise<void> {
  const found = await pressPoint(page, { target });
  if ("error" in found) throw new Error(`地図の「${target}」を押せない: ${found.error}`);
  await page.mouse.click(found.point.x, found.point.y);
}

/**
 * 地図に描かれた道を1本、マウスの右ボタンで長押しする（`installMapFinder`を入れたページで）。道は当たり判定を持たないので、押す点は
 * 当たり判定を持つ地物の重ならない道の上に限る。道の層を出してから呼ぶ。押せなければ理由を出して止める。
 */
export async function longPressRoad(page: Page): Promise<void> {
  const found = await pressPoint(page, { source: ROAD_LINE_SOURCE_ID });
  if ("error" in found) throw new Error(`地図の道を長押しできない: ${found.error}`);
  await page.mouse.click(found.point.x, found.point.y, { button: "right" });
}

/** 地図の上の経度・緯度の点を押す（`installMapFinder`を入れたページで）。その点が画面の外か、地図の上に別の部品が重なっていれば止める。 */
export async function clickMap(page: Page, lngLat: [number, number]): Promise<void> {
  const point = await page.evaluate((at) => {
    const map = window.__liveMap();
    const projected = map.project(at);
    const box = map.getCanvas().getBoundingClientRect();
    const x = box.left + projected.x;
    const y = box.top + projected.y;
    const inside = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
    return { x, y, onMap: inside && document.elementFromPoint(x, y) === map.getCanvas() };
  }, lngLat);
  if (!point.onMap) {
    throw new Error(`地図の点 ${lngLat.join(",")}（画面の ${Math.round(point.x)},${Math.round(point.y)}）は押せない`);
  }
  await page.mouse.click(point.x, point.y);
}
