"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";

import type { LiveValue } from "@/lib/liveValue";
import { visibleCenterOffset } from "@/lib/routeFit";
import type { Coordinates } from "@/types/route";

import { nextRideZoom, rideZoomBase } from "./rideZoom";

/** 走行モードで地図が受ける値（走行モードの間だけ渡る）。 */
export interface RideFollow {
  position: Coordinates | null;
  /** 進む向き（真北0・時計回りの度）。まだ分からなければnull。 */
  bearing: number | null;
  /** スマホが向いている方角（真北0・時計回りの度）。読めなければnull（向きの印を出さない）。1秒に何十回も変わるので、
   * 描き直さずに読む口で受け、現在地の印だけを回す。 */
  facing: LiveValue<number | null>;
  following: boolean;
  /** 進む向きを上にするか（偽なら北が上）。 */
  headingUp: boolean;
  /** 利用者が地図を指で動かした・回した・区間を選んだ（追うのを休む）。 */
  onPause: () => void;
  /** 区間の選びを外した（休んでいれば追い直す）。 */
  onResume: () => void;
  /** 進む向きを上にするかを選んだ。 */
  onHeadingUpChange: (headingUp: boolean) => void;
  /** 追っている間の倍率。この走行でまだ選んでいなければnull。 */
  zoomBase: number | null;
  /** 利用者が基準の倍率を選んだ（倍率のボタン・追っている間につまむ）。 */
  onZoomBaseChange: (zoom: number) => void;
  /** 地図への触れを受け付けないロックの間か。 */
  locked: boolean;
}

// ロックの間に止める、地図の手ぶりの操作（MapLibreの各操作の入切の口）。
const GESTURE_HANDLERS = [
  "dragPan",
  "dragRotate",
  "scrollZoom",
  "boxZoom",
  "keyboard",
  "doubleClickZoom",
  "touchZoomRotate",
  "touchPitch",
] as const;

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

/** 走行モードの間、現在地の点を出し、追っている間は地図の中心（と向き）を現在地へ動かし続ける。追っている間の2本指の
 * 操作は拡大・縮小だけにし、利用者が地図を指で動かすと追うのを休むよう知らせる。ロックの間は地図の手ぶりの操作を止める。止めたら地図の向きを走る前に戻す。走っていない間は、`here`（取り直した現在地）に同じ点を出す。
 * 現在地は、地図に重なる部品を避けて見えている所の中ほどへ寄せる。
 * 返すのは倍率のボタンと方位磁針を押したときの処理。 */
export function useRideFollow(
  mapRef: RefObject<MapLibreMap | null>,
  ride: RideFollow | null,
  here: Coordinates | null,
): { onNextZoom: () => void; onCompass: () => void } {
  const latest = useRef(ride);
  // 追っている間の倍率。つまみ終えて寄せ直すときに新しい値が描き直しより先に要るので、受けた値とは別に手元に持つ。
  const baseZoom = useRef<number | null>(null);
  // 利用者が休まずに続ける操作（拡大・縮小・2本指）の最中か。最中にカメラを動かすとMapLibreが操作を打ち切る。
  const gesture = useRef(false);
  // 最後に届いた位置へカメラを寄せる。操作の最中に届いた位置へは、操作が終わってから寄せる。
  const followCamera = useRef<(() => void) | null>(null);
  useEffect(() => {
    latest.current = ride;
  });

  // 利用者の操作だけが出来事に元の入力（`originalEvent`）を持つ。地図を動かすアプリの操作（追う・ルートを収める）では休まない。
  // 拡大・縮小（1本指でたたいて滑らせるのも）と2本指の操作では休まず、休むのは1本指（とマウス）で動かしたときだけ。MapLibreは
  // 2本指の操作を、指の重心がずれると倍率が変わる前に移動として始めるので、始まりの指の数で決める。休まずに続ける操作の
  // 最中は`gesture`に持ち、終わったら最後に届いた位置へ寄せる（2本指でずれた中心も戻す）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shown = map;
    function onUserMoveStart(event: { originalEvent?: unknown }) {
      if (event.originalEvent === undefined || !latest.current?.following) return;
      if (isTwoFingerTouch(event.originalEvent) || shown.isZooming()) gesture.current = true;
      else latest.current.onPause();
    }
    function onUserMoveEnd(event: { originalEvent?: unknown }) {
      if (event.originalEvent === undefined || !gesture.current) return;
      gesture.current = false;
      if (latest.current?.following) followCamera.current?.();
    }
    // 追っている間に利用者が拡大・縮小したら、その倍率で追い続ける。
    function rebaseOnUserZoom(event: { originalEvent?: unknown }) {
      if (event.originalEvent === undefined || !latest.current?.following) return;
      baseZoom.current = shown.getZoom();
      latest.current.onZoomBaseChange(baseZoom.current);
    }
    // 寄せる先の画面の点（見えている所の中ほど）は地図の大きさで変わる（背が低いと重ねた部品を避ける余白が縮む）。大きさの
    // 変わり（端末を横にした等）を MapLibre が受けたら、次の位置が届くのを待たずに今の大きさで寄せ直す。
    function followAfterResize() {
      if (latest.current?.following && !gesture.current) followCamera.current?.();
    }
    map.on("movestart", onUserMoveStart);
    map.on("zoomend", rebaseOnUserZoom);
    map.on("moveend", onUserMoveEnd);
    map.on("resize", followAfterResize);
    return () => {
      map.off("movestart", onUserMoveStart);
      map.off("zoomend", rebaseOnUserZoom);
      map.off("moveend", onUserMoveEnd);
      map.off("resize", followAfterResize);
    };
  }, [mapRef]);

  // 追っている間は、2本指で回す操作を止める（指がわずかにひねれば回り始めるので、拡大・縮小のつもりの操作で地図が回る）。
  const following = ride?.following ?? false;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !following) return;
    map.touchZoomRotate.disableRotation();
    return () => {
      map.touchZoomRotate.enableRotation();
    };
  }, [mapRef, following]);

  // ロックの間は手ぶりの操作を止め、外したら止める前に効いていたものだけを戻す（傾けは地図を作るときから止めてある）。
  // 追うのをやめると上で2本指で回す操作を戻すので、追っているかが変わるたびに止め直す（このeffectは上より後に置く）。
  const locked = ride?.locked ?? false;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !locked) return;
    const stopped = GESTURE_HANDLERS.map((name) => map[name]).filter((handler) => handler.isEnabled());
    for (const handler of stopped) handler.disable();
    return () => {
      for (const handler of stopped) handler.enable();
    };
  }, [mapRef, locked, following]);

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
    const turn = () => {
      const degrees = facing?.current() ?? null;
      cone?.setAttribute("visibility", degrees === null ? "hidden" : "visible");
      dot.setRotation(degrees ?? 0);
    };
    turn();
    return facing?.subscribe(turn);
  }, [position, facing]);
  useEffect(
    () => () => {
      dotRef.current?.remove();
      dotRef.current = null;
    },
    [],
  );

  // 追っている間、届いた位置へ中心を、進む向きが上なら向きも動かす（向きがまだ分からなければ今の向きのまま）。
  const headingUp = ride?.headingUp ?? false;
  const bearing = ride?.bearing ?? null;
  const zoomBase = ride !== null ? rideZoomBase(ride.zoomBase) : null;
  useEffect(() => {
    if (!following) gesture.current = false;
  }, [following]);
  useEffect(() => {
    baseZoom.current = zoomBase;
  }, [zoomBase]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !following || position === null) return;
    const center: [number, number] = [position.longitude, position.latitude];
    followCamera.current = () =>
      map.easeTo({
        center,
        bearing: headingUp ? (bearing ?? map.getBearing()) : 0,
        zoom: baseZoom.current ?? map.getZoom(),
        offset: visibleCenterOffset(map.getCanvas()),
        // 位置は毎秒届くので、滑らかに動かすと動く間ずっと途中のコマを描き、走行中の電池を食う（page-composition.md「走行の値へ流す位置」）。
        duration: 0,
      });
    if (!gesture.current) followCamera.current();
  }, [mapRef, following, position, bearing, headingUp, zoomBase]);

  // 追っている間は基準が変わって寄せ直す。休んでいる間は追い直すまで中心を動かさず、倍率だけをその段へ寄せる。
  const onNextZoom = useCallback(() => {
    const current = latest.current;
    if (!current) return;
    const next = nextRideZoom(rideZoomBase(current.zoomBase));
    current.onZoomBaseChange(next);
    if (!current.following) mapRef.current?.easeTo({ zoom: next });
  }, [mapRef]);

  // 追っている間は北が上と進む向きが上を切り替える。追っていない間は、見ている所を動かさずに北が上へその場で戻す。
  const onCompass = useCallback(() => {
    const current = latest.current;
    if (!current) return;
    if (current.following) {
      current.onHeadingUpChange(!current.headingUp);
      return;
    }
    current.onHeadingUpChange(false);
    mapRef.current?.jumpTo({ bearing: 0 });
  }, [mapRef]);

  return { onNextZoom, onCompass };
}
