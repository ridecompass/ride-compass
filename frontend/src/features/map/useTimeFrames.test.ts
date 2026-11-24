/**
 * 出発の時刻を含むコマの印を選ぶこと（`useTimeFrames.ts`の`frameAt`と`useTimeFrames`）。コマが何で変わるかは backend が決め、
 * 画面は一覧から選ぶだけ。
 *
 * ここで見ないもの:
 * - 印を要求へ載せること → `regionApi.test.ts`・`useWayMaterials.test.ts`
 */
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { frameAt, useTimeFrames, withFreshFrames } from "@/features/map/useTimeFrames";
import { ApiHttpError } from "@/lib/apiClient";
import { onBackend } from "@/testing/backendServer";

const FRAMES = [
  { start: "2026-11-24T10:00:00+09:00", end: "2026-11-24T10:30:00+09:00", key: "a" },
  { start: "2026-11-24T10:30:00+09:00", end: "2026-11-24T11:30:00+09:00", key: "b" },
];

describe("frameAt", () => {
  it.each([
    ["始まりちょうどはそのコマ", "2026-11-24T10:30:00+09:00", "b"],
    ["終わりちょうどは次のコマ", "2026-11-24T10:29:59+09:00", "a"],
    ["一覧の外は、含むコマが無い", "2026-11-24T11:30:00+09:00", null],
  ])("%s", (_, at, expected) => {
    expect(frameAt(FRAMES, new Date(at))).toBe(expected);
  });

  it("一覧がまだ届いていなければ、選べるかもまだ分からない", () => {
    expect(frameAt(undefined, new Date())).toBeUndefined();
  });
});

describe("useTimeFrames", () => {
  it("路面タイルとレンズの、出発の時刻を含むコマの印を選ぶ", async () => {
    onBackend("GET", "/api/region/time-frames", () =>
      Response.json({ road_surface: [{ ...FRAMES[0], end: "2026-11-26T11:00:00+09:00", key: "road" }], lens: FRAMES }),
    );

    const { result } = renderHook(() => useTimeFrames(new Date("2026-11-24T10:45:00+09:00")));

    await waitFor(() => expect(result.current).toEqual({ roadSurface: "road", lens: "b" }));
  });
});

describe("withFreshFrames", () => {
  it("古い印で断られた要求は、コマの一覧を読み直させる（新しい印で取り直す）", async () => {
    let served = 0;
    onBackend("GET", "/api/region/time-frames", () => {
      served += 1;
      return Response.json({ road_surface: [], lens: FRAMES });
    });
    renderHook(() => useTimeFrames(new Date("2026-11-24T10:45:00+09:00")));
    await waitFor(() => expect(served).toBe(1));

    await expect(withFreshFrames(Promise.reject(new ApiHttpError("古い", 409)))).rejects.toThrow("古い");

    await waitFor(() => expect(served).toBe(2));
  });
});
