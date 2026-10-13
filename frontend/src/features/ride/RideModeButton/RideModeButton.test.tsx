/**
 * 走行モードのボタン（`features/ride/RideModeButton/RideModeButton.tsx`）——入切と次に押したときの動きを示し、始められなかった
 * 理由と、画面を点けたままにできない端末であることを横に出す。
 *
 * ここで見ないもの: 押したあとの走行モードの移り変わり → `useRideMode.test.ts`
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import RideModeButton from "./RideModeButton";

const WAKE_LOCK_NOTICE = /画面を点けたままにできません/;

describe("RideModeButton", () => {
  it.each([
    { status: "off", pressed: "false", next: "走行モードを始める" },
    { status: "following", pressed: "true", next: "走行モードを止める" },
    { status: "paused", pressed: "true", next: "地図を現在地へ戻す" },
  ] as const)("$status: 入切と、押したときの動きを示し、面の塗りを様子で分ける", async ({ status, pressed, next }) => {
    const onPress = vi.fn();
    render(<RideModeButton status={status} error={null} screenWakeLock="off" onPress={onPress} />);
    const button = screen.getByRole("button", { name: "走行モード" });
    expect(button).toHaveAttribute("aria-pressed", pressed);
    expect(button).toHaveAttribute("title", next);
    // 面の塗りは様子の印（data-ride）に当てる。塗りが効いて見分けられるかは e2e/ride-mode.spec.ts が計算後の色で見る。
    expect(button).toHaveAttribute("data-ride", status);

    await userEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("画面を点けたままにできない端末では、文を出し、閉じても印と読み上げの説明は残す。頼めていれば何も出さない", async () => {
    const { rerender } = render(
      <RideModeButton status="following" error={null} screenWakeLock="held" onPress={() => {}} />,
    );
    const button = screen.getByRole("button", { name: "走行モード" });
    expect(screen.queryByText(WAKE_LOCK_NOTICE)).toBeNull();
    expect(button).not.toHaveAttribute("aria-description");

    rerender(<RideModeButton status="following" error={null} screenWakeLock="unavailable" onPress={() => {}} />);
    expect(screen.getByText(WAKE_LOCK_NOTICE)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByText(WAKE_LOCK_NOTICE)).toBeNull();
    expect(button).toHaveAttribute("aria-description", expect.stringMatching(WAKE_LOCK_NOTICE));

    // 止めて始め直すと、また文を出す。
    rerender(<RideModeButton status="off" error={null} screenWakeLock="off" onPress={() => {}} />);
    rerender(<RideModeButton status="following" error={null} screenWakeLock="unavailable" onPress={() => {}} />);
    expect(screen.getByText(WAKE_LOCK_NOTICE)).toBeInTheDocument();
  });

  it("始められなかった理由を出す", () => {
    render(
      <RideModeButton status="off" error="位置情報の利用が許可されていない" screenWakeLock="off" onPress={() => {}} />,
    );
    expect(screen.getByText("位置情報の利用が許可されていない")).toBeInTheDocument();
  });
});
