"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";

import { CandidateMark } from "@/components/CandidateMark/CandidateMark";
import { runWhenStyleReady } from "@/features/map/layers/mapStyleOps";
import { fitBoundsToPoints } from "@/features/map/MapView/mapCamera";
import type { PlaceCandidate } from "@/types/route";

/** 地図に番号の点で出す、探した候補と、選んでいる候補の番号（`candidates`の添字）。 */
export interface CandidatesOnMap {
  candidates: readonly PlaceCandidate[];
  picked: number;
}

/**
 * 地点の検索で探した候補を、地図に番号の点で出す。新しく探すたびに、候補が全部入る所へ地図を動かす（候補の一覧・札が
 * 地図に重なる所は、印の付いた覆いとして避ける）。点を押すと、その候補を選ぶ。選んでいる候補の点は大きくして上に重ねる。
 */
export function useCandidateMarkers(
  mapRef: RefObject<MapLibreMap | null>,
  shown: CandidatesOnMap | null,
  onPick: (index: number) => void,
): ReactNode {
  const candidates = shown?.candidates ?? null;
  const picked = shown?.picked ?? null;
  const markersRef = useRef<Marker[]>([]);
  // 点の器（Markerの要素）。中身の番号はportalで描く。
  const [elements, setElements] = useState<HTMLElement[]>([]);
  // 点の押し（作ったときに一度だけ結ぶ）が、いまの`onPick`を読むための参照。
  const latestOnPick = useRef(onPick);
  useEffect(() => {
    latestOnPick.current = onPick;
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      if (candidates === null) {
        setElements([]);
        return;
      }
      const made = candidates.map((candidate, index) => {
        const element = document.createElement("div");
        element.setAttribute("role", "button");
        element.setAttribute("aria-label", `候補${index + 1}: ${candidate.name}`);
        // touch-action:noneは、指の起点が点に乗ってもパンとして確定させるため。
        element.style.cssText = "display:flex; cursor:pointer; touch-action:none;";
        // 地図の押し（地点を置く等）にしない。
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          latestOnPick.current(index);
        });
        markersRef.current.push(
          new maplibregl.Marker({ element, anchor: "center" })
            .setLngLat([candidate.longitude, candidate.latitude])
            .addTo(map),
        );
        return element;
      });
      setElements(made);
      fitBoundsToPoints(map, candidates);
    };
    runWhenStyleReady(map, apply);
  }, [mapRef, candidates]);

  // 地図を片付けたら、点は破棄した地図に付いたままなので捨てる。
  useEffect(
    () => () => {
      markersRef.current = [];
    },
    [],
  );

  // 選んでいる候補の点を、ほかの点の上に重ねる。
  useEffect(() => {
    elements.forEach((element, index) => {
      element.style.zIndex = index === picked ? "1" : "";
      element.setAttribute("aria-pressed", String(index === picked));
    });
  }, [elements, picked]);

  return elements.map((element, index) =>
    createPortal(<CandidateMark number={index + 1} picked={index === picked} />, element, `candidate-${index}`),
  );
}
