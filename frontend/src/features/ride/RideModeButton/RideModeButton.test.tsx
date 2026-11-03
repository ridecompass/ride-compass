/**
 * 走行モードのボタン（`features/ride/RideModeButton/RideModeButton.tsx`）——入切を示し、走行モードの間に
 * 押すと案内を終えるか、休む（休んでいれば続きから走る）かを選ばせ、始められなかった理由と、画面を点けたままにできない端末であることを横に出す。
 *
 * ここで見ないもの: 止まっている間に押すと始めること・走っている間に押して休む・案内を終えること・入切の `aria-pressed` → `app/page.rideControl.test.tsx`、
 * スマホの向きを読む許しを求め直す札 → `page.ride.test.tsx`
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import RideModeButton from "./RideModeButton";

const WAKE_LOCK_NOTICE = /画面を点けたままにできません/;

type Props = Parameters<typeof RideModeButton>[0];

function props(overrides: Partial<Props> = {}): Props {
  return {
    status: "following",
    error: null,
    screenWakeLock: "off",
    onRequestHeading: null,
    onPress: () => {},
    onRest: () => {},
    onResume: () => {},
    ...overrides,
  };
}

describe("RideModeButton", () => {
  it("休んでいる間は、押すと「続きから走る」か案内を終えるかを選ばせ、選んだ方だけを知らせて閉じる", async () => {
    const handlers = { onPress: vi.fn(), onRest: vi.fn(), onResume: vi.fn() };
    render(<RideModeButton {...props({ status: "resting", ...handlers })} />);
    const button = screen.getByRole("button", { name: "走行モード" });

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: "続きから走る" }));
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
    expect(handlers.onPress).not.toHaveBeenCalled();
    expect(handlers.onRest).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "案内を終える" })).toBeNull();

    await userEvent.click(button);
    await userEvent.click(screen.getByRole("button", { name: "案内を終える" }));
    expect(handlers.onPress).toHaveBeenCalledTimes(1);
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "続きから走る" })).toBeNull();
  });

  it("画面を点けたままにできない端末では、文を出し、閉じても印と読み上げの説明は残す。頼めていれば何も出さない", async () => {
    const { rerender } = render(<RideModeButton {...props({ screenWakeLock: "held" })} />);
    const button = screen.getByRole("button", { name: "走行モード" });
    expect(screen.queryByText(WAKE_LOCK_NOTICE)).toBeNull();
    expect(button).not.toHaveAttribute("aria-description");

    rerender(<RideModeButton {...props({ screenWakeLock: "unavailable" })} />);
    expect(screen.getByText(WAKE_LOCK_NOTICE)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByText(WAKE_LOCK_NOTICE)).toBeNull();
    expect(button).toHaveAttribute("aria-description", expect.stringMatching(WAKE_LOCK_NOTICE));

    // 止めて始め直すと、また文を出す。
    rerender(<RideModeButton {...props({ status: "off" })} />);
    rerender(<RideModeButton {...props({ screenWakeLock: "unavailable" })} />);
    expect(screen.getByText(WAKE_LOCK_NOTICE)).toBeInTheDocument();
  });

  it("始められなかった理由を出す", () => {
    render(<RideModeButton {...props({ status: "off", error: "位置情報の利用が許可されていない" })} />);
    expect(screen.getByText("位置情報の利用が許可されていない")).toBeInTheDocument();
  });
});
