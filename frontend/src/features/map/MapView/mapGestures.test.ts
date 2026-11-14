// @vitest-environment node
/**
 * `features/map/MapView/mapGestures.ts`——地図に触れた操作が、タップか長押しか地図を動かす操作か。
 *
 * 見るもの: 決まり（`docs/modules/frontend/static-map-layers.md`「地図を押したときと地図の小窓」の「押したとき」）のとおり、地図を動かす
 * 操作（ずらす・2本の指・流れている地図を止める）はタップにも長押しにもならず、それ以外の1回の押しは、離したときにタップとして
 * （何も無い所なら待ってから）、MapLibre の`contextmenu`で長押しとして受けること。出来事の並びは、モジュールの先頭に書いた W3C の仕様が
 * 決めるもの。
 *
 * ここで見ないもの: 何も無い所のタップを待つ時間・待つ間に地図が動き出したら受けないことと、地図の出来事を部品へ渡す結線と、決まった
 * 操作で開く物 → `app/page.popups.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { MapGestures, TAP_TOLERANCE_PX, type MapGestureEvent } from "./mapGestures";

const AT = { x: 100, y: 100 };
const right = (px: number) => ({ x: AT.x + px, y: AT.y });

const fingers = (n: number, at = AT) => ({ at, fingers: n });
const touchStart = (n = 1): MapGestureEvent => ({ type: "touchstart", ...fingers(n) });
const touchMove = (px: number): MapGestureEvent => ({ type: "touchmove", ...fingers(1, right(px)) });
const touchEnd = (left = 0): MapGestureEvent => ({ type: "touchend", ...fingers(left) });
const mouseDown: MapGestureEvent = { type: "mousedown", at: AT };
const click: MapGestureEvent = { type: "click", hitsTarget: true };
const contextMenu: MapGestureEvent = { type: "contextmenu" };
const flowing: MapGestureEvent = { type: "movestart", byUser: true };

/** 出来事を順に渡し、最後の出来事で返ったことを返す。 */
function play(...events: MapGestureEvent[]) {
  const g = new MapGestures();
  return events.map((event) => g.handle(event)).at(-1);
}

/** 指1本を置いて動かさずに離す（指のクリックのあとの互換のマウスの出来事も続ける）。 */
const FINGER_TAP = [touchStart(), touchEnd(), mouseDown, click];

describe("タップ", () => {
  it.each<[string, MapGestureEvent[], ReturnType<MapGestures["handle"]>]>([
    ["押せる物を指で押して同じ所で離した", FINGER_TAP, "tap"],
    [
      "何も無い所を指で押して同じ所で離した（待ってから受ける）",
      [touchStart(), touchEnd(), mouseDown, { type: "click", hitsTarget: false }],
      "waitTap",
    ],
    ["離すまでに動いたのが、地図をずらす幅まで", [touchStart(), touchMove(TAP_TOLERANCE_PX), touchEnd(), click], "tap"],
    ["離すまでに、地図をずらす幅より動いた", [touchStart(), touchMove(TAP_TOLERANCE_PX + 1), touchEnd(), click], null],
    ["2本目の指が乗った", [touchStart(), touchStart(2), touchEnd(1), touchEnd(), click], null],
    ["押し始めに地図が利用者の操作で流れていた", [flowing, touchStart(), { type: "moveend" }, touchEnd(), click], null],
    ["押し始めに地図がプログラムで動いていた", [{ type: "movestart", byUser: false }, ...FINGER_TAP], "tap"],
    ["マウスで押して同じ所で離した", [mouseDown, click], "tap"],
  ])("%s", (_, events, action) => {
    expect(play(...events)).toBe(action);
  });
});

describe("長押し", () => {
  it.each<[string, MapGestureEvent[], ReturnType<MapGestures["handle"]>]>([
    ["指1本を置き続けた（MapLibre が`contextmenu`を出す）", [touchStart(), contextMenu], "longPress"],
    ["マウスの右ボタンで押した", [mouseDown, contextMenu], "longPress"],
    ["押し始めに地図が利用者の操作で流れていた", [flowing, touchStart(), contextMenu], null],
    ["長押しになった押しを離したあとのクリック", [touchStart(), contextMenu, touchEnd(), mouseDown, click], null],
  ])("%s", (_, events, action) => {
    expect(play(...events)).toBe(action);
  });
});
