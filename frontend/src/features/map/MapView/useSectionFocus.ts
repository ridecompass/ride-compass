"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { Position } from "geojson";

import { fitBoundsToSection, pathInView } from "./mapCamera";
import type { RideFollow } from "./useRideFollow";

interface SectionFocus {
  /** 選んでいる区間の形（選んでいる候補の同じ区間から引く。地図で押した区間は形を持たない写し）。選んでいなければnull。 */
  sectionPath: readonly Position[] | null;
  /** 寄せる頼み。新しい値になるたびに寄せる。 */
  request: object | null;
  onOutsideChange: (outside: boolean) => void;
  ride: RideFollow | null;
  /** 寄せるときに見えている所の上に空ける高さ（区間の上に出している地図の小窓の分）。寄せるときに読む。 */
  reservedTopPx: () => number;
}

/** 選んでいる区間へ地図を寄せる（頼まれたときだけ。区間を選んでも地図は動かさない）と、その区間が見えている所の外にあるかの知らせ。
 * 走行中は寄せるために追うのを休み、休ませたときだけ、選びを外すと追い直す（選んだだけでは追い続ける）。 */
export function useSectionFocus(
  mapRef: RefObject<MapLibreMap | null>,
  { sectionPath, request, onOutsideChange, ride, reservedTopPx }: SectionFocus,
) {
  const latest = useRef({ onOutsideChange, ride, reservedTopPx });
  useEffect(() => {
    latest.current = { onOutsideChange, ride, reservedTopPx };
  });

  // 頼みは区間を選び直しても残るので、寄せた頼みを覚えて、選び直しで寄せ直さない。
  const servedRequest = useRef<object | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (sectionPath === null) {
      if (fitted.current) latest.current.ride?.onResume();
      fitted.current = false;
      return;
    }
    if (request === null || request === servedRequest.current) return;
    servedRequest.current = request;
    fitted.current = true;
    latest.current.ride?.onPause();
    fitBoundsToSection(map, sectionPath, latest.current.reservedTopPx());
  }, [mapRef, sectionPath, request]);

  // 選び直したときと、地図が動き終えたときに知らせる。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shown = map;
    function report() {
      latest.current.onOutsideChange(sectionPath !== null && !pathInView(shown, sectionPath));
    }
    report();
    map.on("moveend", report);
    return () => {
      map.off("moveend", report);
    };
  }, [mapRef, sectionPath]);
}
