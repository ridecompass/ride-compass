"use client";

import { useEffect, useRef, type RefObject } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";

import type { Coordinates } from "@/types/route";

import { RIDE_MIN_ZOOM, rideZoomOut } from "./rideZoom";

/** 走行モードで地図が受ける値（走行モードの間だけ渡る）。 */
export interface RideFollow {
  position: Coordinates | null;
  /** 進む向き（真北0・時計回りの度）。まだ分からなければnull。 */
  bearing: number | null;
  /** スマホが向いている方角（真北0・時計回りの度）。読めなければnull（向きの印を出さない）。 */
  facing: number | null;
  following: boolean;
  /** 今の速さ（時速km）。分からなければnull。追っている間の倍率に使う。 */
  speedKmh: number | null;
  /** 進む向きを上にするか（偽なら北が上）。 */
  headingUp: boolean;
  /** 利用者が地図を指で動かした・回した。 */
  onPause: () => void;
  /** 走行モードの間に方位磁針を押した。 */
  onToggleHeadingUp: () => void;
}

// 速さは位置ごとに揺れるので、新しい値をこの割合だけ混ぜてから倍率に使う（倍率がちらつかないように）。
const SPEED_SMOOTHING = 0.3;

const FACING_CONE_ATTRIBUTE = "data-facing-cone";
const SVG_NS = "http://www.w3.org/2000/svg";

/** 現在地の印の要素: 青い点と白い縁、上（北）へ開いた扇形。色はテーマの強調色に従う。 */
function createLocationMark(): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", "現在地");
  element.style.pointerEvents = "none";
  // 出発地の印は出発地が変わるたびに作り直されて後ろの順に並ぶので、重なり順で常に上に描く（出発地にいる間も現在地が見える）。
  element.style.zIndex = "1";
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

/** MapLibreの出来事の元の入力が、2本以上の指のタッチか。 */
function isTwoFingerTouch(input: unknown): boolean {
  return typeof input === "object" && input !== null && "touches" in input && (input as TouchEvent).touches.length >= 2;
}

/** 走行モードの間、現在地の点を出し、追っている間は地図の中心（と向き）を現在地へ動かし続ける。利用者が地図を指で
 * 動かすか回すと追うのを休むよう知らせる。止めたら地図の向きを走る前に戻す。走っていない間は、`here`（取り直した現在地）に同じ点を出す。
 * `visibleOffset`は、地図に重なる部品を避けて見えている所の中ほどへ寄せるための、中心からのずれ（px）。 */
export function useRideFollow(
  mapRef: RefObject<MapLibreMap | null>,
  ride: RideFollow | null,
  here: Coordinates | null,
  visibleOffset: (map: MapLibreMap) => [number, number],
): void {
  const latest = useRef(ride);
  // 追っている間の倍率の基準（速さで引く前）と、なめらかにした速さ、いま当てている引きの段の数。
  const baseZoom = useRef<number | null>(null);
  const smoothedSpeed = useRef<number | null>(null);
  const appliedZoomOut = useRef(0);
  // 利用者が休まずに続ける操作（拡大・縮小、まだ決めていない2本指）の最中か。最中にカメラを動かすとMapLibreが操作を打ち切る。
  const gesture = useRef<{ twoFingers: boolean; zoomed: boolean } | null>(null);
  // 最後に届いた位置へカメラを寄せる。操作の最中に届いた位置へは、操作が終わってから寄せる。
  const followCamera = useRef<(() => void) | null>(null);
  useEffect(() => {
    latest.current = ride;
  });

  // 利用者の操作だけが出来事に元の入力（`originalEvent`）を持つ。地図を動かすアプリの操作（追う・ルートを収める）では休まない。
  // 拡大・縮小だけでは休まない（MapLibreの標準の現在地のボタンと同じ）。休まずに続ける操作の最中は、`gesture`に持つ。
  // MapLibreは2本指の操作を、指の重心がずれると倍率が変わる前に移動として始めるので、2本指は始まりで決めず、回す・傾けるが
  // 始まれば休み、どれも無いまま終われば（2本指で動かしただけなら）休む。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shown = map;
    function onUserMoveStart(event: { originalEvent?: unknown }) {
      if (event.originalEvent === undefined || !latest.current?.following) return;
      if (isTwoFingerTouch(event.originalEvent)) gesture.current = { twoFingers: true, zoomed: false };
      else if (shown.isZooming()) gesture.current = { twoFingers: false, zoomed: true };
      else latest.current.onPause();
    }
    function noteZoom() {
      if (gesture.current !== null) gesture.current.zoomed = true;
    }
    function pauseOnTwoFingerTurn() {
      if (!gesture.current?.twoFingers) return;
      gesture.current = null;
      latest.current?.onPause();
    }
    function onUserMoveEnd(event: { originalEvent?: unknown }) {
      const ended = gesture.current;
      if (event.originalEvent === undefined || ended === null) return;
      gesture.current = null;
      if (!latest.current?.following) return;
      if (ended.zoomed) followCamera.current?.();
      else latest.current.onPause();
    }
    // 追っている間に利用者が拡大・縮小したら、その倍率を基準にし直す（速さの分の引きはその上に重ねる）。
    function rebaseOnUserZoom(event: { originalEvent?: unknown }) {
      if (event.originalEvent === undefined || !latest.current?.following || baseZoom.current === null) return;
      baseZoom.current = shown.getZoom() + appliedZoomOut.current;
    }
    map.on("movestart", onUserMoveStart);
    map.on("zoomstart", noteZoom);
    map.on("rotatestart", pauseOnTwoFingerTurn);
    map.on("pitchstart", pauseOnTwoFingerTurn);
    map.on("zoomend", rebaseOnUserZoom);
    map.on("moveend", onUserMoveEnd);
    return () => {
      map.off("movestart", onUserMoveStart);
      map.off("zoomstart", noteZoom);
      map.off("rotatestart", pauseOnTwoFingerTurn);
      map.off("pitchstart", pauseOnTwoFingerTurn);
      map.off("zoomend", rebaseOnUserZoom);
      map.off("moveend", onUserMoveEnd);
    };
  }, [mapRef]);

  // 走り始めたときの地図の向きを覚え、止めたらそこへ戻す（進む向きを上にして回した地図を、作業台に持ち越さない）。
  // 戻すのは止めたときだけで、画面を離れて地図を片付けるときは動かさない。
  const riding = ride !== null;
  const bearingBeforeRide = useRef<number | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (riding) {
      bearingBeforeRide.current = map.getBearing();
    } else if (bearingBeforeRide.current !== null) {
      map.easeTo({ bearing: bearingBeforeRide.current });
      bearingBeforeRide.current = null;
    }
  }, [mapRef, riding]);

  // 現在地の点と、スマホが向いている方角の扇形。扇形は北を上にした絵で、印を地図に沿わせて回す（地図を回しても方角を指す）。
  const dotRef = useRef<Marker | null>(null);
  const position = ride !== null ? ride.position : here;
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
  // 倍率は基準から速さの分だけ引く（速いほど先が見える）。
  const following = ride?.following ?? false;
  const headingUp = ride?.headingUp ?? false;
  const bearing = ride?.bearing ?? null;
  const speedKmh = ride?.speedKmh ?? null;
  const wasFollowing = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !following || position === null) {
      if (!following) wasFollowing.current = false;
      return;
    }
    if (!wasFollowing.current) {
      baseZoom.current = Math.max(map.getZoom(), RIDE_MIN_ZOOM);
      smoothedSpeed.current = null;
      gesture.current = null;
    }
    wasFollowing.current = true;
    if (speedKmh !== null) {
      const previous = smoothedSpeed.current;
      smoothedSpeed.current = previous === null ? speedKmh : previous + SPEED_SMOOTHING * (speedKmh - previous);
    }
    appliedZoomOut.current = rideZoomOut(smoothedSpeed.current);
    const center: [number, number] = [position.longitude, position.latitude];
    followCamera.current = () =>
      map.easeTo({
        center,
        bearing: headingUp ? (bearing ?? map.getBearing()) : 0,
        zoom: (baseZoom.current ?? map.getZoom()) - appliedZoomOut.current,
        offset: visibleOffset(map),
      });
    if (gesture.current === null) followCamera.current();
    // visibleOffsetは寄せる瞬間の覆いを測るだけで、変わっても動かし直さない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, following, position, bearing, headingUp, speedKmh]);
}
