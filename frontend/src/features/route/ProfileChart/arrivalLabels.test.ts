// @vitest-environment node
/**
 * 対象: 道のりのグラフの経由地の着く時刻の札の置き方（`placeArrivalLabels`）。札の大きさを測って渡す部品と、実際の画面で札どうしが
 * 重ならないことは、全状態の走査（`frontend/e2e/all-states.spec.ts`）が見る。
 */
import { describe, expect, it } from "vitest";

import { placeArrivalLabels, type LabelSpot } from "./arrivalLabels";

const CHART = { width: 300, height: 100 };
const spot = (centerX: number): LabelSpot => ({ centerX, top: 60, width: 40, height: 16 });

describe("placeArrivalLabels", () => {
  it.each([
    // 離れた札は真下の真ん中に置く。
    {
      name: "離れた札",
      spots: [spot(50), spot(150)],
      obstacles: [],
      want: [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
    },
    // 図の端からはみ出す札は、図の内側へ寄せる（利用者には右端の時刻が切れずに読める）。
    { name: "左の端", spots: [spot(5)], obstacles: [], want: [{ x: 15, y: 0 }] },
    { name: "右の端", spots: [spot(295)], obstacles: [], want: [{ x: -15, y: 0 }] },
    // 近い経由地の札は、右の札を下の段へずらす（2つの時刻が重なって「09 09:19着」と読めない）。
    {
      name: "近い札",
      spots: [spot(150), spot(130)],
      obstacles: [],
      want: [
        { x: 0, y: 16 },
        { x: 0, y: 0 },
      ],
    },
    // 下の段も埋まっていれば、その札は見せない。
    {
      name: "3つ近い札",
      spots: [spot(100), spot(110), spot(120)],
      obstacles: [],
      want: [
        { x: 0, y: 0 },
        { x: 0, y: 16 },
        { x: 0, y: null },
      ],
    },
    // 図の内側へ寄せた札が距離の目盛りと重なれば、下の段へずらす。
    {
      name: "目盛りと重なる札",
      spots: [spot(290)],
      obstacles: [{ left: 250, right: 296, top: 60, bottom: 76 }],
      want: [{ x: -10, y: 16 }],
    },
    // 文字の行の箱の上下の余白どうしの重なり（2pxまで）は、字が重ならないので同じ段に置く。
    {
      name: "目盛りと上下に2px重なる札",
      spots: [spot(150)],
      obstacles: [{ left: 130, right: 170, top: 74, bottom: 90 }],
      want: [{ x: 0, y: 0 }],
    },
    {
      name: "目盛りと上下に3px重なる札",
      spots: [spot(150)],
      obstacles: [{ left: 130, right: 170, top: 73, bottom: 76 }],
      want: [{ x: 0, y: 16 }],
    },
    // 下の段が図の下の端を2pxより越えるなら、そこへは置かない（行の箱の下の余白だけが図の外に出るまでは置く）。
    {
      name: "下の段が図の下の端を2px越える",
      spots: [spot(100), spot(110)],
      obstacles: [],
      chart: { width: 300, height: 90 },
      want: [
        { x: 0, y: 0 },
        { x: 0, y: 16 },
      ],
    },
    {
      name: "下の段が図の下の端を3px越える",
      spots: [spot(100), spot(110)],
      obstacles: [],
      chart: { width: 300, height: 89 },
      want: [
        { x: 0, y: 0 },
        { x: 0, y: null },
      ],
    },
  ])("$name", ({ spots, obstacles, chart = CHART, want }) => {
    expect(placeArrivalLabels(spots, chart, obstacles)).toEqual(want);
  });
});
