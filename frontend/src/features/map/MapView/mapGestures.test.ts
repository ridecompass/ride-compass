// @vitest-environment node
/**
 * `features/map/MapView/mapGestures.ts`——地図に触れた操作が、タップか長押しか地図を動かす操作か。
 *
 * 見るもの: 決まり（`docs/modules/frontend/static-map-layers.md`「地図を押したときと地図の小窓」の「押したとき」）のとおり、地図を動かす
 * 操作（ずらす・2本の指・ダブルタップ・流れている地図を止める・確かめる間に地図を動かし始める）はタップにも長押しにもならず、
 * それ以外の1回の押しは、確かめの時にタップとして、指1本を動かさずに置き続けると長押しとして生きていること。マウスの右ボタンは長押しと
 * 同じに受けること。出来事の並びは、モジュールの先頭に書いた W3C の仕様が決めるもの。
 *
 * ここで見ないもの: 待つ時間と、地図の出来事を部品へ渡す結線と、決まった操作で開く物 → `app/page.popups.test.tsx`。
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
const click: MapGestureEvent = { type: "click" };

/** 出来事を順に渡す。 */
const play =
  (...events: MapGestureEvent[]) =>
  (g: MapGestures) =>
    events.forEach((event) => g.handle(event));

/** 指1本を置いて動かさずに離す（指のクリックのあとの互換のマウスの出来事も続ける）。 */
const FINGER_TAP = [touchStart(), touchEnd(), mouseDown, click];

describe("タップ", () => {
  it.each<[string, (g: MapGestures) => void, boolean]>([
    ["指を置いて同じ所で離した", play(...FINGER_TAP), true],
    [
      "離すまでに動いたのが、地図をずらす幅まで",
      play(touchStart(), touchMove(TAP_TOLERANCE_PX), touchEnd(), click),
      true,
    ],
    [
      "離すまでに、地図をずらす幅より動いた",
      play(touchStart(), touchMove(TAP_TOLERANCE_PX + 1), touchEnd(), click),
      false,
    ],
    ["2本目の指が乗った", play(touchStart(), touchStart(2), touchEnd(1), touchEnd(), click), false],
    [
      "押し始めに地図が利用者の操作で流れていた",
      play({ type: "movestart", byUser: true }, touchStart(), { type: "moveend" }, touchEnd(), click),
      false,
    ],
    ["押し始めに地図がプログラムで動いていた", play({ type: "movestart", byUser: false }, ...FINGER_TAP), true],
    [
      "確かめる間に次の指が乗った（ダブルタップ。2回目のあとの互換のマウスの出来事も新しい押しに数えない）",
      play(...FINGER_TAP, ...FINGER_TAP),
      false,
    ],
    ["確かめが済んでから次の指が乗った", (g) => (play(...FINGER_TAP)(g), g.confirmTap(), play(...FINGER_TAP)(g)), true],
    ["確かめる間に、地図が利用者の操作で動き始めた", play(...FINGER_TAP, { type: "movestart", byUser: true }), false],
    ["マウスで押して同じ所で離した", play(mouseDown, click), true],
    ["マウスの右ボタンを押した", play(mouseDown, click, { type: "contextmenu" }), false],
  ])("%s", (_, operate, tapped) => {
    const g = new MapGestures();
    operate(g);
    expect(g.confirmTap()).toBe(tapped);
  });
});

describe("長押し", () => {
  it.each<[string, MapGestureEvent[], boolean]>([
    ["指1本を動かさずに置き続けた", [], true],
    ["長押しの時の前に離した", [touchEnd()], false],
    ["長押しの時の前に指が中断された", [{ type: "touchcancel", ...fingers(0) }], false],
    ["地図をずらす幅より動いた（タップにならない押しは長押しにもならない）", [touchMove(TAP_TOLERANCE_PX + 1)], false],
  ])("指を置いたあと、%s", (_, events, longPressed) => {
    const g = new MapGestures();
    expect(g.handle(touchStart())).toBe("waitLongPress");
    play(...events)(g);
    expect(g.confirmLongPress()).toBe(longPressed);
  });

  it("長押しになった押しは、離したあとのクリックをタップにしない", () => {
    const g = new MapGestures();
    g.handle(touchStart());
    g.confirmLongPress();
    play(touchEnd(), mouseDown, click)(g);
    expect(g.confirmTap()).toBe(false);
  });

  it("マウスの右ボタンはすぐ長押しとして受け、指を置いている間の右ボタンの出来事は受けない", () => {
    const touch = new MapGestures();
    touch.handle(touchStart());
    expect([new MapGestures().handle({ type: "contextmenu" }), touch.handle({ type: "contextmenu" })]).toEqual([
      "longPress",
      null,
    ]);
  });
});
