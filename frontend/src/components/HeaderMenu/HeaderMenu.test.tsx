/**
 * `components/HeaderMenu/HeaderMenu.tsx`——ヘッダーのメニュー（頭のアプリの名前と版・使い方を見る・初回の案内・地図を描き直す・デバッグログの開閉）。
 *
 * 見るもの: メニューを開くと頭にアプリの名前と、フロントの版の口（`/api/version`）が返した版が出ること、「使い方を見る」を押すとメニューが閉じ、フォーカスが開くボタンへ戻ってから説明を見る状態に入る操作が上がること、
 * 「初回の案内をもう一度見る」を押すと案内を出す操作が上がってメニューが閉じること、「地図を描き直す」を押すと描き直しの操作が上がってメニューが閉じること、
 * デバッグログの項目がデバッグモードの間だけ出て、開閉の状態を名前で出し、押すと開閉の操作が上がること、
 * 走行の記録が端末にあるときだけ「走行の記録をコピー」が出て、押すと記録を写すこと。
 *
 * メニューを開くと版を取りに行くので、どのテストも版の口の応答を与える。
 *
 * ここで見ないもの: デバッグモードそのもののON/OFF → `features/admin/DebugPanel/DebugPanel.tsx`（このメニューは呼び出し側から受け取るだけ）。
 * 説明を見る状態で部品の使い方が出ること → `components/UsageGuide/UsageGuide.test.tsx`（メニューのボタンの使い方の文は宣言）。
 * 押下の状態（`aria-pressed`）——`components/ui/Toggle`へそのまま渡すだけ。
 * 版をどこから読むか → `app/api/version/route.test.ts`。走行の記録の中身 → `lib/rideMetrics.test.ts`。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FrontendVersion } from "@/services/versionApi";
import { readRideMetrics, startRideMetrics, stopRideMetrics } from "@/lib/rideMetrics";
import { formatRideMetrics } from "@/lib/rideMetricsFormat";
import { onSameOrigin } from "@/testing/backendServer";

import HeaderMenu from "./HeaderMenu";

const LOCAL_VERSION: FrontendVersion = { commit: null, started_at: "2026-10-08T22:00:00Z" };

async function openMenu(props: Partial<React.ComponentProps<typeof HeaderMenu>> = {}, version = LOCAL_VERSION) {
  onSameOrigin("GET", "/api/version", () => Response.json(version));
  const onToggleDebugConsole = vi.fn();
  const onShowIntro = vi.fn();
  const onStartUsageGuide = vi.fn();
  const onRedrawMap = vi.fn();
  render(
    <HeaderMenu
      debugEnabled={false}
      debugConsoleOpen={false}
      onToggleDebugConsole={onToggleDebugConsole}
      onStartUsageGuide={onStartUsageGuide}
      onShowIntro={onShowIntro}
      onRedrawMap={onRedrawMap}
      {...props}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "メニュー" }));
  return { onToggleDebugConsole, onStartUsageGuide, onShowIntro, onRedrawMap };
}

describe("HeaderMenu", () => {
  it("「使い方を見る」を押すと、メニューが閉じてフォーカスが開くボタンへ戻ってから、説明を見る状態に入る操作が上がる", async () => {
    const { onStartUsageGuide } = await openMenu();
    let focusedAtStart: Element | null = null;
    onStartUsageGuide.mockImplementation(() => {
      focusedAtStart = document.activeElement;
    });

    await userEvent.click(screen.getByRole("button", { name: "使い方を見る" }));

    expect(onStartUsageGuide).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "使い方を見る" })).not.toBeInTheDocument();
    expect(focusedAtStart).toBe(screen.getByRole("button", { name: "メニュー" }));
  });

  it.each([
    ["初回の案内をもう一度見る", "onShowIntro"],
    ["地図を描き直す", "onRedrawMap"],
  ] as const)("「%s」を押すと、その操作（%s）が上がってメニューが閉じる", async (name, handler) => {
    const handlers = await openMenu();

    await userEvent.click(screen.getByRole("button", { name }));

    expect(handlers[handler]).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });

  describe("デバッグログ", () => {
    it("デバッグモードでなければ項目を出さない", async () => {
      await openMenu({ debugEnabled: false });

      expect(screen.queryByRole("button", { name: /デバッグログ/ })).not.toBeInTheDocument();
    });

    it.each([
      [false, "デバッグログを表示"],
      [true, "デバッグログを隠す"],
    ])("開いている（%s）かを名前で出し、押すと開閉の操作が上がる", async (open, name) => {
      const { onToggleDebugConsole } = await openMenu({ debugEnabled: true, debugConsoleOpen: open });

      await userEvent.click(screen.getByRole("button", { name }));

      expect(onToggleDebugConsole).toHaveBeenCalledTimes(1);
    });
  });

  it("走行の記録が端末にあるときだけ「走行の記録をコピー」を出し、押すと記録を写して写したことを名前で出す", async () => {
    await openMenu();
    expect(screen.queryByRole("button", { name: /走行の記録/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "メニュー" }));

    startRideMetrics();
    stopRideMetrics();
    await userEvent.click(screen.getByRole("button", { name: "メニュー" }));
    await userEvent.click(screen.getByRole("button", { name: "走行の記録をコピー" }));

    expect(await navigator.clipboard.readText()).toBe(formatRideMetrics(readRideMetrics()!));
    expect(screen.getByRole("button", { name: "走行の記録をコピーしました" })).toBeInTheDocument();
  });

  it.each([
    ["9c2521ce0123456789abcdef0123456789abcdef", /^RideCompassバージョン 9c2521ce$/],
    [null, /^RideCompass手元で動いているバージョンです\[本番のバージョンではありません\]。$/],
  ])("頭にアプリの名前と、版の口が返した版（%s）を出す", async (commit, identity) => {
    await openMenu({}, { commit, started_at: "2026-10-08T22:00:00Z" });

    const head = screen.getByText("RideCompass").parentElement;
    await waitFor(() => expect(head).toHaveTextContent(identity));
  });
});
