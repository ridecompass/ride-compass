/** 地図（`Map`）の代役。中身は `../mapTrace/recordingMap.ts` へ記録し、描いた地図を `lastDrawnMap` で引ける。 */
import type { Coordinates } from "@/types/route";

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
  // 手ぶりの入切は、代役では指の操作が無いので受けるだけにする。
  readonly touchZoomRotate = { disableRotation() {}, enableRotation() {} };

  constructor(options: { container: HTMLElement; style: string; zoom: number }) {
    super();
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

  querySourceFeatures() {
    return [];
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
      let defaultPrevented = false;
      const event = {
        lngLat: { lng: lngLat.longitude, lat: lngLat.latitude },
        point: { x: 0, y: 0 },
        preventDefault: () => {
          defaultPrevented = true;
        },
        get defaultPrevented() {
          return defaultPrevented;
        },
      };
      this.fire("click", event, features);
    } finally {
      this.pointed = [];
    }
  }
}

/** いちばん後に描いた、まだ外していない地図。 */
export function lastDrawnMap(): StandInMap | undefined {
  return drawn.at(-1);
}
