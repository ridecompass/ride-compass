/**
 * `features/route/RouteCandidateActions/RouteCandidateActions.tsx`——選んでいる候補1本への操作（走る・合成・GPX出力）。
 *
 * 見るもの: 走るを押すとその候補のidで走行モードを始める操作が上がり、受け口が無ければ出さないこと、合成は始められる
 * ときだけ出し、押すとその候補で編集を始めて押していた区間を外すこと、GPX出力はその候補を書き出すこと。
 *
 * ここで見ないもの: どの候補が相手か・編集中に出さないこと・走ったあとシートを閉じること → `app/page.tsx`（見出しの行に
 * 置く所）。使い方の文——受け取った値を文へそのまま入れるだけ。
 *
 * 差し替えたもの: GPXのファイルを落とす関数（`features/route/gpxExport.ts: downloadGpx`）。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadGpx } from "@/features/route/gpxExport";
import { makeRouteCandidate } from "@/testing/routeFixtures";
import RouteCandidateActions from "./RouteCandidateActions";

vi.mock("@/features/route/gpxExport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/route/gpxExport")>()),
  downloadGpx: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const ROUTE = makeRouteCandidate({ id: "slow" });

function renderActions(props: Partial<ComponentProps<typeof RouteCandidateActions>> = {}) {
  const all = {
    route: ROUTE,
    splice: { canStart: false, start: vi.fn() },
    onClearSegment: vi.fn(),
    ...props,
  };
  render(<RouteCandidateActions {...all} />);
  return all;
}

describe("RouteCandidateActions", () => {
  it("走るを押すと、その候補のidで走行モードを始める操作を上げる", async () => {
    const onRide = vi.fn();
    renderActions({ onRide });
    await userEvent.click(screen.getByRole("button", { name: "このルートで走る" }));
    expect(onRide).toHaveBeenCalledWith("slow");
  });

  it("走る受け口が無ければ、走るを出さない", () => {
    renderActions();
    expect(screen.queryByRole("button", { name: "このルートで走る" })).not.toBeInTheDocument();
  });

  it("合成は始められるときだけ出し、押すとその候補で編集を始めて押していた区間を外す", async () => {
    const { splice, onClearSegment } = renderActions({ splice: { canStart: true, start: vi.fn() } });
    await userEvent.click(screen.getByRole("button", { name: "ルートを合成" }));
    expect(splice.start).toHaveBeenCalledWith("slow");
    expect(onClearSegment).toHaveBeenCalled();
  });

  it("編集を始められない生成では合成を出さない", () => {
    renderActions();
    expect(screen.queryByRole("button", { name: "ルートを合成" })).not.toBeInTheDocument();
  });

  it("GPX出力はその候補を書き出す", async () => {
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "GPX出力" }));
    expect(downloadGpx).toHaveBeenCalledWith(ROUTE);
  });
});
