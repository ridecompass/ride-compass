"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";

import type { Coordinates, LocationSource, PinRole, PointTarget, SelectedRouteSegment } from "@/types/route";
import { originMarkColor, PIN_MARK_BACKGROUND, PinMark, pinMarkName } from "@/components/PinMark/PinMark";
import palette from "@/types/generated/palette.json";
import { runWhenStyleReady } from "@/features/map/layers/mapStyleOps";

/** 出発地点を見せる倍率（地図を作ったとき・出発地点が変わったとき）。 */
export const ORIGIN_ZOOM = 13;

/** 選んだ地点の印の高さ（px）。印は下端の先で地点を指す。 */
export const SELECTED_POINT_PIN_HEIGHT_PX = 40;

// 選んだ地点の印の描画の座標。先（地点）を原点に置き、白い縁の太さぶんを枠に含める（先の丸い縁が枠の下端に来る）。
const SELECTED_POINT_PIN_VIEW = { x: -30, y: -82, width: 60, height: 85 } as const;

/** 選んだ地点の印: 白い縁と内の白い丸を持つ、塗りのしずく形。地図の線の色・現在地の青と重ならない色で塗る。 */
function SelectedPointPin() {
  const { x, y, width, height } = SELECTED_POINT_PIN_VIEW;
  return (
    <svg
      width={Math.round((SELECTED_POINT_PIN_HEIGHT_PX * width) / height)}
      height={SELECTED_POINT_PIN_HEIGHT_PX}
      viewBox={`${x} ${y} ${width} ${height}`}
      aria-hidden="true"
    >
      <path
        d="M0 0 C-6 -16 -26 -30 -26 -52 A26 26 0 1 1 26 -52 C26 -30 6 -16 0 0Z"
        fill={palette.semantic.selected_point}
        stroke={palette.semantic.pin_face}
        strokeWidth={6}
        strokeLinejoin="round"
      />
      <circle cx={0} cy={-52} r={10} fill={palette.semantic.pin_face} />
    </svg>
  );
}

// 地点のピンの器: 白い丸（`PIN_MARK_BACKGROUND`）。出発地・経由地・目的地で同じ形にし、中の記号（PinMark）をReactでportalして
// 描く。左右対称なので、アンカーは地点＝中心（"center"）。影はどの配色の上でも輪郭が消えないため、touch-action:noneは指の起点が
// ピンに乗ってもパンとして確定させるため。
function createPinElement(role: PinRole, label?: string): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", pinMarkName(role, label));
  el.style.cssText =
    `width:32px; height:32px; border-radius:50%; background:${PIN_MARK_BACKGROUND}; display:flex; ` +
    "align-items:center; justify-content:center; box-shadow:0 1px 4px rgba(0,0,0,0.4); " +
    "touch-action:none;";
  return el;
}

/** 地点の印を地図へ置き、つかんで動かす・押す操作を結ぶ。つかめるかは動かせる間だけで、あとから切り替える。 */
function addPointMarker(
  map: MapLibreMap,
  point: Coordinates,
  element: HTMLDivElement,
  editable: boolean,
  handlers: { onMove: (coordinates: Coordinates) => void; onClick: () => void },
): Marker {
  const marker = new maplibregl.Marker({ element, anchor: "center", draggable: editable })
    .setLngLat([point.longitude, point.latitude])
    .addTo(map);
  marker.on("dragend", () => {
    const lngLat = marker.getLngLat();
    handlers.onMove({ latitude: lngLat.lat, longitude: lngLat.lng });
  });
  bindDragAwareClick(marker, element, handlers.onClick);
  return marker;
}

// マーカーをドラッグした直後は、同じ操作の終わりにclickも飛ぶ。つかんで動かしただけで
// 選び直しや小窓が起きないよう、ドラッグ由来の1回を読み飛ばす。
function bindDragAwareClick(marker: maplibregl.Marker, element: HTMLElement, onClick: () => void): void {
  let dragged = false;
  marker.on("dragstart", () => {
    dragged = true;
  });
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    if (dragged) {
      dragged = false;
      return;
    }
    onClick();
  });
}

interface MapMarkersInputs {
  location: Coordinates;
  /** 出発地点の色。位置が取れず既定の地点（"default"）のときだけ灰色にする。 */
  locationSource: LocationSource;
  waypoints: Coordinates[];
  destination: Coordinates | null;
  selectedRouteSegment: SelectedRouteSegment | null;
  /** 地点をつかんで動かせるか。falseの間、印はつかめない（押すことはできる）。 */
  pointsEditable: boolean;
  onOriginMove: (coordinates: Coordinates) => void;
  onWaypointMove: (index: number, coordinates: Coordinates) => void;
  onDestinationMove: (coordinates: Coordinates) => void;
  /** 地点の印を押したとき（押した地点とその位置）。 */
  onPointPress: (target: PointTarget, at: Coordinates) => void;
  /** 動かせない間に、押すと何かが起きる印か。起きる印にだけ押せる見た目（ポインタの形）を付ける。 */
  pointPressable: (target: PointTarget) => boolean;
  onRouteSegmentSelect: (selection: SelectedRouteSegment | null) => void;
}

/**
 * 地図の地点の印（出発地・経由地・目的地・選んでいる区間）の作成・位置の更新・ドラッグ・後始末。
 * 印の中身のうちReactで描くもの（出発地の印・区間の印）は、返すportalを地図の部品が描く。
 */
export function useMapMarkers(
  mapRef: RefObject<MapLibreMap | null>,
  {
    location,
    locationSource,
    waypoints,
    destination,
    selectedRouteSegment,
    pointsEditable,
    ...handlers
  }: MapMarkersInputs,
): ReactNode {
  const markerRef = useRef<Marker | null>(null);
  // 出発地点の印に当てた色の元。Markerは位置の更新で色を変えられないため、色が変わるときだけ作り直す。
  const appliedMarkerSourceRef = useRef<LocationSource | null>(null);
  const waypointMarkersRef = useRef<Marker[]>([]);
  const destinationMarkerRef = useRef<Marker | null>(null);
  const selectedSegmentMarkerRef = useRef<Marker | null>(null);
  // 出発地点の印の器（Markerの要素）と、中身の印の色。
  const [originMark, setOriginMark] = useState<{ element: HTMLDivElement; color: string } | null>(null);
  // 経由地・目的地の印の器（Markerの要素）。中身の印はportalで描く。
  const [waypointMarks, setWaypointMarks] = useState<HTMLDivElement[]>([]);
  const [destinationMark, setDestinationMark] = useState<HTMLDivElement | null>(null);
  // 選んでいる区間の印の器（Markerの要素）。中身の印はportalで描く。
  const [selectedSegmentMark, setSelectedSegmentMark] = useState<HTMLDivElement | null>(null);
  // 印の操作（作ったときに一度だけ結ぶ）が、いまのpropsを読むための参照。
  const latestProps = { pointsEditable, location, waypoints, destination, ...handlers };
  const latest = useRef(latestProps);
  useEffect(() => {
    latest.current = latestProps;
  });
  // 出発地点をドラッグで動かした直後の1回だけ、位置の更新でカメラを動かさない（その地点は既に画面に見えている）。
  const skipNextFlyToRef = useRef(false);

  // 地図を片付けたら、印は破棄した地図に付いたままなので捨てる（Strict Modeの二重マウントで、残った印が新しい地図に付かない）。
  useEffect(
    () => () => {
      markerRef.current = null;
      appliedMarkerSourceRef.current = null;
      waypointMarkersRef.current = [];
      destinationMarkerRef.current = null;
      selectedSegmentMarkerRef.current = null;
    },
    [],
  );

  // 位置が変わったら地図と出発地点の印を更新する。印をドラッグで動かした先は「地点を置く」へ渡す。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applyLocation = () => {
      if (skipNextFlyToRef.current) {
        skipNextFlyToRef.current = false;
      } else {
        map.flyTo({ center: [location.longitude, location.latitude], zoom: ORIGIN_ZOOM });
      }

      if (markerRef.current && appliedMarkerSourceRef.current === locationSource) {
        markerRef.current.setLngLat([location.longitude, location.latitude]);
      } else {
        markerRef.current?.remove();
        const color = originMarkColor(locationSource !== "default");
        const element = createPinElement("origin");
        setOriginMark({ element, color });
        markerRef.current = addPointMarker(map, location, element, latest.current.pointsEditable, {
          onMove: (coordinates) => {
            skipNextFlyToRef.current = true;
            latest.current.onOriginMove(coordinates);
          },
          onClick: () => latest.current.onPointPress({ role: "origin" }, latest.current.location),
        });
        appliedMarkerSourceRef.current = locationSource;
      }
    };

    runWhenStyleReady(map, applyLocation);
  }, [mapRef, location, locationSource]);

  // 経由地の印（数件なので作り直す）。番号で通る順を示す。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applyWaypointMarkers = () => {
      waypointMarkersRef.current.forEach((marker) => marker.remove());
      const elements = waypoints.map((_, index) => createPinElement("waypoint", String(index + 1)));
      waypointMarkersRef.current = waypoints.map((point, index) =>
        addPointMarker(map, point, elements[index], latest.current.pointsEditable, {
          onMove: (coordinates) => latest.current.onWaypointMove(index, coordinates),
          onClick: () =>
            latest.current.onPointPress({ role: "waypoint", index }, latest.current.waypoints[index] ?? point),
        }),
      );
      setWaypointMarks(elements);
    };

    runWhenStyleReady(map, applyWaypointMarkers);
  }, [mapRef, waypoints]);

  // 印のつかめる/つかめないは、印を作り直さずに切り替える——出発地の印を作り直すeffect（上）はカメラ移動を伴うため、
  // パネルを切り替えるたびに地図が飛んでしまう。
  useEffect(() => {
    markerRef.current?.setDraggable(pointsEditable);
    waypointMarkersRef.current.forEach((marker) => marker.setDraggable(pointsEditable));
    destinationMarkerRef.current?.setDraggable(pointsEditable);
  }, [pointsEditable]);

  // 印の見た目: 動かせる間はつかめる形、動かせない間は押すと何かが起きる印だけをポインタの形にする。押せるかは地点の名前で
  // 変わるので、描くたびに当て直す。
  useEffect(() => {
    const pins: [Marker | null, PointTarget][] = [
      [markerRef.current, { role: "origin" }],
      ...waypointMarkersRef.current.map((marker, index): [Marker, PointTarget] => [
        marker,
        { role: "waypoint", index },
      ]),
      [destinationMarkerRef.current, { role: "destination" }],
    ];
    for (const [marker, target] of pins) {
      if (marker === null) continue;
      marker.getElement().style.cursor = pointsEditable
        ? "grab"
        : latest.current.pointPressable(target)
          ? "pointer"
          : "default";
    }
  });

  // 目的地の印。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applyDestinationMarker = () => {
      destinationMarkerRef.current?.remove();
      destinationMarkerRef.current = null;
      setDestinationMark(null);
      if (!destination) return;
      const element = createPinElement("destination");
      setDestinationMark(element);

      destinationMarkerRef.current = addPointMarker(map, destination, element, latest.current.pointsEditable, {
        onMove: (coordinates) => latest.current.onDestinationMove(coordinates),
        onClick: () => latest.current.onPointPress({ role: "destination" }, latest.current.destination ?? destination),
      });
    };

    runWhenStyleReady(map, applyDestinationMarker);
  }, [mapRef, destination]);

  // 選んでいる区間の印。選択が外れれば（どこで外しても）消える。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applySelectedSegmentMarker = () => {
      selectedSegmentMarkerRef.current?.remove();
      selectedSegmentMarkerRef.current = null;
      setSelectedSegmentMark(null);
      if (!selectedRouteSegment) return;

      const el = document.createElement("div");
      // 影はどの配色の上でも印を浮かせるため。touch-action:noneで、指の起点が印に乗ってもパンとして確定させる。
      el.style.cssText =
        "display:flex; cursor:pointer; filter:drop-shadow(0 2px 3px rgba(0,0,0,0.45)); touch-action:none;";
      setSelectedSegmentMark(el);
      el.setAttribute("aria-label", "選択中の区間");
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        latest.current.onRouteSegmentSelect(null);
      });
      selectedSegmentMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([selectedRouteSegment.longitude, selectedRouteSegment.latitude])
        .addTo(map);
    };

    runWhenStyleReady(map, applySelectedSegmentMarker);
  }, [mapRef, selectedRouteSegment]);

  return (
    <>
      {originMark !== null &&
        createPortal(<PinMark role="origin" size={20} originColor={originMark.color} />, originMark.element)}
      {waypointMarks.map((element, index) =>
        createPortal(<PinMark role="waypoint" label={String(index + 1)} size={20} />, element, `waypoint-${index}`),
      )}
      {destinationMark !== null && createPortal(<PinMark role="destination" size={20} />, destinationMark)}
      {selectedSegmentMark !== null && createPortal(<SelectedPointPin />, selectedSegmentMark)}
    </>
  );
}
