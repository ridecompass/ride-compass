/** 地図に載るものを、1つの形で宣言する。
 *
 * 種類（面・道路の線・点・レンズ・ルート・気象）で書き方を変えない——**どれも
 * 「いまの状態から、載っているべきレイヤーの並びを返す」1つの形**で表す。役割が固定の
 * ものは固定の並びを返し、実行時に増減するものは状態から導いた並びを返す。
 *
 * 状態として受け取るのは外から来る値——実行時に増減する軸・タイルの配信先・取得した中身——だけ。
 */
import type { FilterSpecification, LayerSpecification } from "maplibre-gl";

import type { BasemapPoiKinds } from "@/features/map/layers/mapStyleOps";

import type { MapScene, MapSceneImage, MapSceneLayer, MapSceneSource, MapSceneTier } from "./mapScene";
import { geojsonContent, sceneLayerId, type SceneSourceId, tilesContent } from "./sceneBuilders";

/** レイヤー1枚ぶんの宣言。id は役割から決まる。
 *
 * **宣言を1件足すと、地図のレイヤーが1枚増える。** 段・表示・押せるかの付け方を家族ごとに
 * 書かないための形で、どの家族でも同じ——足す場所が1つだから、増やしたときに
 * 「差し込み位置を書き忘れて最前面へ出る」類の食い違いが起きない。 */
export type SceneLayerEntry = {
  /** 役割。id の綴りはここから機械的に決まる。 */
  readonly role: string;
  readonly tier: MapSceneTier;
  readonly source: SceneSourceId;
  readonly sourceLayer?: string;
  readonly type: LayerSpecification["type"];
  readonly paint: Readonly<Record<string, unknown>>;
  readonly layout?: Readonly<Record<string, unknown>>;
  /** 描く縮尺の範囲（MapLibre の層の`minzoom`・`maxzoom`。`maxzoom`の縮尺そのものは描かない）。作った後に変えない。 */
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly visible: boolean;
  /** 押したときに拾う対象。空なら押せない。 */
  readonly hitTargets?: readonly string[];
  readonly filter?: FilterSpecification;
  /** 出ている間、基礎地図から隠す店・施設の種類。 */
  readonly hidesBasemapPois?: BasemapPoiKinds;
};

/** ソース1本ぶんの宣言。同じ id を複数のグループが名乗ってもよい——束ねる側が1本へ畳む。 */
export type SceneSourceEntry = {
  readonly id: SceneSourceId;
  readonly spec: MapSceneSource["spec"];
  /** 実行時に入れ替わるタイルのURL。 */
  readonly tiles?: readonly string[];
  /** 実行時に入れ替わる GeoJSON。 */
  readonly data?: unknown;
};

/** 地図に載るもののひとまとまり。状態から、ソースとレイヤーの並びと、記号のレイヤーが名指す絵を返す。 */
export type SceneGroup<State> = {
  readonly build: (state: State) => {
    readonly sources: readonly SceneSourceEntry[];
    readonly layers: readonly SceneLayerEntry[];
    /** 同じ id を複数のグループが名乗ってもよい——束ねる側が1つへ畳む。 */
    readonly images?: readonly MapSceneImage[];
  };
};

export function declareGroup<State>(build: SceneGroup<State>["build"]): SceneGroup<State> {
  return { build };
}

/**
 * グループの並びを scene へ畳む。
 *
 * **重なりは段（tier）だけが決める**ので、グループをどの順で並べても結果は変わらない
 * （同じ段の中だけは、宣言の順を保つ）。ソースと絵は、id ごとに先に名乗った1つへ畳む——地図には同じ id の
 * ものを1つしか作れないため。
 */
export function composeScene<State>(groups: readonly SceneGroup<State>[], state: State): MapScene {
  const sources = new Map<string, MapSceneSource>();
  const layers: MapSceneLayer[] = [];
  const images = new Map<string, MapSceneImage>();

  for (const group of groups) {
    const built = group.build(state);
    for (const entry of built.sources) mergeSource(sources, entry);
    for (const entry of built.layers) layers.push(toSceneLayer(entry));
    for (const image of built.images ?? []) if (!images.has(image.id)) images.set(image.id, image);
  }

  return { sources: [...sources.values()], layers, images: [...images.values()] };
}

function toSceneLayer(entry: SceneLayerEntry): MapSceneLayer {
  return {
    // `LayerSpecification` は `type` ごとの合併型のため、paint/layout を外から受け取る形では合併型として組み立て直せない。
    spec: {
      id: sceneLayerId(entry.source, entry.role),
      type: entry.type,
      source: entry.source,
      ...(entry.sourceLayer === undefined ? {} : { "source-layer": entry.sourceLayer }),
      paint: entry.paint,
      ...(entry.layout === undefined ? {} : { layout: entry.layout }),
      ...(entry.minzoom === undefined ? {} : { minzoom: entry.minzoom }),
      ...(entry.maxzoom === undefined ? {} : { maxzoom: entry.maxzoom }),
    } as unknown as LayerSpecification,
    tier: entry.tier,
    visible: entry.visible,
    hitTargets: entry.hitTargets ?? [],
    ...(entry.filter === undefined ? {} : { filter: entry.filter }),
    ...(entry.hidesBasemapPois === undefined ? {} : { hidesBasemapPois: entry.hidesBasemapPois }),
  };
}

function mergeSource(into: Map<string, MapSceneSource>, entry: SceneSourceEntry): void {
  const content =
    entry.tiles !== undefined
      ? tilesContent(entry.tiles)
      : entry.data !== undefined
        ? geojsonContent(entry.data)
        : undefined;
  if (into.has(entry.id)) return;
  into.set(entry.id, { id: entry.id, spec: entry.spec, ...(content === undefined ? {} : { content }) });
}
