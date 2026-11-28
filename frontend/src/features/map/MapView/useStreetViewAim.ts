"use client";

import { useEffect, useRef, type RefObject } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";

import { normalizeDeg } from "@/lib/cardinalLabel";
import type { StreetViewAim } from "@/lib/streetViewUrl";

/** 向きの輪の半径（px）。指で回すつまみは輪の上にあり、指が点を隠さない所でつまめる隔たりにする。 */
const RING_RADIUS_PX = 46;
/** 向きのつまみを鍵盤の矢印で1回押したときに回す角度（度）。 */
const KEY_TURN_DEG = 15;

/** 点とつまみの押せる所の一辺（px）。見えている丸より大きくし、指の腹で外さずにつまめる大きさにする。 */
const GRIP_PX = 44;
/** 点とつまみの見えている丸の直径（px）。 */
const DOT_PX = 22;

/** 押せる所`GRIP_PX`の真ん中に見えている丸を置いた、つまむ所。押しを受けるのは外側の器だけ。 */
function createGrip(top: string, dot: string): HTMLDivElement {
  const grip = document.createElement("div");
  grip.style.cssText =
    `pointer-events:auto; touch-action:none; cursor:grab; position:absolute; left:50%; top:${top}; ` +
    `width:${GRIP_PX}px; height:${GRIP_PX}px; margin:${-GRIP_PX / 2}px 0 0 ${-GRIP_PX / 2}px; border-radius:50%;`;
  const visible = document.createElement("div");
  visible.style.cssText =
    `pointer-events:none; position:absolute; left:50%; top:50%; width:${DOT_PX}px; height:${DOT_PX}px; ` +
    `margin:${-DOT_PX / 2}px 0 0 ${-DOT_PX / 2}px; border-radius:50%; box-sizing:border-box; box-shadow:0 1px 4px rgba(0,0,0,0.45); ${dot}`;
  grip.append(visible);
  return grip;
}

/**
 * 印の器: 見る向きの扇と向きの輪（地図の操作を通す）、真ん中の地点の点と、輪の上の向きのつまみ（どちらも指で動かせ、地図の操作を止める）。
 * 器は上を見る向きに描き、印ごと`Marker`の回しで向ける。
 */
function createAimMark(): { element: HTMLDivElement; point: HTMLDivElement; handle: HTMLDivElement } {
  const size = RING_RADIUS_PX * 2;
  const element = document.createElement("div");
  element.style.cssText = `pointer-events:none; width:${size}px; height:${size}px;`;
  const fan = document.createElement("div");
  fan.style.cssText =
    "position:absolute; inset:0; border-radius:50%; border:2px solid var(--color-accent); " +
    "background:conic-gradient(from -30deg, color-mix(in srgb, var(--color-accent) 35%, transparent) 0 60deg, transparent 60deg);";
  const point = createGrip("50%", "background:var(--color-accent); border:3px solid #fff;");
  point.setAttribute("aria-label", "ストリートビューを開く地点");
  point.dataset.usage = "つまんで動かすと、ストリートビューを開く地点が変わります。";
  const handle = createGrip("0", "background:#fff; border:3px solid var(--color-accent);");
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", "ストリートビューの向き");
  handle.setAttribute("aria-valuemin", "0");
  handle.setAttribute("aria-valuemax", "359");
  handle.tabIndex = 0;
  handle.dataset.usage = "輪に沿って回すと、ストリートビューのカメラの向きが変わります。";
  element.append(fan, point, handle);
  return { element, point, handle };
}

/**
 * Street View を開く地点と向き`aim`の矢印を地図に出し、点をつまむと地点を、つまみを回すと向きを`onChange`で知らせる。nullなら出さない。
 * 矢印は地図に合わせて回り、地図を回しても同じ方角を指す。
 */
export function useStreetViewAim(
  mapRef: RefObject<MapLibreMap | null>,
  aim: StreetViewAim | null,
  onChange: (aim: StreetViewAim) => void,
): void {
  const markRef = useRef<{ marker: Marker; handle: HTMLDivElement } | null>(null);
  const latest = useRef({ aim, onChange });
  useEffect(() => {
    latest.current = { aim, onChange };
  });
  const shown = aim !== null;

  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !shown) return;
    const { element, point, handle } = createAimMark();
    const marker = new maplibregl.Marker({ element, rotationAlignment: "map", pitchAlignment: "map" });
    markRef.current = { marker, handle };
    const change = (next: Partial<StreetViewAim>) => {
      const current = latest.current.aim;
      if (current !== null) latest.current.onChange({ ...current, ...next });
    };
    const turnTo = (at: [number, number]) => {
      const current = latest.current.aim;
      if (current === null) return;
      const center = map.project([current.lngLat[0], current.lngLat[1]]);
      const screenDeg = (Math.atan2(at[0] - center.x, center.y - at[1]) * 180) / Math.PI;
      change({ headingDeg: normalizeDeg(screenDeg + map.getBearing()) });
    };
    // 点は掴んだ所からの隔たりを保って動かす（押せる所が点より大きいので、掴んだ所へ点を寄せると掴んだ瞬間に点が跳ぶ）。
    const moveFrom = (grabbed: [number, number]) => {
      const current = latest.current.aim;
      const center = current === null ? null : map.project([current.lngLat[0], current.lngLat[1]]);
      const [dx, dy] = center === null ? [0, 0] : [center.x - grabbed[0], center.y - grabbed[1]];
      return (at: [number, number]) => {
        const { lng, lat } = map.unproject([at[0] + dx, at[1] + dy]);
        change({ lngLat: [lng, lat] });
      };
    };
    // MapLibre の印の`draggable`は印の要素のどこを押しても印ごと動かすので、点とつまみで別のことをする矢印には使わない。
    // 点とつまみの上の押しは地図へ通さない（MapLibre は地図の器で押し・指の動きを受けて地図を動かし、押しで小窓を開く）。
    const grip = (target: HTMLDivElement, begin: (grabbed: [number, number]) => (at: [number, number]) => void) => {
      for (const type of ["mousedown", "touchstart", "touchmove", "touchend", "click"]) {
        target.addEventListener(type, (event) => event.stopPropagation());
      }
      target.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        target.setPointerCapture?.(event.pointerId);
        const rect = map.getContainer().getBoundingClientRect();
        const follow = begin([event.clientX - rect.left, event.clientY - rect.top]);
        const onMove = (move: PointerEvent) => follow([move.clientX - rect.left, move.clientY - rect.top]);
        const onEnd = () => {
          target.removeEventListener("pointermove", onMove);
          target.removeEventListener("pointerup", onEnd);
          target.removeEventListener("pointercancel", onEnd);
        };
        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onEnd);
        target.addEventListener("pointercancel", onEnd);
      });
    };
    grip(point, moveFrom);
    grip(handle, () => turnTo);
    handle.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
      const current = latest.current.aim;
      if (step === undefined || current === null) return;
      event.preventDefault();
      change({ headingDeg: normalizeDeg(current.headingDeg + step * KEY_TURN_DEG) });
    });
    marker.setLngLat([0, 0]).addTo(map);
    return () => {
      marker.remove();
      markRef.current = null;
    };
  }, [mapRef, shown]);

  const longitude = aim?.lngLat[0] ?? null;
  const latitude = aim?.lngLat[1] ?? null;
  const headingDeg = aim?.headingDeg ?? null;
  useEffect(() => {
    const mark = markRef.current;
    if (mark === null || longitude === null || latitude === null || headingDeg === null) return;
    mark.marker.setLngLat([longitude, latitude]).setRotation(headingDeg);
    mark.handle.setAttribute("aria-valuenow", String(Math.round(headingDeg)));
  }, [shown, longitude, latitude, headingDeg]);
}
