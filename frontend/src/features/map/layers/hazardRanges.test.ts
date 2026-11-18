import { describe, expect, it } from "vitest";

import { markCells, outlinesOf, spreadMarks } from "./hazardRanges";

/** `rows`の文字列（`#`が色のあるマス）を格子にする。 */
function gridOf(rows: string[]): { grid: Uint8Array; width: number; height: number } {
  const width = rows[0].length;
  const grid = new Uint8Array(rows.flatMap((row) => [...row].map((c) => (c === "#" ? 1 : 0))));
  return { grid, width, height: rows.length };
}

const WHOLE = (width: number, height: number) => ({ x0: 0, x1: width, y0: 0, y1: height });

describe("範囲の印の置き場", () => {
  it("つながった塊ごとに1つ、塊の端から一番遠いマスに置く（斜めにつながったマスは同じ塊）", () => {
    const { grid, width, height } = gridOf([
      "#####.......",
      "#####.......",
      "#####....#..",
      "#####.....#.",
      "#####......#",
    ]);

    const marks = markCells(grid, width, height, WHOLE(width, height), 1);

    expect(marks).toHaveLength(2);
    expect(marks[0].slice(0, 2)).toEqual([2, 2]);
  });

  it("見えている範囲の外へ続く塊は、見えている範囲の中に、その縁から離して置く", () => {
    const { grid, width, height } = gridOf(["##########", "##########", "##########", "##########"]);

    const [[x, y]] = markCells(grid, width, height, { x0: 6, x1: 10, y0: 0, y1: 4 }, 1);

    expect(x).toBeGreaterThanOrEqual(6);
    expect(x).toBeLessThanOrEqual(9);
    expect([1, 2]).toContain(y);
  });

  it("見えている範囲の中のマスが少ない塊には置かない", () => {
    const { grid, width, height } = gridOf(["#.........", "..........", "......####", "......####"]);

    const marks = markCells(grid, width, height, WHOLE(width, height), 2);

    expect(marks).toHaveLength(1);
    expect(marks[0][0]).toBeGreaterThanOrEqual(6);
    expect(marks[0][1]).toBeGreaterThanOrEqual(2);
  });

  it("塊の中でいちばん強い段を返す", () => {
    const grid = new Uint8Array([1, 1, 2, 0, 0, 0, 1, 1, 1]);

    expect(markCells(grid, 3, 3, WHOLE(3, 3), 1).map((mark) => mark[2])).toEqual([2, 1]);
  });
});

describe("範囲の外形", () => {
  it("塊の境を閉じた折れ線でなぞり、並べた格子の縁には境を作らない", () => {
    const { grid, width, height } = gridOf(["......", ".###..", ".###..", "......"]);

    const [line] = outlinesOf(grid, width, height);

    expect(outlinesOf(grid, width, height)).toHaveLength(1);
    expect(line[0]).toEqual(line[line.length - 1]);
    // 境は、色のあるマス（1〜3列目）と無いマスの間の、マスの端の位置を通る。
    expect(Math.min(...line.map(([x]) => x))).toBe(1);
    expect(Math.max(...line.map(([x]) => x))).toBe(4);
  });

  it("段の違うマスがつながった塊も、1つの外形でなぞる", () => {
    const grid = new Uint8Array([0, 0, 0, 0, 0, 1, 3, 0, 0, 2, 4, 0, 0, 0, 0, 0]);

    expect(outlinesOf(grid, 4, 4)).toHaveLength(1);
  });

  it("並べた格子の縁まで続く塊は、縁を境にしない", () => {
    const { grid, width, height } = gridOf(["###...", "###...", "###..."]);

    const lines = outlinesOf(grid, width, height);

    expect(lines.flat().every(([x]) => x > 2)).toBe(true);
  });
});

describe("印を寄せて並べる", () => {
  it("近い印は重心に寄せて横に並べ、離れた印はそのまま", () => {
    expect(
      spreadMarks(
        [
          [100, 100],
          [110, 104],
          [300, 300],
        ],
        30,
      ),
    ).toEqual([
      [90, 102],
      [120, 102],
      [300, 300],
    ]);
  });
});
