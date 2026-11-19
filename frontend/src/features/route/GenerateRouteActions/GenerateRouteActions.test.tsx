/**
 * 「ルート設定」の見出しの操作（候補数の選び手と「ルート生成」のボタン）。
 *
 * 見ること: 候補数の選び手が今の件数を出し、開くと下限から上限までの数を並べて今の数を選んだ状態にしてそこへフォーカスを置き、
 * 選ぶと文字列で上げて閉じること。「生成」のボタンが作っている間（形が回る輪のとき）も、添えた文字「生成」を替えず、アイコンのボタンとして長押しで
 * 名前（進み方）を出し、離しても作り直さないこと。
 * ここで見ないもの: 押すと作り、作っている間の名前が進み方になることは`app/page.test.tsx`が、長押しの扱いそのものは
 * `components/UsageGuide/UsageTooltip.test.tsx`が見る。
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import UsageTooltip, { LONG_PRESS_MS } from "@/components/UsageGuide/UsageTooltip";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import GenerateRouteActions from "./GenerateRouteActions";

const IDLE = { conditionsDirty: false, running: false, progressLabel: "", submit: () => Promise.resolve() };

describe("候補数", () => {
  it("今の件数を出し、開くと下限から上限までを並べて今の数を選んだ状態にしてそこへ移り、選ぶと文字列で上げて閉じる", async () => {
    const setMaxRoutesInput = vi.fn();
    render(
      <GenerateRouteActions
        generation={IDLE}
        routeCount={{ maxRoutesInput: "8", setMaxRoutesInput }}
        labeled={false}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "候補数（8件）" }));
    const menu = within(screen.getByRole("dialog", { name: "候補数を選ぶ" }));
    const { min_routes: min, max_routes: max } = routeGenerateConfig;
    expect(menu.getAllByRole("radio").map((count) => count.textContent)).toEqual(
      Array.from({ length: max - min + 1 }, (_, i) => String(min + i)),
    );
    const chosen = menu.getByRole("radio", { checked: true });
    expect(chosen).toHaveAccessibleName("8件");
    expect(chosen).toHaveFocus();
    await userEvent.click(menu.getByRole("radio", { name: "12件" }));

    expect(setMaxRoutesInput).toHaveBeenCalledExactlyOnceWith("12");
    expect(screen.queryByRole("dialog", { name: "候補数を選ぶ" })).not.toBeInTheDocument();
  });
});

describe("生成", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("作っている間も文字「生成」を出したまま、長押しすると進み方を名前に出し、離しても作り直さない", () => {
    const submit = vi.fn();
    render(
      <>
        <GenerateRouteActions
          generation={{ conditionsDirty: false, running: true, progressLabel: "生成中...(3秒経過)", submit }}
          routeCount={{ maxRoutesInput: "8", setMaxRoutesInput: () => {} }}
          labeled
        />
        <UsageTooltip />
      </>,
    );
    const button = screen.getByRole("button", { name: "生成中...(3秒経過)" });
    expect(button).toHaveTextContent("生成");

    fireEvent.pointerDown(button, { pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent("生成中...(3秒経過)");
    fireEvent.pointerUp(button, { pointerType: "touch", button: 0 });
    fireEvent.click(button);
    expect(submit).not.toHaveBeenCalled();
  });
});
