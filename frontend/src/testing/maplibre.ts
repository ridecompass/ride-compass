/**
 * `maplibre-gl` の代役。地図の部品を本物で描くテストが、描画の手前（WebGL を要する所）で差し替えるのに使う
 * （.claude/rules/testing-frontend.md「確かめる高さ（frontend）」の境界の表の「テスト環境に無いブラウザの機能」）。
 *
 * 代役は MapLibre の振る舞いを真似ず、受けたものを記録して返すだけにする:
 * - ソース・レイヤー・地物の状態は `mapTrace/recordingMap.ts` へ記録し、`MapOnScreen` から読む。点は束ねない。
 * - 印（`Marker`）とポップアップ（`Popup`）は、渡された要素を地図の器へ置く（画面の問い合わせで引ける）。
 * - カメラの操作（`fitBounds`）とスタイルの取り直し（`setStyle`）は、引数を残す。向き（`setBearing`・`easeTo`・`jumpTo` の `bearing`）と
 *   倍率（`zoomIn`・`zoomOut`・`jumpTo` の `zoom`）は、受けた値をそのまま今の値にする（動きの途中は無い）。
 * - 操作を受けない地図（`interactive: false`。本体の地図に添える小さな地図）は、本体の地図と分けて `insetMapOnScreen` で引く。向きが変わったら "rotate" だけを出す。
 * - `addProtocol` で登録された受け手は、`protocolHandler` で引ける（テストが要求を渡して呼ぶ）。
 * - 出来事（"load"・"click" 等）は、上の "rotate" のほかは自分では起こさず、テストが `MapOnScreen` で起こす。押した所に描かれている地物も、
 *   テストが渡したものを返す。
 *
 * `vi.mock` は import より先へ巻き上げられるため、`vi.mock("maplibre-gl", () => import("@/testing/maplibre"))` の形で置く。
 */
import type { Coordinates } from "@/types/route";

import type { StyleLayer } from "./mapTrace/recordingMap";
import type { PointedFeature } from "./maplibreStandIn/evented";
import { lastDrawnMap, type FittedBounds, type StandInMap, type ViewBounds } from "./maplibreStandIn/map";

export type { PointedFeature } from "./maplibreStandIn/evented";
export { StandInMap as Map, type ViewBounds } from "./maplibreStandIn/map";
export { LngLatBounds, Marker, Popup } from "./maplibreStandIn/overlays";

const protocols = new Map<string, unknown>();

export function addProtocol(name: string, handler: unknown) {
  protocols.set(name, handler);
}

/** `addProtocol` でその名前に登録された受け手。 */
export function protocolHandler(name: string): unknown {
  return protocols.get(name);
}

export function setWorkerUrl() {}

/** いま描かれている地図。 */
export interface MapOnScreen {
  /** 出来事を起こす（"load"・"style.load" 等）。`event` は出来事の中身。 */
  emit(type: string, event?: Record<string, unknown>): void;
  /** スタイルを読み込んだ状態にする（`layers` はスタイルが最初から持つレイヤー。undefined なら読み込み中）。 */
  loadStyle(layers: readonly StyleLayer[] | undefined): void;
  /** `lngLat` を押す。`features` はそこに描かれている地物。 */
  click(lngLat: Coordinates, features?: readonly PointedFeature[]): void;
  /** いま表示しているレイヤーの id。 */
  visibleLayerIds(): string[];
  /** いま地図に載っているソースの id。 */
  sourceIds(): string[];
  /** GeoJSON のソースへ最後に渡された地物。ソースが無ければ空。 */
  sourceFeatures(sourceId: string): GeoJSON.Feature[];
  /** 地図に置いた印。 */
  markers(): { coordinates: Coordinates; draggable: boolean; element: HTMLElement }[];
  /** 地図を範囲へ寄せた（`fitBounds`）ときの範囲と倍率の上限を、寄せた順に。 */
  fits(): readonly FittedBounds[];
  /** 求めたスタイル（最初の1つと、取り直しの分）。 */
  readonly styles: readonly string[];
  /** いまの倍率。 */
  zoom(): number;
  /** いまの向き（真北0・時計回りの度）。 */
  bearing(): number;
  /** 利用者が地図を指で回す（向きを変えて "rotate" を出す）。 */
  rotateByHand(bearing: number): void;
  /** 利用者が地図を動かす（範囲と倍率を置いて "moveend" を出す）。 */
  moveTo(bounds: ViewBounds, zoom: number): void;
  /** 地物の状態（`setFeatureState` で載せたもの）。 */
  featureState(sourceId: string, featureId: string): Record<string, unknown> | undefined;
  /** レイヤーの今の塗りの宣言。無いレイヤーは undefined。 */
  layerPaint(layerId: string): Record<string, unknown> | undefined;
}

/** いま描かれている本体の地図。 */
export function mapOnScreen(): MapOnScreen {
  const map = lastDrawnMap();
  if (map === undefined) throw new Error("地図が描かれていない");
  return onScreen(map);
}

/** いま描かれている、本体の地図に添える小さな地図（操作を受けない地図）。無ければ null。 */
export function insetMapOnScreen(): MapOnScreen | null {
  const map = lastDrawnMap(true);
  return map === undefined ? null : onScreen(map);
}

function onScreen(map: StandInMap): MapOnScreen {
  return {
    emit: (type, event) => map.emit(type, event),
    loadStyle: (layers) => map.content.loadStyle(layers),
    click: (lngLat, features = []) => map.click(lngLat, features),
    visibleLayerIds: () => map.content.layerOrder().filter((id) => map.content.layer(id)?.visibility !== "none"),
    sourceIds: () => map.content.sources(),
    sourceFeatures: (sourceId) =>
      (map.content.sourceContent(sourceId)?.data as GeoJSON.FeatureCollection | undefined)?.features ?? [],
    markers: () =>
      [...map.markers].map((marker) => ({
        coordinates: { latitude: marker.getLngLat().lat, longitude: marker.getLngLat().lng },
        draggable: marker.draggable,
        element: marker.element,
      })),
    fits: () => map.fits,
    styles: map.styles,
    zoom: () => map.getZoom(),
    bearing: () => map.getBearing(),
    rotateByHand: (bearing) => {
      map.turn(bearing, { originalEvent: new Event("touchmove") });
    },
    moveTo: (bounds, zoom) => map.moveTo(bounds, zoom),
    featureState: (sourceId, featureId) => map.content.featureState(sourceId, featureId),
    layerPaint: (layerId) => map.content.layer(layerId)?.paint,
  };
}
