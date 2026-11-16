"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

import { POPUP_HANDLE_ATTRIBUTE } from "@/components/MapPopup/MapPopupParts";
import { visiblePadding } from "@/lib/routeFit";
import { visibleScreenBox } from "@/features/map/MapView/mapCamera";
import MapPopupContent, { type MapPopupContentProps } from "@/features/map/MapView/MapPopupContent";
import { popupInsideVisible, type ScreenBox } from "@/features/map/MapView/popupPlacement";
import type { MapPopup, MapPopupControls, PopupTarget, Shape } from "@/features/map/MapView/useMapPopups";

/** 押した物と小窓の間を空ける幅（px）。 */
const POPUP_GAP_PX = 8;

/** 小窓の幅の上限（Popup の`maxWidth`。`%`は地図の幅）。中身に合わせて広がり、地図の幅を超えるときだけ折り返す。 */
const POPUP_MAX_WIDTH = "calc(100% - 1.5rem)";

/**
 * ずらした小窓が、見えている所に残す幅と高さ（px）。上の帯の右端の3つのアイコン（`MapPopupParts.tsx: PopupHeader`の右の空き）より広く
 * 残し、つまんで戻せる所が見えているようにする。
 */
const DRAGGED_POPUP_KEEP_PX = 128;

/** 押した所を指さない（ずらした・押し込めた）小窓に付ける印。矢印を隠す（`app/globals.css`）。 */
const FREE_POPUP_CLASS = "map-popup-free";

type MapPopupMountOptions = Omit<MapPopupContentProps, "popup" | "target"> & {
  shown: MapPopup | null;
  controls: MapPopupControls;
  /** 選んでいる区間の形。形が引けなければnull。 */
  segmentPath: Shape | null;
};

function targetOf(popup: MapPopup, segmentPath: Shape | null): PopupTarget {
  return popup.kind === "segment"
    ? { lngLat: [popup.segment.longitude, popup.segment.latitude], shape: segmentPath }
    : { lngLat: popup.lngLat, shape: popup.shape };
}

/** 小窓を地図へ載せ、中身をportalで描く。返した要素を地図の部品の中に置く。 */
export function useMapPopupMount(
  mapRef: RefObject<MapLibreMap | null>,
  {
    shown,
    controls,
    segmentDetail,
    segmentPath,
    routePath,
    travelBearing,
    rideConditions,
    costPreference,
    travelledKm,
    onBackToSegment,
    onFocus,
  }: MapPopupMountOptions,
): ReactNode {
  const onMap = shown !== null && (shown.kind !== "segment" || segmentDetail !== null) ? shown : null;
  // 区間の小窓は、選び直す（グラフをなぞる）たびに作り直さず、同じ器を指す地点だけ動かす。ほかの中身は入れ替えるたびに器を作り直す
  // （前の中身の部品の状態を、新しい中身へ持ち越さない）。
  const mountKey: MapPopup | "segment" | null = onMap === null ? null : onMap.kind === "segment" ? "segment" : onMap;
  const [mount, setMount] = useState<{ key: MapPopup | "segment"; container: HTMLDivElement } | null>(null);
  // 器を作ったあとに変わる値（区間の選び・区間の形）は、置き直すときに読む。
  const latest = useRef({ onMap, segmentPath });
  const placeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    latest.current = { onMap, segmentPath };
    placeRef.current?.();
  }, [onMap, segmentPath]);

  useEffect(() => {
    const map = mapRef.current;
    const first = latest.current.onMap;
    if (!map || mountKey === null || first === null) return;
    const container = document.createElement("div");
    const { lngLat: firstLngLat } = targetOf(first, latest.current.segmentPath);
    // 地図を押して閉じるのは押した手続き（`mapTaps.ts`）が決めるので、MapLibreには閉じさせない。地図の上に重ねた部品の下には、
    // 標準の`padding`で入れない。
    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: POPUP_MAX_WIDTH,
      padding: visiblePadding(map.getCanvas()),
      offset: POPUP_GAP_PX,
    })
      .setLngLat(firstLngLat)
      .setDOMContent(container)
      .addTo(map);
    setMount({ key: mountKey, container });
    const shownMap = map;
    const element = popup.getElement();
    // 上の帯をつまんでずらした小窓の、指す地点から見た左上のずれ（px）。ずらすまではnull。
    let moved: [number, number] | null = null;

    /** 小窓の、地図の上の矩形（px）。 */
    function popupBox(): ScreenBox {
      const box = element.getBoundingClientRect();
      const canvas = shownMap.getCanvas().getBoundingClientRect();
      return {
        left: box.left - canvas.left,
        top: box.top - canvas.top,
        right: box.right - canvas.left,
        bottom: box.bottom - canvas.top,
      };
    }

    /** 小窓の左上を、指す地点からのずれで置く。押した所を指さなくなるので、矢印を出さない。 */
    function placeFree(offset: [number, number]) {
      popup.options.anchor = "top-left";
      popup.addClassName(FREE_POPUP_CLASS);
      popup.setOffset(offset);
    }

    // 小窓は押した所を指し、ずらすまでは向き（上下左右）をMapLibreが地図の枠に収まる側から選ぶ。ずらした後は、指す地点からのずれを
    // 保つ（地図を動かすと一緒に動く）。ずらす前は、見えている所からはみ出す分を内側へ押し込める——MapLibreは向きを選ぶだけで中へは
    // ずらさないので、上にも下にも収まらない背の高い小窓や、端の近くで開いた小窓が画面の外へ出る。ずらした後は、上の帯の一部が
    // 見えている所に残る分だけ押し込める——全体を押し込めると、地図の幅いっぱいの小窓は横へずらせない。
    function place() {
      const current = latest.current.onMap;
      if (current === null) return;
      const { lngLat } = targetOf(current, latest.current.segmentPath);
      // 地図の上に重ねた部品（シート等）は開いた後に大きさが変わるので、置き直すたびに測り直す。
      const padding = visiblePadding(shownMap.getCanvas());
      popup.options.padding = padding;
      if (moved === null) {
        popup.options.anchor = undefined;
        popup.removeClassName(FREE_POPUP_CLASS);
        popup.setOffset(POPUP_GAP_PX);
      } else placeFree(moved);
      popup.setLngLat(lngLat);
      const box = popupBox();
      const inside = popupInsideVisible(
        box,
        visibleScreenBox(shownMap, padding),
        moved === null ? undefined : DRAGGED_POPUP_KEEP_PX,
      );
      if (inside === null || (inside.left === box.left && inside.top === box.top)) return;
      const at = shownMap.project(lngLat);
      placeFree([inside.left - at.x, inside.top - at.y]);
    }
    placeRef.current = place;
    place();

    /** 今の小窓の左上の、指す地点からのずれ。 */
    function currentOffset(): [number, number] {
      const at = shownMap.project(popup.getLngLat());
      const box = popupBox();
      return [box.left - at.x, box.top - at.y];
    }
    // 上の帯（ボタン・リンクを除く）を押したまま動かすと、小窓が指に付いて動く。離した所を、押し込めた後の見えている位置で保つ。
    let drag: { pointerId: number; x: number; y: number; from: [number, number] } | null = null;
    function startDrag(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(`[${POPUP_HANDLE_ATTRIBUTE}]`) === null) return;
      if (target.closest("button, a") !== null) return;
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, from: currentOffset() };
      element.setPointerCapture(event.pointerId);
    }
    function moveDrag(event: PointerEvent) {
      if (drag?.pointerId !== event.pointerId) return;
      moved = [drag.from[0] + event.clientX - drag.x, drag.from[1] + event.clientY - drag.y];
      place();
    }
    function endDrag(event: PointerEvent) {
      if (drag?.pointerId !== event.pointerId) return;
      drag = null;
      moved = currentOffset();
    }
    element.addEventListener("pointerdown", startDrag);
    element.addEventListener("pointermove", moveDrag);
    element.addEventListener("pointerup", endDrag);
    element.addEventListener("pointercancel", endDrag);

    // 中身が伸び縮みしたら（評価を取る・畳みを開く）、置き直す。MapLibreは地図が動いたときにしか向きを決め直さないので、
    // 開いた後に伸びた中身が画面の外へはみ出す。置き直すのは中身の大きさが変わったときだけ（向きが変わると枠の組み方が動き、
    // 同じ大きさの通知が来る）。地図が動き終えたときも置き直す。
    let observed = "";
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(([entry]) => {
            const size = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
            if (size === observed) return;
            observed = size;
            place();
          });
    resize?.observe(container);
    map.on("moveend", place);
    popup.on("close", controls.close);
    return () => {
      element.removeEventListener("pointerdown", startDrag);
      element.removeEventListener("pointermove", moveDrag);
      element.removeEventListener("pointerup", endDrag);
      element.removeEventListener("pointercancel", endDrag);
      resize?.disconnect();
      map.off("moveend", place);
      popup.off("close", controls.close);
      popup.remove();
      placeRef.current = null;
      setMount(null);
    };
  }, [mapRef, mountKey, controls]);

  if (onMap === null || mount?.key !== mountKey) return null;
  return createPortal(
    <MapPopupContent
      popup={onMap}
      target={targetOf(onMap, segmentPath)}
      segmentDetail={segmentDetail}
      routePath={routePath}
      travelBearing={travelBearing}
      rideConditions={rideConditions}
      costPreference={costPreference}
      travelledKm={travelledKm}
      onBackToSegment={onBackToSegment}
      onFocus={onFocus}
    />,
    mount.container,
  );
}
