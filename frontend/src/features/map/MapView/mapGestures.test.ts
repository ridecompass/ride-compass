// @vitest-environment node
/**
 * `features/map/MapView/mapGestures.ts`——地図に触れた操作が、タップか長押しか地図を動かす操作か。
 *
 * 見るもの: 決まり（`docs/modules/frontend/static-map-layers.md`「地図を押したときと地図の小窓」の「押したとき」）のとおり、地図を動かす
 * 操作（ずらす・2本の指・流れている地図を止める）はタップにも長押しにもならず、それ以外の1回の押しは、離したときにタップとして、指1本を
 * 動かさずに置き続けると長押しとして受けること。マウスの右ボタンは長押しと同じに受けること。出来事の並びは、モジュールの先頭に書いた
 * W3C の仕様が決めるもの。
 *
 * ここで見ないもの: 長押しを待つ時間と、地図の出来事を部品へ渡す結線と、決まった操作で開く物 → `app/page.popups.test.tsx`。
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

/** 出来事を順に渡し、最後の出来事で返ったことを返す。 */
function play(g: MapGestures, ...events: MapGestureEvent[]) {
  return events.map((event) => g.handle(event)).at(-1);
}

/** 指1本を置いて動かさずに離す（指のクリックのあとの互換のマウスの出来事も続ける）。 */
const FINGER_TAP = [touchStart(), touchEnd(), mouseDown, click];

describe("タップ", () => {
  it.each<[string, MapGestureEvent[], boolean]>([
    ["指を置いて同じ所で離した", FINGER_TAP, true],
    ["離すまでに動いたのが、地図をずらす幅まで", [touchStart(), touchMove(TAP_TOLERANCE_PX), touchEnd(), click], true],
    ["離すまでに、地図をずらす幅より動いた", [touchStart(), touchMove(TAP_TOLERANCE_PX + 1), touchEnd(), click], false],
    ["2本目の指が乗った", [touchStart(), touchStart(2), touchEnd(1), touchEnd(), click], false],
    [
      "押し始めに地図が利用者の操作で流れていた",
      [{ type: "movestart", byUser: true }, touchStart(), { type: "moveend" }, touchEnd(), click],
      false,
    ],
    ["押し始めに地図がプログラムで動いていた", [{ type: "movestart", byUser: false }, ...FINGER_TAP], true],
    ["マウスで押して同じ所で離した", [mouseDown, click], true],
  ])("%s", (_, events, tapped) => {
    expect(play(new MapGestures(), ...events) === "tap").toBe(tapped);
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
    play(g, ...events);
    expect(g.confirmLongPress()).toBe(longPressed);
  });

  it("長押しになった押しは、離したあとのクリックをタップにしない", () => {
    const g = new MapGestures();
    g.handle(touchStart());
    g.confirmLongPress();
    expect(play(g, touchEnd(), mouseDown, click)).toBeNull();
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
