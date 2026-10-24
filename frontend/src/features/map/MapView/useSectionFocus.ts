"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

import { findSameSegment, segmentPath } from "@/lib/routeDistance";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

import { fitBoundsToSection, pathInView } from "./mapCamera";
import type { RideFollow } from "./useRideFollow";

interface SectionFocus {
  /** 選んでいる候補の区間の並び。 */
  segments: readonly RouteSegmentDetail[] | undefined;
  selectedRouteSegment: SelectedRouteSegment | null;
  /** 寄せる頼み。新しい値になるたびに寄せる。 */
  request: object | null;
  onOutsideChange: (outside: boolean) => void;
  ride: RideFollow | null;
}

/** 選んでいる区間へ地図を寄せる（頼まれたときだけ。区間を選んでも地図は動かさない）と、その区間が見えている所の外にあるかの知らせ。
 * 走行中は寄せるために追うのを休み、休ませたときだけ、選びを外すと追い直す（選んだだけでは追い続ける）。 */
export function useSectionFocus(
  mapRef: RefObject<MapLibreMap | null>,
  { segments, selectedRouteSegment, request, onOutsideChange, ride }: SectionFocus,
) {
  const latest = useRef({ onOutsideChange, ride });
  useEffect(() => {
    latest.current = { onOutsideChange, ride };
  });

  // 区間は選んでいる候補の同じ区間から引く（地図で押した区間は形を持たない写し）。
  const section = useMemo(
    () =>
      selectedRouteSegment === null || segments === undefined
        ? null
        : (findSameSegment(segments, selectedRouteSegment.segment, (segment) => segment) ?? null),
    [segments, selectedRouteSegment],
  );

  // 頼みは区間を選び直しても残るので、寄せた頼みを覚えて、選び直しで寄せ直さない。
  const servedRequest = useRef<object | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (section === null) {
      if (fitted.current) latest.current.ride?.onResume();
      fitted.current = false;
      return;
    }
    if (request === null || request === servedRequest.current) return;
    servedRequest.current = request;
    fitted.current = true;
    latest.current.ride?.onPause();
    fitBoundsToSection(map, segmentPath(section));
  }, [mapRef, section, request]);

  // 選び直したときと、地図が動き終えたときに知らせる。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shown = map;
    function report() {
      latest.current.onOutsideChange(section !== null && !pathInView(shown, segmentPath(section)));
    }
    report();
    map.on("moveend", report);
    return () => {
      map.off("moveend", report);
    };
  }, [mapRef, section]);
}
