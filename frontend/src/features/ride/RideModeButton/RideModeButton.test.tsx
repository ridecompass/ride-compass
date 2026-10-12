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
  ] as const)("$status: 入切と、押したときの動きを示す", async ({ status, pressed, next }) => {
    const onPress = vi.fn();
    render(<RideModeButton status={status} error={null} screenWakeLock="off" onPress={onPress} />);
    const button = screen.getByRole("button", { name: "走行モード" });
    expect(button).toHaveAttribute("aria-pressed", pressed);
    expect(button).toHaveAttribute("title", next);

    await userEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it.each([
    { case: "頼めていれば出さない", screenWakeLock: "held", shown: false },
    { case: "頼めない端末では出す", screenWakeLock: "unavailable", shown: true },
  ] as const)("画面を点けたままにできないこと: $case", ({ screenWakeLock, shown }) => {
    render(<RideModeButton status="following" error={null} screenWakeLock={screenWakeLock} onPress={() => {}} />);
    if (shown) expect(screen.getByText(WAKE_LOCK_NOTICE)).toBeInTheDocument();
    else expect(screen.queryByText(WAKE_LOCK_NOTICE)).toBeNull();
  });

  it("始められなかった理由を出す", () => {
    render(
      <RideModeButton status="off" error="位置情報の利用が許可されていない" screenWakeLock="off" onPress={() => {}} />,
    );
    expect(screen.getByText("位置情報の利用が許可されていない")).toBeInTheDocument();
  });
});
