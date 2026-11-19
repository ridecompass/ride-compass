/** 画面の状態を地図へ当てる。**ここが唯一の適用の入口**。
 *
 * 状態 → 各家族の入力（`features/map/scene/sceneInputs.ts: sceneInputsFrom`）→ 望ましい並び（`buildMapScene`）→
 * 差分を当てる（`applyMapScene`）の1本道。スタイルを差し替えた後の作り直しも同じ道を通り、
 * 前回との差分ではなく空から当て直す（`applyScene`の`reset`）だけが違う。
 *
 * **再描画で失われる副作用を持つ描画は、必ずここから辿れる位置へ置く。** レイヤーの
 * 追加だけでなく、filter・feature-state・visibilityで持つ表示状態も同じ。辿れないものは
 * `setStyle()`後に作り直されず、押した人の地図から消えたままになる。
 *
 * カメラは動かさない——作り直しは見た目を戻すだけで、表示範囲は利用者のもの。
 */
import type { Map as MapLibreMap } from "maplibre-gl";

import {
  areaLayerAnchor,
  hideBasemapPois,
  prepareBasemap,
  runWhenStyleLoaded,
  runWhenStyleReady,
  themeBasemap,
} from "@/features/map/layers/mapStyleOps";
import type { BasemapLook } from "@/features/map/basemapTheme";

import { applyMapScene } from "./applyMapScene";
import { EMPTY_MAP_SCENE, hiddenBasemapPois, type MapScene } from "./mapScene";

const LIGHT_BASEMAP: BasemapLook = { theme: "light", muted: false };

/** 地図へ当てた宣言を地図ごとに覚える。スタイルを差し替えた後は `reset` で作り直す。 */
const appliedScene = new WeakMap<MapLibreMap, MapScene>();

/** `basemap`は基礎地図の見え方（省けば明るい地図）。スタイルを差し替えると基礎地図は明るい地図へ戻るので、暗い・薄めた地図を
 * 出す地図は当てるたびに渡す。 */
export function applyScene(
  map: MapLibreMap,
  scene: MapScene,
  options: { readonly basemap?: BasemapLook; readonly reset?: boolean } = {},
) {
  // 下の`applyMapScene`は`prepareBasemap`が記録した差し込み位置を読む。同じ出来事では先に登録した方が先に走るので、この順で足りる。
  runWhenStyleLoaded(map, () => {
    prepareBasemap(map);
    hideBasemapPois(map, hiddenBasemapPois(scene));
    themeBasemap(map, options.basemap ?? LIGHT_BASEMAP);
  });
  runWhenStyleReady(map, () => {
    applyMapScene(map, {
      scene,
      previous: options.reset === true ? EMPTY_MAP_SCENE : (appliedScene.get(map) ?? EMPTY_MAP_SCENE),
      basemapAnchors: { roads: areaLayerAnchor(map) },
    });
    appliedScene.set(map, scene);
  });
}
