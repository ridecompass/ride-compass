"use client";

import { useEffect, useRef, type RefObject } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";

import type { Coordinates } from "@/types/route";

/** 走行中に次に曲がる所の印の要素: 強調色の丸に白い縁。 */
function createTurnMark(): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", "曲がる所");
  element.style.pointerEvents = "none";
  element.style.width = "18px";
  element.style.height = "18px";
  element.style.borderRadius = "50%";
  element.style.background = "var(--color-accent-strong)";
  element.style.border = "3px solid #fff";
  element.style.boxShadow = "0 1px 4px rgba(0, 0, 0, 0.35)";
  element.style.boxSizing = "border-box";
  return element;
}

/** 走行中、次に曲がる所`turn`の地点に印を出す。無ければ出さない。 */
export function useTurnMark(mapRef: RefObject<MapLibreMap | null>, turn: Coordinates | null): void {
  const markRef = useRef<Marker | null>(null);
  const latitude = turn?.latitude ?? null;
  const longitude = turn?.longitude ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || latitude === null || longitude === null) {
      markRef.current?.remove();
      markRef.current = null;
      return;
    }
    const mark = markRef.current ?? new maplibregl.Marker({ element: createTurnMark() });
    markRef.current = mark;
    mark.setLngLat([longitude, latitude]).addTo(map);
  }, [mapRef, latitude, longitude]);
  useEffect(
    () => () => {
      markRef.current?.remove();
      markRef.current = null;
    },
    [],
  );
}
