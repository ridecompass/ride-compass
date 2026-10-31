/** scene を組み立てる道具のうち、どの家族でも同じ形になるもの。 */
import type { MapSceneFeatureStates, MapSceneFeatureStateValue, MapSceneSourceContent } from "./mapScene";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { LegendEntry } from "@/lib/mapDisplay/legendFilter";

declare const sceneSourceBrand: unique symbol;

/** ソースの名前。**データの識別子**で、誰が描くかと独立している——同じタイルを別の
 * グループが名乗って共有できる（`composeScene`が1本へ畳む）。 */
export type SceneSourceId = string & { readonly [sceneSourceBrand]: "sceneSource" };

/** ソース名を作る唯一の口。**手で文字列を組み立てられないように型で縛る**——組み立てが
 * 散ると、レイヤーidとの対応が「たまたま合っている」状態になり、綴りを変えたときに
 * 片方だけが動く（動くので気づけない）。 */
export function sceneSourceId(name: string): SceneSourceId {
  return name as SceneSourceId;
}

/** レイヤーの id は**ソース名＋役割**から機械的に決める。1つのソースに何枚重ねても、
 * どのレイヤーがどのデータを描いているかが id から読める。 */
export function sceneLayerId(source: SceneSourceId, role: string): string {
  return `${source}-${role}`;
}

/** 大きさを、ズームで決まる倍率で伸縮させる式。`base`は定数でも値から決まる式でもよい。倍率の曲線（`stops`、
 * ズーム→倍率）は宣言（`mapDisplay`）が配る。 */
export function zoomScaleExpression(base: unknown, stops: readonly (readonly [number, number])[]): unknown {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    ...stops.flatMap(([zoom, factor]) => [zoom, typeof base === "number" ? base * factor : ["*", base, factor]]),
  ];
}

/** 地図の線形の補間の式（`["interpolate", ["linear"], 入力, ...stops]`）が、入力`x`で出す値。`stops`は入力の昇順で、
 * 端より外は端の値。 */
export function linearAt(stops: readonly (readonly [number, number])[], x: number): number {
  const upper = stops.findIndex(([at]) => at >= x);
  if (upper === -1) return stops[stops.length - 1][1];
  if (upper === 0) return stops[0][1];
  const [x0, y0] = stops[upper - 1];
  const [x1, y1] = stops[upper];
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** 実行時に入れ替わる GeoJSON の中身。ソースを作り直さずに当て直す。
 *
 * タイルと同じく**中身が変わっていないときは当て直さない**（呼び出し側が前回の宣言と
 * 比べる）——`setData`はネットワークへ出ないが、渡したデータをワーカーへ送り直して
 * インデックスを作り直させる。 */
export function geojsonContent(data: unknown): MapSceneSourceContent {
  return {
    spec: { data },
    replace: (source) => {
      (source as { setData: (data: unknown) => void }).setData(data);
    },
  };
}

/** 実行時に入れ替わるタイルのURL。ソースを作り直さずに当て直す
 * （作り直すと、取得済みのタイルを捨てることになる）。**URLが変わっていないときは当て直さない**
 * ——同じURLで`setTiles`を呼んでも、タイルの再取得とPNGデコード・GPUへの転送をやり直す。 */
export function tilesContent(tiles: readonly string[]): MapSceneSourceContent {
  return {
    spec: { tiles: [...tiles] },
    replace: (source) => {
      (source as { setTiles: (tiles: string[]) => void }).setTiles([...tiles]);
    },
  };
}

const featureStatesByInput = new WeakMap<object, MapSceneFeatureStates>();

/** 地物ごとの値（地物id → 名前 → 値）を、名前ごとの feature-state（`stateKey(名前)` → 地物id → 値）へ移す。同じ入力からは
 * 同じ参照を返す——当てる側は参照が同じなら地物ごとに比べ直さない。入力1つに`stateKey`は1つだけ使う（覚えるのは入力ごと）。 */
export function featureStatesByName<V extends MapSceneFeatureStateValue>(
  byFeature: ReadonlyMap<string, Readonly<Record<string, V>>>,
  stateKey: (name: string) => string,
): ReadonlyMap<string, ReadonlyMap<string, V>> {
  const cached = featureStatesByInput.get(byFeature);
  if (cached !== undefined) return cached as ReadonlyMap<string, ReadonlyMap<string, V>>;
  const states = new Map<string, Map<string, V>>();
  for (const [featureId, values] of byFeature) {
    for (const [name, value] of Object.entries(values)) {
      const key = stateKey(name);
      let byId = states.get(key);
      if (byId === undefined) states.set(key, (byId = new Map()));
      byId.set(featureId, value);
    }
  }
  featureStatesByInput.set(byFeature, states);
  return states;
}

/** 値がどれかに入るかの式。 */
export function valueInExpression(value: unknown, values: readonly unknown[]): unknown[] {
  return ["in", value, ["literal", [...values]]];
}

/** 値が無い線を破線にする式。`missing`が真の地物だけが破線で、偽なら実線のまま。**線種が運ぶのは操作の状態と
 * 値が無いことだけ**——分類は色が運ぶ。値が無いことはどの属性・軸でも同じ意味なので、線を重ねても混ざらない。 */
export function noDataDashExpression(missing: unknown): unknown[] {
  return ["case", missing, ["literal", [...mapDisplay.noDataDash]], ["literal", [1, 0]]];
}

// 凡例で非表示にしたカテゴリを除外するMapLibreフィルタ式を組み立てる。
// 全カテゴリ表示中はnull（フィルタ無し）。未知のキーは無視する（モード切替や定義変更で
// 過去の非表示キーが残っていても安全）。
export function buildLegendFilterExpression(
  legend: readonly LegendEntry[],
  hiddenKeys: readonly string[],
): unknown[] | null {
  const hidden = legend.filter((entry) => hiddenKeys.includes(entry.key));
  if (hidden.length === 0) return null;
  return ["all", ...hidden.flatMap((entry) => (entry.filter === undefined ? [] : [["!", entry.filter]]))];
}
