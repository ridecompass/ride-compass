/** 地図（`Map`）の代役。中身は `../mapTrace/recordingMap.ts` へ記録し、描いた地図を `lastDrawnMap` で引ける。 */
import type { Coordinates } from "@/types/route";

import { matchesFilterAtPoint } from "../mapExpressions";
import { createRecordingMap, type RecordingMap } from "../mapTrace/recordingMap";
import { asRendered, Evented, type PointedFeature } from "./evented";
import type { Marker } from "./overlays";

/** 見えている範囲（経度・緯度）。 */
export interface ViewBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** 地図の中身（ソース・レイヤー・地物の状態）を記録する操作。ここから先は `recordingMap` へそのまま渡す。 */
const STYLE_OPERATIONS = [
  "getStyle",
  "getLayer",
  "getSource",
  "hasImage",
  "addImage",
  "addSource",
  "removeSource",
  "addLayer",
  "removeLayer",
  "moveLayer",
  "setPaintProperty",
  "setLayoutProperty",
  "setFilter",
  "setFeatureState",
  "removeFeatureState",
  "setGlobalStateProperty",
] as const;

const drawn: StandInMap[] = [];

/** `fitBounds` に渡された範囲（[[西, 南], [東, 北]]）と、寄せる倍率の上限。 */
export interface FittedBounds {
  readonly bounds: [[number, number], [number, number]];
  readonly maxZoom?: number;
}

export class StandInMap extends Evented {
  readonly markers = new Set<Marker>();
  readonly fits: FittedBounds[] = [];
  readonly styles: string[];
  readonly content: RecordingMap;
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private zoom: number;
  private bearing = 0;
  private bounds: ViewBounds | null = null;
  private pointed: readonly PointedFeature[] = [];
  private readonly placedTileFeatures = new Map<string, readonly GeoJSON.Feature<GeoJSON.Point>[]>();
  // 手ぶりの入切は、代役では指の操作が無いので受けるだけにする。
  readonly touchZoomRotate = { disableRotation() {}, enableRotation() {} };

  /** 本体の地図に添える小さな地図（操作を受けない地図）か。 */
  readonly inset: boolean;

  constructor(options: { container: HTMLElement; style: string; zoom: number; interactive?: boolean }) {
    super();
    this.inset = options.interactive === false;
    const { map, handle } = createRecordingMap();
    Object.assign(this, Object.fromEntries(STYLE_OPERATIONS.map((name) => [name, map[name]])));
    this.content = handle;
    this.container = options.container;
    this.styles = [options.style];
    this.zoom = options.zoom;
    // 描画面は窓いっぱいとして大きさを返す（テスト環境はレイアウトの実寸を0で返す）。
    this.canvas = document.createElement("canvas");
    Object.defineProperties(this.canvas, {
      clientWidth: { value: window.innerWidth },
      clientHeight: { value: window.innerHeight },
    });
    this.container.append(this.canvas);
    drawn.push(this);
  }

  getContainer() {
    return this.container;
  }

  getCanvas() {
    return this.canvas;
  }

  getZoom() {
    return this.zoom;
  }

  zoomIn() {
    this.zoom += 1;
    return this;
  }

  zoomOut() {
    this.zoom -= 1;
    return this;
  }

  /** テストが範囲を置くまでは、範囲の無い地図（MapLibre が範囲を求められないとき）として null を返す。 */
  getBounds() {
    const bounds = this.bounds;
    if (bounds === null) return null;
    return {
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north,
    };
  }

  /** 経度・緯度を描画面の上の位置へ。範囲を置いていなければ、どの点も描画面の真ん中に映るとする（範囲の無い地図は、何でも見えている扱い）。
   * 範囲は向きを北のままとして、描画面へ線形に当てる。 */
  project([lng, lat]: [number, number]) {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    const bounds = this.bounds;
    if (bounds === null) return { x: width / 2, y: height / 2 };
    return {
      x: ((lng - bounds.west) / (bounds.east - bounds.west)) * width,
      y: ((bounds.north - lat) / (bounds.north - bounds.south)) * height,
    };
  }

  /** 描画面の上の位置を経度・緯度へ（`project`の逆）。範囲を置いていない地図は、どの点も真ん中に映るので、真ん中はどの経度・緯度でも
   * よく（0, 0）を返し、ほかの位置には映る点が無いので投げる。 */
  unproject([x, y]: [number, number]) {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    const bounds = this.bounds;
    if (bounds === null) {
      if (x === width / 2 && y === height / 2) return { lng: 0, lat: 0 };
      throw new Error("範囲を置いていない地図では、真ん中のほかの描画面の位置に映る経度・緯度は無い");
    }
    return {
      lng: bounds.west + (x / width) * (bounds.east - bounds.west),
      lat: bounds.north - (y / height) * (bounds.north - bounds.south),
    };
  }

  /** 範囲と倍率を置き、動き終わった（"moveend"）ことを出す。 */
  moveTo(bounds: ViewBounds, zoom: number) {
    this.bounds = bounds;
    this.zoom = zoom;
    this.fire("moveend", {});
  }

  addControl() {
    return this;
  }

  resize() {
    return this;
  }

  flyTo() {
    return this;
  }

  /** 倍率と向きを、受けた値をそのまま今の値にする。 */
  jumpTo(options: { zoom?: number; bearing?: number } = {}) {
    if (options.zoom !== undefined) this.zoom = options.zoom;
    if (options.bearing !== undefined) this.turn(options.bearing, {});
    return this;
  }

  easeTo(options: { bearing?: number } = {}) {
    if (options.bearing !== undefined) this.turn(options.bearing, {});
    return this;
  }

  setBearing(bearing: number) {
    this.turn(bearing, {});
    return this;
  }

  /** 向きを変え、変わったら MapLibre と同じく "rotate" を出す。`event` は出来事の中身。 */
  turn(bearing: number, event: Record<string, unknown>) {
    if (bearing === this.bearing) return;
    this.bearing = bearing;
    this.fire("rotate", event);
  }

  getBearing() {
    return this.bearing;
  }

  isZooming() {
    return false;
  }

  fitBounds(bounds: FittedBounds["bounds"], options: { maxZoom?: number } = {}) {
    this.fits.push({ bounds, ...(options.maxZoom === undefined ? {} : { maxZoom: options.maxZoom }) });
    return this;
  }

  setStyle(style: string) {
    this.styles.push(style);
    this.content.dropEverything();
    return this;
  }

  isSourceLoaded() {
    return false;
  }

  /** テストが`placeTileFeatures`で置いた、そのソースの点の地物のうち、絞り込みに当たるもの。 */
  querySourceFeatures(sourceId: string, options: { filter?: unknown } = {}) {
    return this.tileFeatures(sourceId).filter((feature) => this.passes(options.filter, feature));
  }

  placeTileFeatures(sourceId: string, features: readonly GeoJSON.Feature<GeoJSON.Point>[]) {
    this.placedTileFeatures.set(sourceId, features);
  }

  /** 載っているレイヤー`layerId`が描く、置いたタイルの点の地物（隠したレイヤーは何も描かない）。 */
  drawnTileFeatures(layerId: string): GeoJSON.Feature<GeoJSON.Point>[] {
    const layer = this.content.layer(layerId);
    if (layer === undefined || layer.visibility === "none") return [];
    return this.tileFeatures(layer.source).filter((feature) => this.passes(layer.filter, feature));
  }

  private tileFeatures(sourceId: string | undefined): readonly GeoJSON.Feature<GeoJSON.Point>[] {
    return (sourceId === undefined ? undefined : this.placedTileFeatures.get(sourceId)) ?? [];
  }

  private passes(filter: unknown, feature: GeoJSON.Feature<GeoJSON.Point>): boolean {
    const [lng, lat] = feature.geometry.coordinates;
    return filter === undefined || matchesFilterAtPoint(filter, feature.properties ?? {}, [lng, lat]);
  }

  queryRenderedFeatures(_point: unknown, options: { layers?: readonly string[] } = {}) {
    return this.pointed
      .filter((feature) => options.layers === undefined || options.layers.includes(feature.layer))
      .map(asRendered);
  }

  remove() {
    const index = drawn.indexOf(this);
    if (index !== -1) drawn.splice(index, 1);
  }

  /** テストが起こす出来事。`event` は出来事の中身（利用者の操作なら `originalEvent` を持たせる）。 */
  emit(type: string, event: Record<string, unknown> = {}) {
    this.fire(type, event);
  }

  /** `lngLat` を押す。`features` はそこに描かれている地物で、無い・隠したレイヤーのものは渡せない（MapLibre は返さない）。 */
  click(lngLat: Coordinates, features: readonly PointedFeature[]) {
    const undrawn = features.filter((feature) => (this.content.layer(feature.layer)?.visibility ?? "none") === "none");
    if (undrawn.length > 0) {
      throw new Error(`描かれていないレイヤーの地物は押せない: ${undrawn.map((feature) => feature.layer).join(", ")}`);
    }
    this.pointed = features;
    try {
      this.fire("click", { lngLat: { lng: lngLat.longitude, lat: lngLat.latitude }, point: { x: 0, y: 0 } }, features);
    } finally {
      this.pointed = [];
    }
  }
}

/** いちばん後に描いた、まだ外していない地図。`inset`なら本体の地図に添える小さな地図の、そうでなければ本体の地図の。 */
export function lastDrawnMap(inset = false): StandInMap | undefined {
  return drawn.findLast((map) => map.inset === inset);
}
