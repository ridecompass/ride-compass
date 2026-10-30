"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { RoutePreferenceWeights, SelectedRouteSegment } from "@/types/route";
import {
  BackToSegmentButton,
  FacilityRows,
  POPUP_HANDLE_ATTRIBUTE,
  PopupHeader,
} from "@/components/MapPopup/MapPopupParts";
import type { Facility, FacilityOrigin } from "@/components/MapPopup/facilityRows";
import { Button } from "@/components/ui/Button/Button";
import { ShowSectionOnMapIcon } from "@/components/ui/icons/lucideIcons";
import type { RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import { visiblePadding } from "@/lib/routeFit";
import type { RideConditions } from "@/features/map/regionApi";
import type { TileXY } from "@/features/map/layers/dynamicWayValues";
import RoadInspectorPopup from "@/features/map/MapView/RoadInspectorPopup";
import type { RoadSurfacePopupProperties } from "@/features/map/MapView/roadFacts";
import { SELECTED_POINT_PIN_HEIGHT_PX } from "@/features/map/MapView/useMapMarkers";
import { visibleScreenBox } from "@/features/map/MapView/mapCamera";
import { popupInsideVisible, type ScreenBox } from "@/features/map/MapView/popupPlacement";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";

/** 押した物と小窓の間を空ける幅。区間は押した所に置く印（下端を地点に置いた絵）の高さだけ空ける。 */
const SEGMENT_POPUP_GAP_PX = SELECTED_POINT_PIN_HEIGHT_PX + 2;
const POPUP_GAP_PX = 8;

/** 小窓の幅の上限（Popup の`maxWidth`。`%`は地図の幅）。中身に合わせて広がり、地図の幅を超えるときだけ折り返す。 */
const POPUP_MAX_WIDTH = "calc(100% - 1.5rem)";

/**
 * ずらした小窓が、見えている所に残す幅と高さ（px）。上の帯の右端の2つのアイコン（`MapPopupParts.tsx: PopupHeader`の右の空き）より広く
 * 残し、つまんで戻せる所が見えているようにする。
 */
const DRAGGED_POPUP_KEEP_PX = 96;

/** 押した所を指さない（ずらした・押し込めた）小窓に付ける印。矢印を隠す（`app/globals.css`）。 */
const FREE_POPUP_CLASS = "map-popup-free";

/** 地図の座標の並び（押した物の形）。 */
type Shape = readonly [number, number][];

/**
 * 地図の小窓に出している中身。小窓はいつも1つで、最後に押した物の中身を出す。点と道は押して開き、区間は選んでいる区間から導く
 * （区間を選んでいて、押して開いた中身が無ければ区間の中身）。`segment`は開いた中身が属する、選んでいる区間で、区間の選びが
 * 変わったら閉じる。`shape`は押した物の形で、寄せるアイコンはこれへ寄せる。
 */
export type MapPopup =
  /** 押した所に描かれている名前のある点。区間を選んでいる間に開いたら`segment`はその区間で、区間の中身へ戻れる。 */
  | {
      kind: "point";
      lngLat: [number, number];
      facilities: readonly Facility[];
      shape: Shape;
      segment: SelectedRouteSegment | null;
    }
  /** 押した道。`tile`は押した瞬間のタイル（開いたままズームしても、押した道のタイルを指す）。`track`は押した道の線が入る
   * 凡例の行（地図の道の色と道の種類の名前）。 */
  | {
      kind: "road";
      lngLat: [number, number];
      properties: RoadSurfacePopupProperties;
      tile: TileXY;
      track: RoadTrackRow | null;
      shape: Shape;
      segment: null;
    }
  /** 選んでいる区間（中身はページが描く）。 */
  | { kind: "segment"; segment: SelectedRouteSegment };

/** 押して開く中身（区間の中身は選びから導くので持たない）。 */
type OpenedPopup = Exclude<MapPopup, { kind: "segment" }>;

/** 地図を押した手続き（`mapTaps.ts`）が小窓を開く・閉じる口。地図を作るときに一度だけ結ぶので、どれも同じ関数のまま変わらない。 */
export interface MapPopupControls {
  /** 点を開く。区間を選んでいれば、区間の選びを残し、区間の中身へ戻れる。 */
  openPoint: (lngLat: [number, number], facilities: readonly Facility[], shape: Shape) => void;
  /** 道を開き、区間の選びを外す。 */
  openRoad: (
    road: Pick<Extract<MapPopup, { kind: "road" }>, "lngLat" | "properties" | "tile" | "track" | "shape">,
  ) => void;
  /** 小窓を閉じ、区間の選びを外す。 */
  close: () => void;
}

/**
 * 地図の小窓の状態と、開く・閉じる手続き。選択の持ち主（`selectionOwner`）が変わると、押して開いた中身を閉じる。
 * 小窓を地図へ載せるのは`useMapPopupMount`で、地図を作るeffectより後に呼ぶ。
 */
export function useMapPopups(
  selectionOwner: string | null,
  selectedRouteSegment: SelectedRouteSegment | null,
  onRouteSegmentSelect: (selection: null) => void,
) {
  const [opened, setOpened] = useState<OpenedPopup | null>(null);
  // 持ち主が変わったら、押して開いた中身を閉じる。区間の選びが変わったら、その区間に属さない中身を閉じる（選んだ区間の中身を出す）。
  const [seen, setSeen] = useState({ selectionOwner, selectedRouteSegment });
  if (seen.selectionOwner !== selectionOwner || seen.selectedRouteSegment !== selectedRouteSegment) {
    setSeen({ selectionOwner, selectedRouteSegment });
    if (seen.selectionOwner !== selectionOwner || opened?.segment !== selectedRouteSegment) setOpened(null);
  }
  const segmentPopup = useMemo<MapPopup | null>(
    () => (selectedRouteSegment === null ? null : { kind: "segment", segment: selectedRouteSegment }),
    [selectedRouteSegment],
  );
  const shown: MapPopup | null = opened ?? segmentPopup;

  // 手続きは地図のイベントから呼ばれるので、いまの値を参照で読む。
  const latest = useRef({ selectedRouteSegment, onRouteSegmentSelect });
  useEffect(() => {
    latest.current = { selectedRouteSegment, onRouteSegmentSelect };
  });

  const controls = useMemo<MapPopupControls>(() => {
    const deselect = () => {
      if (latest.current.selectedRouteSegment !== null) latest.current.onRouteSegmentSelect(null);
    };
    return {
      openPoint: (lngLat, facilities, shape) =>
        setOpened({ kind: "point", lngLat, facilities, shape, segment: latest.current.selectedRouteSegment }),
      openRoad: (road) => {
        setOpened({ kind: "road", ...road, segment: null });
        deselect();
      },
      close: () => {
        setOpened(null);
        deselect();
      },
    };
  }, []);

  /** 点の小窓から、選んでいる区間の中身へ戻る。 */
  const backToSegment = useCallback(() => setOpened(null), []);

  return { shown, controls, backToSegment };
}

interface MapPopupMountOptions {
  shown: MapPopup | null;
  controls: MapPopupControls;
  /** 選んでいる区間の中身（ページが描く）。出さなければnullで、区間の小窓を出さない。 */
  segmentDetail: ReactNode | null;
  /** 選んでいる区間の形。形が引けなければnull。 */
  segmentPath: Shape | null;
  rideConditions: RideConditions;
  routePreference: RoutePreferenceWeights | null;
  /** 施設の位置を前後で言う基準の地点。 */
  facilityOrigin: FacilityOrigin | null;
  /** 点の小窓から区間の中身へ戻る。 */
  onBackToSegment: () => void;
  /** 寄せるアイコンを押したとき。押した物の形へ地図を寄せる。 */
  onFocus: (shape: Shape) => void;
}

/** 小窓が指す地点・押した物の形（引けなければnull）・指す地点との間を空ける幅。どの小窓もこれだけで置く。 */
function targetOf(
  popup: MapPopup,
  segmentPath: Shape | null,
): { lngLat: [number, number]; shape: Shape | null; gapPx: number } {
  if (popup.kind === "segment") {
    return {
      lngLat: [popup.segment.longitude, popup.segment.latitude],
      shape: segmentPath,
      gapPx: SEGMENT_POPUP_GAP_PX,
    };
  }
  return { lngLat: popup.lngLat, shape: popup.shape, gapPx: POPUP_GAP_PX };
}

/** 小窓を地図へ載せ、中身をportalで描く。返した要素を地図の部品の中に置く。 */
export function useMapPopupMount(
  mapRef: RefObject<MapLibreMap | null>,
  {
    shown,
    controls,
    segmentDetail,
    segmentPath,
    rideConditions,
    routePreference,
    facilityOrigin,
    onBackToSegment,
    onFocus,
  }: MapPopupMountOptions,
): ReactNode {
  const catalog = useAxisCatalog();
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
    const { lngLat: firstLngLat, gapPx } = targetOf(first, latest.current.segmentPath);
    // 地図を押して閉じるのは押した手続き（`mapTaps.ts`）が決めるので、MapLibreには閉じさせない。地図の上に重ねた部品の下には、
    // 標準の`padding`で入れない。間の幅は器の間は変わらない（区間の器は区間の中身にだけ使う）。
    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: POPUP_MAX_WIDTH,
      padding: visiblePadding(map.getCanvas()),
      offset: gapPx,
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
        popup.setOffset(gapPx);
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
  const { shape } = targetOf(onMap, segmentPath);
  return createPortal(
    // 高さに上限を付け、あふれたら中でスクロールする——地図の上の枠は、中身が伸びても画面の外へ出てはいけない。縦をスクロールに
    // すると横も切り取られるので、端に接する見本の枠（箱の1px外に描く`ring`）が欠けないよう、四辺に1pxの余白を置く。
    <div className="max-h-[min(24rem,50vh)] overflow-y-auto p-px text-[length:var(--font-size-md)] leading-[1.4]">
      {shape !== null && shape.length > 0 && (
        // ×（MapLibreが本文の器の右上に置く）の左に並べる。幅を×と同じに詰め、上の帯のつまめる所を広く残す。
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-0 right-8 h-11"
          aria-label="地図をここへ寄せる"
          usage="地図を、この小窓の物へ寄せます。押しただけでは地図は動きません。"
          onClick={() => onFocus(shape)}
        >
          <ShowSectionOnMapIcon size={18} />
        </Button>
      )}
      {onMap.kind === "road" ? (
        <RoadInspectorPopup
          properties={onMap.properties}
          track={onMap.track}
          axes={catalog.axes}
          axisColors={catalog.axisColors}
          conditions={{
            ...rideConditions,
            ...onMap.tile,
          }}
          routePreference={routePreference}
        />
      ) : onMap.kind === "segment" ? (
        segmentDetail
      ) : (
        <PointContent popup={onMap} origin={facilityOrigin} onBack={onBackToSegment} />
      )}
    </div>,
    mount.container,
  );
}

/** 点の中身: 施設の行。区間を選んでいる間に開いたなら、上の帯に区間の中身へ戻る操作を置く。 */
function PointContent({
  popup,
  origin,
  onBack,
}: {
  popup: Extract<MapPopup, { kind: "point" }>;
  origin: FacilityOrigin | null;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <PopupHeader label="点の小窓の上の帯">
        {popup.segment !== null && <BackToSegmentButton onBack={onBack} />}
      </PopupHeader>
      <FacilityRows facilities={popup.facilities} origin={origin} />
    </div>
  );
}
