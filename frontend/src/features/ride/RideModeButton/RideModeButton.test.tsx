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

import { translate } from "@/i18n/config";

import RideModeButton from "./RideModeButton";

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
    noticeHost: null,
    ...overrides,
  };
}

describe("RideModeButton", () => {
  it("休んでいる間は、押すと「続きから走る」か案内を終えるかを選ばせ、選んだ方だけを知らせて閉じる", async () => {
    const handlers = { onPress: vi.fn(), onRest: vi.fn(), onResume: vi.fn() };
    render(<RideModeButton {...props({ status: "resting", ...handlers })} />);
    const button = screen.getByRole("button", { name: translate("ride.mode.label") });

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: translate("ride.resume") }));
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
    expect(handlers.onPress).not.toHaveBeenCalled();
    expect(handlers.onRest).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: translate("ride.mode.end") })).toBeNull();

    await userEvent.click(button);
    await userEvent.click(screen.getByRole("button", { name: translate("ride.mode.end") }));
    expect(handlers.onPress).toHaveBeenCalledTimes(1);
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: translate("ride.resume") })).toBeNull();
  });

  it("画面を点けたままにできない端末では、文を出し、閉じても印と読み上げの説明は残す。頼めていれば何も出さない", async () => {
    const { rerender } = render(<RideModeButton {...props({ screenWakeLock: "held" })} />);
    const button = screen.getByRole("button", { name: translate("ride.mode.label") });
    expect(screen.queryByRole("status")).toBeNull();
    expect(button).not.toHaveAttribute("aria-description");

    rerender(<RideModeButton {...props({ screenWakeLock: "unavailable" })} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: translate("common.close") }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(button).toHaveAttribute("aria-description", translate("ride.mode.wakeLockUnavailable"));

    // 止めて始め直すと、また文を出す。
    rerender(<RideModeButton {...props({ status: "off" })} />);
    rerender(<RideModeButton {...props({ screenWakeLock: "unavailable" })} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
