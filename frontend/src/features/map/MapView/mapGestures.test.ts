// @vitest-environment node
/**
 * `features/map/MapView/mapGestures.ts`——地図に触れた操作が、タップか長押しか地図を動かす操作か。
 *
 * 見るもの: 決まり（`docs/modules/frontend/static-map-layers.md`「地図を押したときと地図の小窓」の「押したとき」）のとおり、地図を動かす
 * 操作（ずらす・2本の指・ダブルタップ・流れている地図を止める・確かめる間に地図を動かし始める）はタップにも長押しにもならず、
 * それ以外の1回の押しは、確かめの時が来てからタップに、指1本を動かさずに置き続けると長押しになること。マウスの右ボタンは長押しと
 * 同じに受けること。指の押しのあとの互換のマウスの出来事（W3C の Touch Events で、指のクリックのあとに`mousedown`・`click`が続く）を、
 * 新しい押しに数えないこと。
 *
 * ここで見ないもの: 地図の出来事を部品へ渡す結線と、決まった操作で開く物 → `app/page.popups.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { LONG_PRESS_MS, MapGestures, TAP_CONFIRM_MS, TAP_TOLERANCE_PX, type MapGesture } from "./mapGestures";

const AT = { x: 100, y: 100 };
const right = (px: number) => ({ x: AT.x + px, y: AT.y });

/** 時刻0から操作を流し、`until`までに判断の時が来た操作を順に返す。 */
function gesturesOf(operate: (g: MapGestures) => void, until: number): MapGesture[] {
  const g = new MapGestures();
  operate(g);
  const found: MapGesture[] = [];
  for (let dueAt = g.nextDueAt(); dueAt !== null && dueAt <= until; dueAt = g.nextDueAt()) {
    const gesture = g.due(dueAt);
    if (gesture !== null) found.push(gesture);
  }
  return found;
}

/** 指1本を時刻`time`に置き、`releaseAt`に離して、押したまま同じ所で離した（クリック）とする。 */
function fingerTap(g: MapGestures, time: number, releaseAt = time + 100) {
  g.touchStart(AT, 1, time);
  g.touchEnd(0);
  g.mouseDown(AT);
  g.click(releaseAt);
}

describe("タップ", () => {
  it.each<[string, (g: MapGestures) => void, MapGesture[]]>([
    ["指を置いて同じ所で離した", (g) => fingerTap(g, 0), ["tap"]],
    [
      "離すまでに動いたのが、地図をずらす幅まで",
      (g) => (g.touchStart(AT, 1, 0), g.touchMove(right(TAP_TOLERANCE_PX), 1), g.touchEnd(0), g.click(100)),
      ["tap"],
    ],
    [
      "離すまでに、地図をずらす幅より動いた",
      (g) => (g.touchStart(AT, 1, 0), g.touchMove(right(TAP_TOLERANCE_PX + 1), 1), g.touchEnd(0), g.click(100)),
      [],
    ],
    [
      "2本目の指が乗った",
      (g) => (g.touchStart(AT, 1, 0), g.touchStart(AT, 2, 10), g.touchEnd(1), g.touchEnd(0), g.click(100)),
      [],
    ],
    [
      "押し始めに地図が利用者の操作で流れていた",
      (g) => (g.userMoveStart(), g.touchStart(AT, 1, 0), g.userMoveEnd(), g.touchEnd(0), g.click(100)),
      [],
    ],
    [
      "確かめる間に次の指が乗った（ダブルタップ。2回目のあとの互換のマウスの出来事も新しい押しに数えない）",
      (g) => (fingerTap(g, 0), fingerTap(g, 100 + TAP_CONFIRM_MS - 1)),
      [],
    ],
    [
      "確かめが済んでから次の指が乗った",
      (g) => (fingerTap(g, 0), g.due(100 + TAP_CONFIRM_MS), fingerTap(g, 1000)),
      ["tap"],
    ],
    ["確かめる間に、地図が利用者の操作で動き始めた", (g) => (fingerTap(g, 0), g.userMoveStart()), []],
    ["マウスで押して同じ所で離した", (g) => (g.mouseDown(AT), g.click(0)), ["tap"]],
    [
      "マウスでダブルクリックした",
      (g) => (g.mouseDown(AT), g.click(0), g.mouseDown(AT), g.click(TAP_CONFIRM_MS - 1)),
      [],
    ],
  ])("%s", (_, operate, expected) => {
    expect(gesturesOf(operate, 10_000)).toEqual(expected);
  });

  it("確かめの時が来るまでは、タップにしない", () => {
    const g = new MapGestures();
    fingerTap(g, 0, 100);
    expect([g.due(100 + TAP_CONFIRM_MS - 1), g.due(100 + TAP_CONFIRM_MS)]).toEqual([null, "tap"]);
  });
});

describe("長押し", () => {
  it.each<[string, (g: MapGestures) => void, MapGesture[]]>([
    ["指1本を動かさずに置き続けた", (g) => g.touchStart(AT, 1, 0), ["longPress"]],
    [
      "置いている間に、地図をずらす幅より動いた",
      (g) => (g.touchStart(AT, 1, 0), g.touchMove(right(TAP_TOLERANCE_PX + 1), 1)),
      [],
    ],
    ["置いている間に2本目の指が乗った", (g) => (g.touchStart(AT, 1, 0), g.touchStart(AT, 2, 10)), []],
    ["長押しになる前に離した（タップになる）", (g) => (g.touchStart(AT, 1, 0), g.touchEnd(0), g.click(100)), ["tap"]],
    ["押し始めに地図が利用者の操作で流れていた", (g) => (g.userMoveStart(), g.touchStart(AT, 1, 0)), []],
    [
      "長押しになったあとに離した（離したあとのクリックはタップにしない）",
      (g) => (g.touchStart(AT, 1, 0), g.due(LONG_PRESS_MS), g.touchEnd(0), g.click(LONG_PRESS_MS + 100)),
      [],
    ],
  ])("%s", (_, operate, expected) => {
    expect(gesturesOf(operate, 10_000)).toEqual(expected);
  });

  it("置いてから長押しの時が来るまでは、長押しにしない", () => {
    const g = new MapGestures();
    g.touchStart(AT, 1, 0);
    expect([g.due(LONG_PRESS_MS - 1), g.due(LONG_PRESS_MS)]).toEqual([null, "longPress"]);
  });

  it("マウスの右ボタンはすぐ長押しとして受け、確かめを待つタップは取り消す。指を置いている間の右ボタンの出来事は受けない", () => {
    const mouse = new MapGestures();
    mouse.mouseDown(AT);
    mouse.click(0);
    const touch = new MapGestures();
    touch.touchStart(AT, 1, 0);
    expect([mouse.contextMenu(), mouse.due(TAP_CONFIRM_MS), touch.contextMenu()]).toEqual([true, null, false]);
  });
});
