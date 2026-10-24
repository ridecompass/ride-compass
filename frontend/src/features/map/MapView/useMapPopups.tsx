"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { RoutePreferenceWeights, SelectedRouteSegment } from "@/types/route";
import { Button } from "@/components/ui/Button/Button";
import type { RideConditions } from "@/features/map/regionApi";
import type { TileXY } from "@/features/map/layers/dynamicWayValues";
import { CHOSEN_SIDE_POINT_OUTER_RADIUS_PX } from "@/features/map/scene/groups/sidePoints";
import RoadInspectorPopup from "@/features/map/MapView/RoadInspectorPopup";
import type { RoadSurfacePopupProperties } from "@/features/map/MapView/roadFacts";
import { SELECTED_POINT_PIN_HEIGHT_PX } from "@/features/map/MapView/useMapMarkers";
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
  /** 点・ピン（数行の事実なので、組んだDOMをそのまま載せる）。区間の近くの施設なら`segment`はその区間で、区間の中身へ戻れる。 */
  | { kind: "point"; lngLat: [number, number]; content: HTMLElement; segment: SelectedRouteSegment | null }
  /** 押した道。`tile`は押した瞬間のタイル（開いたままズームしても、押した道のタイルを指す）。 */
  | {
      kind: "road";
      lngLat: [number, number];
      properties: RoadSurfacePopupProperties;
      tile: TileXY;
      segment: null;
    }
  /** 地図で押した区間（中身はページが描く）。 */
  | { kind: "segment"; segment: SelectedRouteSegment };

/** 地図を押した手続き（`mapTaps.ts`）が小窓を開く・閉じる口。地図を作るときに一度だけ結ぶので、どれも同じ関数のまま変わらない。 */
export interface MapPopupControls {
  openPoint: (lngLat: [number, number], content: HTMLElement) => void;
  /** 区間の近くの施設。区間の中身を出している間に開くと、区間の選びを残して戻れるようにする。 */
  openSidePoint: (lngLat: [number, number], content: HTMLElement) => void;
  openRoad: (road: Pick<Extract<MapPopup, { kind: "road" }>, "lngLat" | "properties" | "tile">) => void;
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
      openPoint: (lngLat, content) => replace({ kind: "point", lngLat, content, segment: null }),
      openSidePoint: (lngLat, content) =>
        replace({ kind: "point", lngLat, content, segment: latest.current.shown?.segment ?? null }),
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
}

/** 小窓を指す地点と、指す物からのずれ。 */
function anchorOf(popup: MapPopup): { lngLat: [number, number]; offsetPx: number } {
  if (popup.kind === "segment") {
    return { lngLat: [popup.segment.longitude, popup.segment.latitude], offsetPx: SEGMENT_POPUP_OFFSET_PX };
  }
  // 区間の近くの施設は施設の位置を指すので、枠を付けた印を覆わない。
  return { lngLat: popup.lngLat, offsetPx: popup.segment !== null ? CHOSEN_SIDE_POINT_OUTER_RADIUS_PX : 0 };
}

/** 組んだDOMを、Reactで描く小窓の中へ置く。 */
function MountedContent({ node }: { node: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.replaceChildren(node);
  }, [node]);
  return <div ref={ref} />;
}

/** 小窓を地図へ載せ、中身をportalで描く。返した要素を地図の部品の中に置く。 */
export function useMapPopupMount(
  mapRef: RefObject<MapLibreMap | null>,
  { shown, controls, segmentDetail, rideConditions, routePreference }: MapPopupMountOptions,
): ReactNode {
  const catalog = useAxisCatalog();
  const onMap = shown !== null && (shown.kind !== "segment" || segmentDetail !== null) ? shown : null;
  // 器は、作ったときに出していた中身と組で持つ。中身が変わった直後の描画は、まだ前の中身の器が残っているので、組が合わない
  // 器へは描かない（前の中身の部品の状態を、新しい中身へ持ち越さない）。
  const [mount, setMount] = useState<{ shown: MapPopup; container: HTMLDivElement } | null>(null);

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
    // 中身が伸び縮みしたら（評価を取る・畳みを開く・施設を引く）、置く向きを決め直す。MapLibreは地図が動いたときにしか
    // 決め直さないので、開いた後に伸びた中身が画面の外へはみ出す。
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => popup.setLngLat(popup.getLngLat()));
    resize?.observe(container);
    popup.on("close", controls.close);
    return () => {
      resize?.disconnect();
      popup.off("close", controls.close);
      popup.remove();
      setMount(null);
    };
  }, [mapRef, onMap, controls]);

  if (onMap === null || mount?.shown !== onMap) return null;
  return createPortal(
    onMap.kind === "road" ? (
      <RoadInspectorPopup
        properties={onMap.properties}
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
    ) : (
      <PointContent popup={onMap} onBack={controls.showSegment} />
    ),
    mount.container,
  );
}

/** 点の中身。区間の近くの施設なら、先頭に区間の中身へ戻る操作を置く。 */
function PointContent({
  popup,
  onBack,
}: {
  popup: Extract<MapPopup, { kind: "point" }>;
  onBack: (segment: SelectedRouteSegment) => void;
}) {
  const { segment } = popup;
  return (
    <div className="flex flex-col items-start gap-1">
      {segment !== null && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onBack(segment)}
          usage="押した区間の中身（近くの施設の件数）へ戻ります。"
        >
          ← 区間へ戻る
        </Button>
      )}
      <MountedContent node={popup.content} />
    </div>
  );
}
