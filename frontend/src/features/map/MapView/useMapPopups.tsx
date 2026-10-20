"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { RoutePreferenceWeights, SelectedRouteSegment } from "@/types/route";
import type { RideConditions } from "@/features/map/regionApi";
import type { TileXY } from "@/features/map/layers/dynamicWayValues";
import RoadInspectorPopup from "@/features/map/MapView/RoadInspectorPopup";
import type { RoadSurfacePopupProperties } from "@/features/map/MapView/roadFacts";
import { SELECTED_POINT_PIN_HEIGHT_PX } from "@/features/map/MapView/useMapMarkers";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";

// 区間の小窓を、押した区間の印（下端を地点に置いた絵）の上へ出すずれ。
const SEGMENT_POPUP_OFFSET_PX = SELECTED_POINT_PIN_HEIGHT_PX + 2;

/** 押した道。詳細はReactで描き、MapLibreのPopupへportalで差し込む。 */
export interface RoadPopup {
  lngLat: [number, number];
  properties: RoadSurfacePopupProperties;
  // 押した瞬間のタイル（開いたままズームしても、押した道のタイルを指す）。
  tile: TileXY;
}

/**
 * 地図の小窓の状態と、開く・閉じる手続き。選択の持ち主（`selectionOwner`）が変わると、開いている小窓を閉じる。
 * 小窓を地図へ載せるのは`useMapPopupMounts`で、地図を作るeffectより後に呼ぶ。
 */
export function useMapPopups(mapRef: RefObject<MapLibreMap | null>, selectionOwner: string | null) {
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const [roadPopup, setRoadPopup] = useState<RoadPopup | null>(null);

  // 点・ピンの小窓（MapLibreのPopupへDOMを直接載せる）。開くと前の小窓と道の小窓を閉じる。
  const openPointPopup = useCallback(
    (lngLat: [number, number], content: HTMLElement) => {
      const map = mapRef.current;
      if (!map) return;
      popupRef.current?.remove();
      setRoadPopup(null);
      popupRef.current = new maplibregl.Popup({ closeButton: true })
        .setLngLat(lngLat)
        .setDOMContent(content)
        .addTo(map);
    },
    [mapRef],
  );
  const closePointPopup = useCallback(() => {
    popupRef.current?.remove();
    popupRef.current = null;
  }, []);
  const openRoadPopup = useCallback(
    (popup: RoadPopup) => {
      closePointPopup();
      setRoadPopup(popup);
    },
    [closePointPopup],
  );

  // 道の小窓は状態なので描く間に外し、点の小窓はDOMに載せているのでeffectで外す。
  const [popupOwner, setPopupOwner] = useState(selectionOwner);
  if (popupOwner !== selectionOwner) {
    setPopupOwner(selectionOwner);
    setRoadPopup(null);
  }
  useEffect(() => closePointPopup(), [selectionOwner, closePointPopup]);

  return { roadPopup, closeRoadPopup: setRoadPopup, openPointPopup, closePointPopup, openRoadPopup };
}

interface MapPopupMountsOptions {
  roadPopup: RoadPopup | null;
  closeRoadPopup: (popup: null) => void;
  /** 見るだけの間に押した区間の中身（ページが描く）。区間を選んでいなければnull。 */
  segmentDetail: ReactNode | null;
  selectedRouteSegment: SelectedRouteSegment | null;
  /** 区間の小窓を閉じたとき（区間の選択を外す）。変わると小窓を開き直すので、同じ関数を渡し続ける。 */
  onSegmentPopupClose: () => void;
  rideConditions: RideConditions;
  routePreference: RoutePreferenceWeights | null;
}

/** 道の詳細と区間の中身の小窓を地図へ載せ、中身をportalで描く。返した要素を地図の部品の中に置く。 */
export function useMapPopupMounts(
  mapRef: RefObject<MapLibreMap | null>,
  {
    roadPopup,
    closeRoadPopup,
    segmentDetail,
    selectedRouteSegment,
    onSegmentPopupClose,
    rideConditions,
    routePreference,
  }: MapPopupMountsOptions,
): ReactNode {
  const catalog = useAxisCatalog();
  const [roadPopupContainer, setRoadPopupContainer] = useState<HTMLDivElement | null>(null);
  const [segmentPopupContainer, setSegmentPopupContainer] = useState<HTMLDivElement | null>(null);

  // 見るだけの間に押した区間の中身を、押した区間の印の上の小窓に出す。閉じると区間の選択を外す。
  const segmentPopupAt = segmentDetail !== null ? selectedRouteSegment : null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || segmentPopupAt === null) return;
    const container = document.createElement("div");
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "20rem", offset: SEGMENT_POPUP_OFFSET_PX })
      .setLngLat([segmentPopupAt.longitude, segmentPopupAt.latitude])
      .setDOMContent(container)
      .addTo(map);
    setSegmentPopupContainer(container);
    popup.on("close", onSegmentPopupClose);
    return () => {
      popup.off("close", onSegmentPopupClose);
      popup.remove();
      setSegmentPopupContainer(null);
    };
  }, [mapRef, segmentPopupAt, onSegmentPopupClose]);

  // 道の詳細のポップアップ（MapLibreのPopupを器にする）。開いている間はその道を強調する（scene）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || roadPopup === null) return;
    const container = document.createElement("div");
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "20rem" })
      .setLngLat(roadPopup.lngLat)
      .setDOMContent(container)
      .addTo(map);
    setRoadPopupContainer(container);
    // 中身が伸び縮みしたら（評価を取る・畳みを開く）、置く向きを決め直す。MapLibreは地図が動いたときにしか
    // 決め直さないので、開いた後に伸びた中身が画面の外へはみ出す。
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => popup.setLngLat(popup.getLngLat()));
    resize?.observe(container);
    const close = () => closeRoadPopup(null);
    popup.on("close", close);
    return () => {
      resize?.disconnect();
      popup.off("close", close);
      popup.remove();
      setRoadPopupContainer(null);
    };
  }, [mapRef, roadPopup, closeRoadPopup]);

  return (
    <>
      {roadPopup !== null &&
        roadPopupContainer !== null &&
        createPortal(
          <RoadInspectorPopup
            properties={roadPopup.properties}
            axes={catalog.axes}
            axisColors={catalog.axisColors}
            conditions={{
              ...rideConditions,
              ...roadPopup.tile,
              longitude: roadPopup.lngLat[0],
              latitude: roadPopup.lngLat[1],
            }}
            routePreference={routePreference}
          />,
          roadPopupContainer,
        )}
      {segmentDetail !== null && segmentPopupContainer !== null && createPortal(segmentDetail, segmentPopupContainer)}
    </>
  );
}
