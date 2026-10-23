"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type * as maplibregl from "maplibre-gl";
import type { ErrorEvent as MapLibreErrorEvent, Map as MapLibreMap } from "maplibre-gl";

import type { Coordinates } from "@/types/route";
import { createBaseMap } from "@/features/map/baseMap";
import { mapStyleUrl } from "@/features/map/regionApi";
import { isStyleReady, reloadStyle } from "@/features/map/layers/mapStyleOps";
import { registerJmaTileProtocol } from "@/features/map/layers/jmaTileProtocol";
import type { MapLook } from "@/features/map/view/mapLook";
import type { LayerDataStatusByLayer, MapLayerDescriptor } from "@/features/map/layers/mapLayers";
import { buildLayerDataSources } from "@/features/map/MapView/layerDataSources";
import { useLayerDataStatus } from "@/features/map/MapView/useLayerDataStatus";
import { ORIGIN_ZOOM } from "@/features/map/MapView/useMapMarkers";
import { debugLog } from "@/lib/debugLog";
import { roundToDigits } from "@/lib/numberFormat";

// 初期表示の覆い（「地図を読み込み中…」）を出しておく上限。覆いは基礎地図が描けた時点（"load"）で外すので、
// これは基礎地図のタイルが止まって"load"が来ないときの保険。
const INITIAL_TILES_OVERLAY_MAX_MS = 6000;

interface MapLifecycleOptions {
  /** 地図を作るときの中心。作ったあとは読まない。 */
  initialCenter: Coordinates;
  /** 地図を作った直後に、押す操作を結ぶ。返した関数で外す。 */
  bindInteractions: (map: MapLibreMap) => () => void;
  /** いまの見え方。表示ON/OFFと、範囲・取得状態の知らせ先をイベントの瞬間に読む。同じ関数を渡し続ける。 */
  getLook: () => MapLook;
  /** レイヤーカタログ。取得状態を算出するレイヤーの母集団。 */
  layers: readonly MapLayerDescriptor[];
  /** 「地図の表示を再描画」を押した回数。増えるとスタイルを取り直す。 */
  refreshToken: number;
  /** スタイルを取り直した後、いまの宣言を空から当て直す。 */
  redraw: (map: MapLibreMap) => void;
}

/**
 * 地図を作り、生涯のイベント（読み込み・失敗・動かした範囲・向き・ソースの取得）を状態と知らせ先へつなぐ。レイヤーごとの
 * 取得状態は`recomputeLayerDataStatus`でも数え直せる。地図の上に
 * 載せるもののeffect（印・小窓）は地図ができてから走るよう、このフックより後に呼ぶ。
 */
export function useMapLifecycle(
  containerRef: RefObject<HTMLDivElement | null>,
  mapRef: RefObject<MapLibreMap | null>,
  { initialCenter, bindInteractions, getLook, layers, refreshToken, redraw }: MapLifecycleOptions,
) {
  // 方位磁針の針とダイヤルが指す地図の向き。
  const [mapBearing, setMapBearing] = useState(0);
  // スタイルが取れないとMapLibreは"load"ではなく"error"だけを出し、地図は白紙のまま止まる。そのとき案内を出す。
  const [styleLoadFailed, setStyleLoadFailed] = useState(false);
  // スタイルを取り直している間（"style.load"待ち）。最初の"load"は地図の生涯で1度しか来ないため、取り直しの
  // 失敗はこの印で見分ける。
  const styleReloadPendingRef = useRef(false);
  // 取り直しの"style.load"の待ちを外す。取り直しが取れなかったあとに押し直したとき、前の待ちを外す。
  const cancelStyleReloadRef = useRef<(() => void) | null>(null);
  // 最初のタイルが揃うまでの白紙を覆う。
  const [initialTilesLoading, setInitialTilesLoading] = useState(true);
  const layerDataSources = useMemo(() => buildLayerDataSources(layers), [layers]);
  const getVisibility = useCallback(() => getLook().layerVisibility, [getLook]);
  const onChange = useCallback(
    (status: LayerDataStatusByLayer) => getLook().onLayerDataStatusChange(status),
    [getLook],
  );
  const layerDataStatus = useLayerDataStatus({ mapRef, layerDataSources, getVisibility, onChange });
  // 地図の出来事は初期化のeffectで一度だけ結ぶので、いまのレイヤーカタログで数える関数をここから読む（カタログは軸カタログが
  // 届くと道の層が増える）。
  const layerDataStatusRef = useRef(layerDataStatus);
  useEffect(() => {
    layerDataStatusRef.current = layerDataStatus;
  });

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Mapを作る前に要る（スタイルの適用でタイル要求が始まる）。
    registerJmaTileProtocol();

    // 片付けた後に"idle"が届いても状態を書かない。
    let cancelled = false;

    const center: [number, number] = [initialCenter.longitude, initialCenter.latitude];
    const map = createBaseMap({ container: containerRef.current, center, zoom: ORIGIN_ZOOM });
    mapRef.current = map;
    debugLog("map:lifecycle", "初期化", { center, zoom: ORIGIN_ZOOM });

    // MapLibreの内蔵の追従は、デバッグログの流入とレイアウトの変化が重なると通知を取りこぼし、地図が幅の一部に
    // しか描かれなくなる。コンテナの大きさが変わったら明示的にresizeする。
    const resizeObserver = new ResizeObserver(() => {
      mapRef.current?.resize();
    });
    resizeObserver.observe(containerRef.current);
    const unbindInteractions = bindInteractions(map);

    // "load"は載っているすべてのタイルが揃った最初の描画で来る。アプリのソースは"load"の後に足す
    // （runWhenStyleReady）ので、この時点で描けているのは基礎地図だけ——覆いはここで外す。"idle"は
    // アプリのソースの取得まで待つので、遅い外部データが1つあると描けた地図を覆ったままになる。
    function handleLoad() {
      debugLog("map:lifecycle", "load（スタイル読み込み完了）");
      setStyleLoadFailed(false);
      setInitialTilesLoading(false);
    }
    function handleMapError(e: MapLibreErrorEvent) {
      const sourceId = (e as unknown as { sourceId?: string }).sourceId;
      // 取り直しのスタイルが取れない（取得・検証の失敗）と、ソースを持たない"error"だけが来て"style.load"は来ない。
      // 押し直せるよう待ちの印を下ろす。
      const reloadFailed = styleReloadPendingRef.current && sourceId === undefined;
      if (reloadFailed) styleReloadPendingRef.current = false;
      // 有効なスタイルが無いときの失敗は致命的（地図が白紙のまま）。それ以外の大半はタイル1枚の一過性の
      // 失敗で、次の取得で直るため警告にとどめる。
      const isFatal = !isStyleReady(map) || reloadFailed;
      debugLog("map:error", e.error?.message ?? "unknown error", { sourceId }, isFatal ? "error" : "warn");
      if (isFatal) {
        setStyleLoadFailed(true);
        setInitialTilesLoading(false);
      }
      if (sourceId) layerDataStatusRef.current.markSourceErrored(sourceId);
    }
    function handleFirstIdle() {
      if (cancelled) return;
      layerDataStatusRef.current.recompute();
      // 一度も動かさなくても、初期位置の範囲を取りに行けるよう伝える。
      reportViewport();
    }
    function handleTrackedSourceDataLoading(e: maplibregl.MapSourceDataEvent) {
      layerDataStatusRef.current.clearSourceLoading(e.sourceId);
    }
    function handleTrackedSourceData(e: maplibregl.MapSourceDataEvent) {
      layerDataStatusRef.current.notifySourceData(e.sourceId);
    }
    // 見えている範囲だけを取りに行くレイヤーへ、今の範囲を渡す（間引きは受け取る側）。
    function reportViewport() {
      const bounds = map.getBounds();
      if (!bounds) return;
      getLook().onViewportChange({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
      });
    }
    function handleMoveEnd() {
      const bounds = map.getBounds();
      debugLog("map:viewport", "moveend", {
        zoom: roundToDigits(map.getZoom(), 2),
        bounds: bounds
          ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((n) => roundToDigits(n, 4))
          : null,
      });
      layerDataStatusRef.current.settleViewport();
      reportViewport();
    }
    // ズームの終わりは後に"moveend"が続くのでそちらで受ける。動いている最中のresizeはmoveendを出さず"resize"だけを
    // 出すので、ここで受ける。範囲を渡さないと、広がった所が塗られない。
    function handleResize() {
      debugLog("map:viewport", "resize", { zoom: roundToDigits(map.getZoom(), 2) });
      layerDataStatusRef.current.settleViewport();
      reportViewport();
    }
    // 読み込み済みになった直後の一瞬は地物がまだ引けず、そこで数えると「空」に確定しうるため、"idle"でも数え直す。
    // "idle"では取得失敗を解除しない（settleViewportを呼ばない）——範囲が変わらなくても来るうえ、失敗したタイルも
    // 「読み込み済み」に数えられるため、続いている障害を「データなし」に化けさせる。
    function handleIdleRecompute() {
      layerDataStatusRef.current.recompute();
    }
    function handleRotate() {
      setMapBearing(map.getBearing());
    }

    map.on("load", handleLoad);
    map.on("error", handleMapError);
    map.on("moveend", handleMoveEnd);
    map.on("resize", handleResize);
    map.on("sourcedataloading", handleTrackedSourceDataLoading);
    map.on("sourcedata", handleTrackedSourceData);
    map.on("idle", handleIdleRecompute);
    map.on("rotate", handleRotate);
    map.once("idle", handleFirstIdle);
    const initialOverlayTimer = window.setTimeout(() => {
      if (!cancelled) setInitialTilesLoading(false);
    }, INITIAL_TILES_OVERLAY_MAX_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initialOverlayTimer);
      resizeObserver.disconnect();
      unbindInteractions();
      map.off("load", handleLoad);
      map.off("error", handleMapError);
      map.off("moveend", handleMoveEnd);
      map.off("resize", handleResize);
      map.off("sourcedataloading", handleTrackedSourceDataLoading);
      map.off("sourcedata", handleTrackedSourceData);
      map.off("idle", handleIdleRecompute);
      map.off("rotate", handleRotate);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 「地図の表示を再描画」: スタイルを取り直し、消えたレイヤーをいまの宣言から当て直す（押した人の地図だけ）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || refreshToken === 0) return;
    // 連打で取り直しを重ねない（新しい取り直しが前の読み込みを打ち切ると、当て直しが一度も走らない）。
    if (styleReloadPendingRef.current) return;
    styleReloadPendingRef.current = true;
    cancelStyleReloadRef.current?.();

    // クエリでスタイルURLを変えることで、ブラウザのHTTPキャッシュではなく取り直しにする。
    cancelStyleReloadRef.current = reloadStyle(map, `${mapStyleUrl()}?t=${Date.now()}`, () => {
      styleReloadPendingRef.current = false;
      cancelStyleReloadRef.current = null;
      setStyleLoadFailed(false);
      redraw(map);
    });
  }, [mapRef, refreshToken, redraw]);

  return { mapBearing, styleLoadFailed, initialTilesLoading, recomputeLayerDataStatus: layerDataStatus.recompute };
}
