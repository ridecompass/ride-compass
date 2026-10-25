"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { Position } from "geojson";

import { fitBoundsToSection, flyToVisible, pathInView } from "./mapCamera";
import type { RideFollow } from "./useRideFollow";

interface SectionFocus {
  /** 選んでいる区間の形（選んでいる候補の同じ区間から引く。地図で押した区間は形を持たない写し）。選んでいなければnull。 */
  sectionPath: readonly Position[] | null;
  /** 選んでいる区間へ寄せる頼み（道のりのグラフの寄せるボタン）。新しい値になるたびに寄せる。 */
  request: object | null;
  /** 地図の小窓を出しているか。 */
  popupOpen: boolean;
  onOutsideChange: (outside: boolean) => void;
  ride: RideFollow | null;
}

/** 地図を形へ寄せる（頼まれたときだけ。押す・選ぶだけでは地図は動かさない）と、選んでいる区間が見えている所の外にあるかの知らせ。
 * 返す関数は、渡した形へ寄せる（点ならその点へ、線ならその線を収める）。区間の頼みも同じ関数で寄せる。
 * 走行中は寄せるために追うのを休み、休ませたときだけ、小窓が閉じると追い直す（区間の選びを外すと区間の小窓も閉じる）。 */
export function useSectionFocus(
  mapRef: RefObject<MapLibreMap | null>,
  { sectionPath, request, popupOpen, onOutsideChange, ride }: SectionFocus,
) {
  const latest = useRef({ onOutsideChange, ride });
  useEffect(() => {
    latest.current = { onOutsideChange, ride };
  });

  const paused = useRef(false);
  const focus = useCallback(
    (shape: readonly Position[]) => {
      const map = mapRef.current;
      if (!map || shape.length === 0) return;
      paused.current = true;
      latest.current.ride?.onPause();
      if (shape.length === 1) flyToVisible(map, { longitude: shape[0][0], latitude: shape[0][1] });
      else fitBoundsToSection(map, shape);
    },
    [mapRef],
  );

  useEffect(() => {
    if (popupOpen || !paused.current) return;
    paused.current = false;
    latest.current.ride?.onResume();
  }, [popupOpen]);

  // 頼みは区間を選び直しても残るので、寄せた頼みを覚えて、選び直しで寄せ直さない。
  const served = useRef<object | null>(null);
  useEffect(() => {
    if (sectionPath === null || request === null || request === served.current) return;
    served.current = request;
    focus(sectionPath);
  }, [sectionPath, request, focus]);

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

  return focus;
}
