/**
 * 「ルート生成」のボタン。
 *
 * 見ること: 作っている間（形が回る輪のとき）も、添えた文字「生成」を替えず、アイコンのボタンとして長押しで名前（進み方）を出し、
 * 離しても作り直さないこと。
 * ここで見ないもの: 押すと作り、作っている間の名前が進み方になることは`app/page.test.tsx`が、長押しの扱いそのものは
 * `components/UsageGuide/UsageTooltip.test.tsx`が見る。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import UsageTooltip, { LONG_PRESS_MS } from "@/components/UsageGuide/UsageTooltip";
import GenerateRouteActions from "./GenerateRouteActions";

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
