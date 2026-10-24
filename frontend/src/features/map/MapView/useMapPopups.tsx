"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { Position } from "geojson";

import type { RoutePreferenceWeights, SelectedRouteSegment } from "@/types/route";
import { BackToSegmentButton, FacilityRows, PopupHeader } from "@/components/MapPopup/MapPopupParts";
import type { Facility, FacilityOrigin } from "@/components/MapPopup/facilityRows";
import type { RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import type { RideConditions } from "@/features/map/regionApi";
import type { TileXY } from "@/features/map/layers/dynamicWayValues";
import { CHOSEN_SIDE_POINT_OUTER_RADIUS_PX } from "@/features/map/scene/groups/sidePoints";
import RoadInspectorPopup from "@/features/map/MapView/RoadInspectorPopup";
import type { RoadSurfacePopupProperties } from "@/features/map/MapView/roadFacts";
import { SELECTED_POINT_PIN_HEIGHT_PX } from "@/features/map/MapView/useMapMarkers";
import { pathScreenBox, visibleScreenBox } from "@/features/map/MapView/mapCamera";
import { popupPlacementAround } from "@/features/map/MapView/popupPlacement";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";

// 区間の小窓を、押した区間の印（下端を地点に置いた絵）の上へ出すずれ。
const SEGMENT_POPUP_OFFSET_PX = SELECTED_POINT_PIN_HEIGHT_PX + 2;

/** 小窓の幅の上限。どの中身も同じにする（入れ替えるたびに幅が跳ねない）。 */
const POPUP_WIDEST = "20rem";

/**
 * 小窓の幅の上限（CSSの`max-width`。`%`は小窓を置く地図の幅）。MapLibreは押した所が地図の左右の端から小窓の幅の半分以内のときだけ
 * 横向きに開くので、小窓の幅が地図の幅から横のずれを引いた2/3以下なら、どの向きでも地図の中に収まる。幅の狭い画面で
 * これより広いと、縦の中ほどで端に寄った所を押したとき、押した所の横に開いて画面の外へはみ出す。
 */
function popupMaxWidth(offsetPx: number): string {
  return `min(${POPUP_WIDEST}, calc((100% - ${offsetPx}px) * 2 / 3))`;
}

/**
 * 地図の小窓に出している中身。小窓はいつも1つで、最後に押した物の中身を出す。`segment`はその中身が属する、地図で押した区間で、
 * 小窓を閉じる・その区間に属さない中身へ入れ替えると区間の選びを外す。区間の選びが別の所（パネル・印）で変わったら出さない。
 */
export type MapPopup =
  /** 地点のピン（呼び名と名前の1行）。 */
  | { kind: "pin"; lngLat: [number, number]; text: string; segment: null }
  /** 点。区間の近くの施設なら`segment`はその区間で、区間の中身へ戻れる。 */
  | { kind: "point"; lngLat: [number, number]; facility: Facility; segment: SelectedRouteSegment | null }
  /** 押した道。`tile`は押した瞬間のタイル（開いたままズームしても、押した道のタイルを指す）。`track`は押した道の線が入る
   * 凡例の行（地図の道の色と道の種類の名前）。 */
  | {
      kind: "road";
      lngLat: [number, number];
      properties: RoadSurfacePopupProperties;
      tile: TileXY;
      track: RoadTrackRow | null;
      segment: null;
    }
  /** 地図で押した区間（中身はページが描く）。 */
  | { kind: "segment"; segment: SelectedRouteSegment };

/** 地図を押した手続き（`mapTaps.ts`）が小窓を開く・閉じる口。地図を作るときに一度だけ結ぶので、どれも同じ関数のまま変わらない。 */
export interface MapPopupControls {
  openPin: (lngLat: [number, number], text: string) => void;
  openPoint: (lngLat: [number, number], facility: Facility) => void;
  /** 区間の近くの施設。区間の中身を出している間に開くと、区間の選びを残して戻れるようにする。 */
  openSidePoint: (lngLat: [number, number], facility: Facility) => void;
  openRoad: (road: Pick<Extract<MapPopup, { kind: "road" }>, "lngLat" | "properties" | "tile" | "track">) => void;
  showSegment: (segment: SelectedRouteSegment) => void;
  close: () => void;
}

/**
 * 地図の小窓の状態と、開く・閉じる手続き。選択の持ち主（`selectionOwner`）が変わると、開いている小窓を閉じる。
 * 小窓を地図へ載せるのは`useMapPopupMount`で、地図を作るeffectより後に呼ぶ。
 */
export function useMapPopups(
  selectionOwner: string | null,
  selectedRouteSegment: SelectedRouteSegment | null,
  onRouteSegmentSelect: (selection: null) => void,
) {
  const [popup, setPopup] = useState<MapPopup | null>(null);
  const [popupOwner, setPopupOwner] = useState(selectionOwner);
  if (popupOwner !== selectionOwner) {
    setPopupOwner(selectionOwner);
    setPopup(null);
  }
  const shown = popup !== null && popup.segment !== null && popup.segment !== selectedRouteSegment ? null : popup;

  // 手続きは地図のイベントから呼ばれるので、いまの値を参照で読む。
  const latest = useRef({ shown, onRouteSegmentSelect });
  useEffect(() => {
    latest.current = { shown, onRouteSegmentSelect };
  });

  /** 中身を入れ替える。前の中身が属していた区間に、新しい中身が属さなければ、その区間の選びを外す。 */
  const replace = useCallback((next: MapPopup | null) => {
    const left = latest.current.shown?.segment ?? null;
    latest.current.shown = next;
    setPopup(next);
    if (left !== null && next?.segment !== left) latest.current.onRouteSegmentSelect(null);
  }, []);

  const controls = useMemo<MapPopupControls>(
    () => ({
      openPin: (lngLat, text) => replace({ kind: "pin", lngLat, text, segment: null }),
      openPoint: (lngLat, facility) => replace({ kind: "point", lngLat, facility, segment: null }),
      openSidePoint: (lngLat, facility) =>
        replace({ kind: "point", lngLat, facility, segment: latest.current.shown?.segment ?? null }),
      openRoad: (road) => replace({ kind: "road", ...road, segment: null }),
      showSegment: (segment) => replace({ kind: "segment", segment }),
      close: () => replace(null),
    }),
    [replace],
  );

  return { shown, controls };
}

interface MapPopupMountOptions {
  shown: MapPopup | null;
  controls: MapPopupControls;
  /** 地図で押した区間の中身（ページが描く）。出さなければnullで、区間の小窓を出さない。 */
  segmentDetail: ReactNode | null;
  rideConditions: RideConditions;
  routePreference: RoutePreferenceWeights | null;
  /** 施設の位置を前後で言う基準の地点。 */
  facilityOrigin: FacilityOrigin | null;
  /** 区間の小窓の区間の形。小窓を区間にかぶらない所へ置く。形が引けなければnullで、押した地点に置く。 */
  segmentPath: readonly Position[] | null;
}

/** 小窓を指す地点と、指す物からのずれ。 */
function anchorOf(popup: MapPopup): { lngLat: [number, number]; offsetPx: number } {
  if (popup.kind === "segment") {
    return { lngLat: [popup.segment.longitude, popup.segment.latitude], offsetPx: SEGMENT_POPUP_OFFSET_PX };
  }
  // 区間の近くの施設は施設の位置を指すので、枠を付けた印を覆わない。
  return { lngLat: popup.lngLat, offsetPx: popup.segment !== null ? CHOSEN_SIDE_POINT_OUTER_RADIUS_PX : 0 };
}

/** 小窓を地図へ載せ、中身をportalで描く。返した`content`を地図の部品の中に置く。`reservedTopPx`は、区間へ寄せるときに見えている所の
 * 上に空ける高さ（出している区間の小窓と、区間との間のすき間。区間の小窓が無ければ0）。 */
export function useMapPopupMount(
  mapRef: RefObject<MapLibreMap | null>,
  {
    shown,
    controls,
    segmentDetail,
    rideConditions,
    routePreference,
    facilityOrigin,
    segmentPath,
  }: MapPopupMountOptions,
): { content: ReactNode; reservedTopPx: () => number } {
  const catalog = useAxisCatalog();
  const onMap = shown !== null && (shown.kind !== "segment" || segmentDetail !== null) ? shown : null;
  // 器は、作ったときに出していた中身と組で持つ。中身が変わった直後の描画は、まだ前の中身の器が残っているので、組が合わない
  // 器へは描かない（前の中身の部品の状態を、新しい中身へ持ち越さない）。
  const [mount, setMount] = useState<{ shown: MapPopup; container: HTMLDivElement } | null>(null);
  // 区間の形は候補が描き直されるたびに別の値で来るので、小窓を作り直さず、置き直すときに読む。
  const segmentPathRef = useRef(segmentPath);
  const placeRef = useRef<(() => void) | null>(null);
  const segmentPopupRef = useRef<maplibregl.Popup | null>(null);
  const reservedTopPx = useCallback(() => {
    const element = segmentPopupRef.current?.getElement();
    return element === undefined ? 0 : element.offsetHeight + SEGMENT_POPUP_OFFSET_PX;
  }, []);
  useEffect(() => {
    segmentPathRef.current = segmentPath;
    placeRef.current?.();
  }, [segmentPath]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || onMap === null) return;
    const container = document.createElement("div");
    const { lngLat, offsetPx } = anchorOf(onMap);
    // 地図を押して閉じるのは押した手続き（`mapTaps.ts`）が決めるので、MapLibreには閉じさせない。
    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: popupMaxWidth(offsetPx),
      offset: offsetPx,
    })
      .setLngLat(lngLat)
      .setDOMContent(container)
      .addTo(map);
    setMount({ shown: onMap, container });
    const shownMap = map;
    const segmentShown = onMap.kind === "segment";
    if (segmentShown) segmentPopupRef.current = popup;
    // 区間の小窓は、区間を囲む枠の上・下・右・左のうち、見えている所に収まる側に置く（押した地点に置くと、区間の続きにかぶる）。
    // どの側にも収まらなければ押した地点に置き、向きはMapLibreに任せる。ほかの小窓は指す地点のまま、置く向きだけ決め直す。
    function place() {
      const path = segmentShown ? segmentPathRef.current : null;
      const element = popup.getElement();
      const placement =
        path === null || path.length === 0 || element === undefined
          ? null
          : popupPlacementAround(
              pathScreenBox(shownMap, path),
              { width: element.offsetWidth, height: element.offsetHeight },
              visibleScreenBox(shownMap),
              offsetPx,
              popup.options.anchor,
            );
      popup.options.anchor = placement?.anchor;
      if (placement === null) {
        popup.setLngLat(lngLat);
        return;
      }
      popup.setLngLat(shownMap.unproject([placement.x, placement.y]));
    }
    placeRef.current = place;
    place();
    // 中身が伸び縮みしたら（評価を取る・畳みを開く・施設を引く）、置く向きを決め直す。MapLibreは地図が動いたときにしか
    // 決め直さないので、開いた後に伸びた中身が画面の外へはみ出す。区間の小窓は、地図が動き終えたら置く側も決め直す。
    // 置き直すのは中身の大きさが変わったときだけ（置き直しで向きが変わると枠の組み方が動き、同じ大きさの通知が来る）。
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
    if (segmentShown) map.on("moveend", place);
    popup.on("close", controls.close);
    return () => {
      resize?.disconnect();
      map.off("moveend", place);
      popup.off("close", controls.close);
      popup.remove();
      placeRef.current = null;
      if (segmentPopupRef.current === popup) segmentPopupRef.current = null;
      setMount(null);
    };
  }, [mapRef, onMap, controls]);

  return { content: renderContent(), reservedTopPx };

  function renderContent(): ReactNode {
    if (onMap === null || mount?.shown !== onMap) return null;
    return createPortal(
      // 高さに上限を付け、あふれたら中でスクロールする——地図の上の枠は、中身が伸びても画面の外へ出てはいけない。
      <div className="max-h-[min(24rem,50vh)] overflow-y-auto text-[length:var(--font-size-md)] leading-[1.4]">
        {onMap.kind === "road" ? (
          <RoadInspectorPopup
            properties={onMap.properties}
            track={onMap.track}
            axes={catalog.axes}
            axisColors={catalog.axisColors}
            conditions={{
              ...rideConditions,
              ...onMap.tile,
              longitude: onMap.lngLat[0],
              latitude: onMap.lngLat[1],
            }}
            routePreference={routePreference}
          />
        ) : onMap.kind === "segment" ? (
          segmentDetail
        ) : onMap.kind === "pin" ? (
          <p className="m-0 pr-9">{onMap.text}</p>
        ) : (
          <PointContent popup={onMap} origin={facilityOrigin} onBack={controls.showSegment} />
        )}
      </div>,
      mount.container,
    );
  }
}

/** 点の中身: 施設の行。区間の近くの施設なら、上の帯に区間の中身へ戻る操作を置く。上の帯が無ければ、先頭の行が×を避ける。 */
function PointContent({
  popup,
  origin,
  onBack,
}: {
  popup: Extract<MapPopup, { kind: "point" }>;
  origin: FacilityOrigin | null;
  onBack: (segment: SelectedRouteSegment) => void;
}) {
  const { segment } = popup;
  return (
    <div className={cn("flex flex-col gap-1", segment === null && "[&_li:first-child]:pr-9")}>
      {segment !== null && (
        <PopupHeader label="施設の小窓の上の帯">
          <BackToSegmentButton onBack={() => onBack(segment)} />
        </PopupHeader>
      )}
      <FacilityRows facilities={[popup.facility]} origin={origin} />
    </div>
  );
}
