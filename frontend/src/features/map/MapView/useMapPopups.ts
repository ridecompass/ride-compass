import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SelectedRouteSegment } from "@/types/route";
import type { Facility } from "@/components/MapPopup/facilityRows";
import type { RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import type { TileXY } from "@/features/map/layers/dynamicWayValues";
import type { RoadSurfacePopupProperties } from "@/features/map/MapView/roadFacts";

/** 地図の座標の並び（押した物の形）。 */
export type Shape = readonly [number, number][];

/** 小窓が指す地点と、押した物の形（引けなければnull）。どの小窓もこれだけで置く。 */
export interface PopupTarget {
  lngLat: [number, number];
  shape: Shape | null;
}

/**
 * 地図の小窓に出している中身。小窓はいつも1つで、最後に押した物の中身を出す。点と道は押して開き、区間は選んでいる区間から導く
 * （区間を選んでいて、押して開いた中身が無ければ区間の中身）。`segment`は開いた中身が属する、選んでいる区間で、区間の選びが
 * 変わったら閉じる。`shape`は押した物の形で、寄せるアイコンはこれへ寄せる。
 */
export type MapPopup =
  /** 押した所に描かれている点。区間を選んでいる間に開いたら`segment`はその区間で、区間の中身へ戻れる。 */
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
 * 小窓を地図へ載せるのは`features/map/MapView/useMapPopupMount.tsx: useMapPopupMount`で、地図を作るeffectより後に呼ぶ。
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
