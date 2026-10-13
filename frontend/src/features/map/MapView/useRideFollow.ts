"use client";

import { useEffect, useRef, type RefObject } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";

import type { Coordinates } from "@/types/route";

/** 走行モードで地図が受ける値（走行モードの間だけ渡る）。 */
export interface RideFollow {
  position: Coordinates | null;
  /** 進む向き（真北0・時計回りの度）。まだ分からなければnull。 */
  bearing: number | null;
  /** スマホが向いている方角（磁北0・時計回りの度）。読めなければnull（向きの印を出さない）。 */
  facing: number | null;
  following: boolean;
  /** 進む向きを上にするか（偽なら北が上）。 */
  headingUp: boolean;
  /** 利用者が地図を指で動かした・回した。 */
  onPause: () => void;
  /** 走行モードの間に方位のボタン（コンパス）を押した。 */
  onToggleHeadingUp: () => void;
}

// 追い始めたときに、これより引いていれば寄せる（道の分かれ目が見分けられる倍率）。
const RIDE_MIN_ZOOM = 15;

const COMPASS_SELECTOR = ".maplibregl-ctrl-compass";

const FACING_CONE_ATTRIBUTE = "data-facing-cone";
const SVG_NS = "http://www.w3.org/2000/svg";

/** 現在地の印の要素: 青い点と白い縁、上（北）へ開いた扇形。色はテーマの強調色に従う。 */
function createLocationMark(): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", "現在地");
  element.style.pointerEvents = "none";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "-32 -32 64 64");
  svg.setAttribute("width", "64");
  svg.setAttribute("height", "64");
  svg.setAttribute("aria-hidden", "true");
  const cone = document.createElementNS(SVG_NS, "path");
  cone.setAttribute(FACING_CONE_ATTRIBUTE, "");
  cone.setAttribute("d", "M0 0 L-13 -29 A32 32 0 0 1 13 -29 Z");
  cone.setAttribute("style", "fill: var(--color-accent); opacity: 0.35");
  cone.setAttribute("visibility", "hidden");
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("r", "8");
  dot.setAttribute("style", "fill: var(--color-accent); stroke: #fff; stroke-width: 3");
  svg.append(cone, dot);
  element.append(svg);
  return element;
}

/** 走行モードの間、現在地の点を出し、追っている間は地図の中心（と向き）を現在地へ動かし続ける。利用者が地図を指で
 * 動かすか回すと追うのを休むよう知らせ、方位のボタンは北を上に戻す代わりに向きの切り替えを知らせる。
 * `visibleOffset`は、地図に重なる部品を避けて見えている所の中ほどへ寄せるための、中心からのずれ（px）。 */
export function useRideFollow(
  mapRef: RefObject<MapLibreMap | null>,
  ride: RideFollow | null,
  visibleOffset: (map: MapLibreMap) => [number, number],
): void {
  const latest = useRef(ride);
  useEffect(() => {
    latest.current = ride;
  });

  // 利用者の操作だけが出来事に元の入力（`originalEvent`）を持つ。地図を動かすアプリの操作（追う・ルートを収める）では休まない。
  // 拡大・縮小だけでは休まない（MapLibreの標準の現在地のボタンと同じ）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shown = map;
    function pauseOnUserMove(event: { originalEvent?: unknown }) {
      if (event.originalEvent === undefined || shown.isZooming() || !latest.current?.following) return;
      latest.current.onPause();
    }
    // 方位のボタンは押すと自分で北へ戻すので、走行モードの間は、ボタンへ届く前（捕捉の段）で止めて切り替えに替える。
    function toggleOnCompass(event: MouseEvent) {
      const ride = latest.current;
      if (ride === null || !(event.target instanceof Element) || event.target.closest(COMPASS_SELECTOR) === null)
        return;
      event.stopPropagation();
      event.preventDefault();
      ride.onToggleHeadingUp();
    }
    const container = map.getContainer();
    map.on("movestart", pauseOnUserMove);
    container.addEventListener("click", toggleOnCompass, true);
    return () => {
      map.off("movestart", pauseOnUserMove);
      container.removeEventListener("click", toggleOnCompass, true);
    };
  }, [mapRef]);

  // 走行モードの間、方位のボタンの名前を、押したときの動き（向きの切り替え）にする。終えたら元の名前へ戻す。
  const riding = ride !== null;
  const headingUp = ride?.headingUp ?? false;
  useEffect(() => {
    const compass = mapRef.current?.getContainer().querySelector(COMPASS_SELECTOR);
    if (!riding || !compass) return;
    const original = { title: compass.getAttribute("title"), label: compass.getAttribute("aria-label") };
    const name = headingUp ? "北を上にする（いまは進む向きが上）" : "進む向きを上にする（いまは北が上）";
    compass.setAttribute("title", name);
    compass.setAttribute("aria-label", name);
    return () => {
      if (original.title !== null) compass.setAttribute("title", original.title);
      if (original.label !== null) compass.setAttribute("aria-label", original.label);
    };
  }, [mapRef, riding, headingUp]);

  // 現在地の点と、スマホが向いている方角の扇形。扇形は北を上にした絵で、印を地図に沿わせて回す（地図を回しても方角を指す）。
  const dotRef = useRef<Marker | null>(null);
  const position = ride?.position ?? null;
  const facing = ride?.facing ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (position === null) {
      dotRef.current?.remove();
      dotRef.current = null;
      return;
    }
    if (dotRef.current === null) {
      dotRef.current = new maplibregl.Marker({ element: createLocationMark(), rotationAlignment: "map" })
        .setLngLat([position.longitude, position.latitude])
        .addTo(map);
    } else {
      dotRef.current.setLngLat([position.longitude, position.latitude]);
    }
  }, [mapRef, position]);
  useEffect(() => {
    const dot = dotRef.current;
    if (!dot) return;
    const cone = dot.getElement().querySelector<SVGElement>(`[${FACING_CONE_ATTRIBUTE}]`);
    cone?.setAttribute("visibility", facing === null ? "hidden" : "visible");
    dot.setRotation(facing ?? 0);
  }, [position, facing]);
  useEffect(
    () => () => {
      dotRef.current?.remove();
      dotRef.current = null;
    },
    [],
  );

  // 追っている間、届いた位置へ中心を、進む向きが上なら向きも動かす（向きがまだ分からなければ今の向きのまま）。
  const following = ride?.following ?? false;
  const bearing = ride?.bearing ?? null;
  const wasFollowing = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !following || position === null) {
      if (!following) wasFollowing.current = false;
      return;
    }
    const justStarted = !wasFollowing.current;
    wasFollowing.current = true;
    map.easeTo({
      center: [position.longitude, position.latitude],
      bearing: headingUp ? (bearing ?? map.getBearing()) : 0,
      ...(justStarted ? { zoom: Math.max(map.getZoom(), RIDE_MIN_ZOOM) } : {}),
      offset: visibleOffset(map),
    });
    // visibleOffsetは寄せる瞬間の覆いを測るだけで、変わっても動かし直さない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, following, position, bearing, headingUp]);
}
