"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";

import { TurnArrow, turnLabel } from "@/components/TurnArrow/TurnArrow";
import type { Coordinates, RouteTurn } from "@/types/route";

/** 走行中に次に曲がる所。地点と曲がる向き。 */
export type TurnMarkPoint = Coordinates & Pick<RouteTurn, "direction">;

// 走行中に次に曲がる所の印の器: 文字の色の角丸の札に、地の色の縁と矢印（中の矢印はReactでportalして描く）。現在地の青い丸・
// ルートの線の評価の色と、形（四角と丸）も明るさも逆にして見分ける。地の色と文字の色はダークモードで入れ替わるので、どちらの
// 地図の上でも地と逆の明るさになる。重なり順は既定のままにし、重なり順を上げた現在地の印を上に描く。
function createTurnMark(): HTMLDivElement {
  const element = document.createElement("div");
  element.setAttribute("role", "img");
  element.style.cssText =
    "pointer-events:none; width:28px; height:28px; border-radius:7px; background:var(--foreground); " +
    "color:var(--background); border:2px solid var(--background); box-shadow:0 1px 4px rgba(0,0,0,0.45); " +
    "display:flex; align-items:center; justify-content:center; box-sizing:border-box;";
  return element;
}

/**
 * 走行中、次に曲がる所`turn`の地点に、曲がる向きの矢印（カードと同じ絵）の札を出す。無ければ出さない。
 * 矢印は画面に対して立てて描き、地図の回転には合わせない（カードと同じ向きで読む）。返す中身は地図の部品が描く。
 */
export function useTurnMark(mapRef: RefObject<MapLibreMap | null>, turn: TurnMarkPoint | null): ReactNode {
  const markRef = useRef<Marker | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const latitude = turn?.latitude ?? null;
  const longitude = turn?.longitude ?? null;
  const direction = turn?.direction ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || latitude === null || longitude === null) {
      markRef.current?.remove();
      markRef.current = null;
      setElement(null);
      return;
    }
    if (markRef.current === null) {
      const created = createTurnMark();
      markRef.current = new maplibregl.Marker({ element: created });
      setElement(created);
    }
    markRef.current.setLngLat([longitude, latitude]).addTo(map);
  }, [mapRef, latitude, longitude]);
  useEffect(
    () => () => {
      markRef.current?.remove();
      markRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (element !== null && direction !== null) element.setAttribute("aria-label", `曲がる所: ${turnLabel(direction)}`);
  }, [element, direction]);
  if (element === null || direction === null) return null;
  return createPortal(<TurnArrow direction={direction} size={18} />, element);
}
