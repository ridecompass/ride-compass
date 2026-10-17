/**
 * 走行モードのボタン（`features/ride/RideModeButton/RideModeButton.tsx`）——入切と次に押したときの動きを示し、走行モードの間に
 * 押すと案内を終えるか、休む（休んでいれば続きから走る）かを選ばせ、始められなかった理由と、画面を点けたままにできない端末であることを横に出す。
 *
 * ここで見ないもの: 押したあとの走行モードの移り変わり → `useRideMode.test.ts`
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import RideModeButton from "./RideModeButton";

const WAKE_LOCK_NOTICE = /画面を点けたままにできません/;

describe("RideModeButton", () => {
  it("止まっている間は、押すとすぐ始める", async () => {
    const onPress = vi.fn();
    render(
      <RideModeButton
        status="off"
        error={null}
        screenWakeLock="off"
        onPress={onPress}
        onRest={() => {}}
        onResume={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "走行モード" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("title", "走行モードを始める");
    // 面の塗りは様子の印（data-ride）に当てる。塗りが効いて見分けられるかは e2e/ride-mode.spec.ts が計算後の色で見る。
    expect(button).toHaveAttribute("data-ride", "off");

    await userEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "案内を終える" })).toBeNull();
  });

  it.each([
    { status: "following", choice: "休む", chosen: "onRest" },
    { status: "paused", choice: "休む", chosen: "onRest" },
    { status: "resting", choice: "続きから走る", chosen: "onResume" },
  ] as const)(
    "$status: 押すと「$choice」か案内を終えるかを選ばせ、選んだ方だけを知らせて閉じる",
    async ({ status, choice, chosen }) => {
      const handlers = { onPress: vi.fn(), onRest: vi.fn(), onResume: vi.fn() };
      render(<RideModeButton status={status} error={null} screenWakeLock="off" {...handlers} />);
      const button = screen.getByRole("button", { name: "走行モード" });
      expect(button).toHaveAttribute("aria-pressed", "true");
      expect(button).toHaveAttribute("data-ride", status);

      await userEvent.click(button);
      expect(button).toHaveAttribute("aria-expanded", "true");
      await userEvent.click(screen.getByRole("button", { name: choice }));
      expect(handlers[chosen]).toHaveBeenCalledTimes(1);
      const others = (["onPress", "onRest", "onResume"] as const).filter((name) => name !== chosen);
      expect(others).toHaveLength(2);
      for (const name of others) expect(handlers[name]).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "案内を終える" })).toBeNull();

      await userEvent.click(button);
      await userEvent.click(screen.getByRole("button", { name: "案内を終える" }));
      expect(handlers.onPress).toHaveBeenCalledTimes(1);
      expect(handlers[chosen]).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: choice })).toBeNull();
    },
  );

  it("画面を点けたままにできない端末では、文を出し、閉じても印と読み上げの説明は残す。頼めていれば何も出さない", async () => {
    const { rerender } = render(
      <RideModeButton
        status="following"
        error={null}
        screenWakeLock="held"
        onPress={() => {}}
        onRest={() => {}}
        onResume={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "走行モード" });
    expect(screen.queryByText(WAKE_LOCK_NOTICE)).toBeNull();
    expect(button).not.toHaveAttribute("aria-description");

    rerender(
      <RideModeButton
        status="following"
        error={null}
        screenWakeLock="unavailable"
        onPress={() => {}}
        onRest={() => {}}
        onResume={() => {}}
      />,
    );
    expect(screen.getByText(WAKE_LOCK_NOTICE)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByText(WAKE_LOCK_NOTICE)).toBeNull();
    expect(button).toHaveAttribute("aria-description", expect.stringMatching(WAKE_LOCK_NOTICE));

    // 止めて始め直すと、また文を出す。
    rerender(
      <RideModeButton
        status="off"
        error={null}
        screenWakeLock="off"
        onPress={() => {}}
        onRest={() => {}}
        onResume={() => {}}
      />,
    );
    rerender(
      <RideModeButton
        status="following"
        error={null}
        screenWakeLock="unavailable"
        onPress={() => {}}
        onRest={() => {}}
        onResume={() => {}}
      />,
    );
    expect(screen.getByText(WAKE_LOCK_NOTICE)).toBeInTheDocument();
  });

  it("始められなかった理由を出す", () => {
    render(
      <RideModeButton
        status="off"
        error="位置情報の利用が許可されていない"
        screenWakeLock="off"
        onPress={() => {}}
        onRest={() => {}}
        onResume={() => {}}
      />,
    );
    expect(screen.getByText("位置情報の利用が許可されていない")).toBeInTheDocument();
  });
});
