/**
 * `components/HeaderMenu/HeaderMenu.tsx`——ヘッダーのメニュー（使い方を見る・地図の表示を再描画・デバッグログの開閉・バージョン表示）。
 *
 * 見るもの: メニューを開くと出る項目、「使い方を見る」を押すとメニューが閉じ、フォーカスが開くボタンへ戻ってから説明を見る状態に入る操作が上がること、
 * 「地図の表示を再描画」を押すと描き直しの操作が上がってメニューが閉じること、
 * デバッグログの項目がデバッグモードの間だけ出て、開閉の状態を名前で出し、押すと開閉の操作が上がること、
 * 走行の記録が端末にあるときだけ「走行の記録をコピー」が出て、押すと記録を写すこと、
 * 「バージョン表示」を押すと、フロントの版の口（`/api/version`）が返した版が窓に出ること。
 * 「走りの記録」の窓で鍵を入れる・外すと端末の記録が入り切りし、送っていない走りの数を出すこと。
 *
 * ここで見ないもの: デバッグモードそのもののON/OFF → `features/admin/DebugPanel/DebugPanel.tsx`（このメニューは呼び出し側から受け取るだけ）。
 * 説明を見る状態で部品の使い方が出ること → `components/UsageGuide/UsageGuide.test.tsx`（メニューのボタンの使い方の文は宣言）。
 * 押下の状態（`aria-pressed`）——`components/ui/Toggle`へそのまま渡すだけ。
 * 版をどこから読むか → `app/api/version/route.test.ts`。走行の記録の中身 → `lib/rideMetrics.test.ts`。
 * 走りの記録の溜め方 → `lib/rideTrack.test.ts`。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FrontendVersion } from "@/services/versionApi";
import { formatRideMetrics, readRideMetrics, startRideMetrics, stopRideMetrics } from "@/lib/rideMetrics";
import { rideTrackWriteKey, startRideTrack, stopRideTrack } from "@/lib/rideTrack";
import { onSameOrigin } from "@/testing/backendServer";

import HeaderMenu from "./HeaderMenu";

async function openMenu(props: Partial<React.ComponentProps<typeof HeaderMenu>> = {}) {
  const onToggleDebugConsole = vi.fn();
  const onStartUsageGuide = vi.fn();
  const onRedrawMap = vi.fn();
  render(
    <HeaderMenu
      debugEnabled={false}
      debugConsoleOpen={false}
      onToggleDebugConsole={onToggleDebugConsole}
      onStartUsageGuide={onStartUsageGuide}
      onRedrawMap={onRedrawMap}
      {...props}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "メニュー" }));
  return { onToggleDebugConsole, onStartUsageGuide, onRedrawMap };
}

afterEach(() => localStorage.clear());

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

  it("「地図の表示を再描画」を押すと、描き直しの操作が上がってメニューが閉じる", async () => {
    const { onRedrawMap } = await openMenu();

    await userEvent.click(screen.getByRole("button", { name: "地図の表示を再描画" }));

    expect(onRedrawMap).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "地図の表示を再描画" })).not.toBeInTheDocument();
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

  it("「走りの記録」の窓で鍵を入れると記録が入り、送っていない走りの数を出し、鍵を外すと記録が切れる", async () => {
    await openMenu();
    await userEvent.click(screen.getByRole("button", { name: "走りの記録" }));
    const dialog = await screen.findByRole("dialog", { name: "走りの記録" });

    await userEvent.type(within(dialog).getByRole("textbox", { name: "書くための鍵" }), " ride-key ");
    await userEvent.click(within(dialog).getByRole("button", { name: "入れる" }));
    expect(rideTrackWriteKey()).toBe("ride-key");

    startRideTrack(Date.now());
    stopRideTrack(Date.now());
    await userEvent.click(screen.getByRole("button", { name: /閉じる/ }));
    await userEvent.click(screen.getByRole("button", { name: "メニュー" }));
    await userEvent.click(screen.getByRole("button", { name: "走りの記録" }));
    const reopened = await screen.findByRole("dialog", { name: "走りの記録" });
    expect(reopened).toHaveTextContent("送っていない走り: 1件");

    await userEvent.click(within(reopened).getByRole("button", { name: "鍵を外す" }));
    expect(rideTrackWriteKey()).toBeNull();
  });

  describe("バージョン表示", () => {
    async function openVersion(version: FrontendVersion) {
      onSameOrigin("GET", "/api/version", () => Response.json(version));
      await openMenu();
      await userEvent.click(screen.getByRole("button", { name: "バージョン表示" }));
      return screen.findByRole("dialog", { name: "バージョン" });
    }

    it("版の口が返したコミットの頭8文字を出す", async () => {
      const dialog = await openVersion({
        commit: "9c2521ce0123456789abcdef0123456789abcdef",
        started_at: "2026-10-08T22:00:00Z",
      });

      expect(await within(dialog).findByText(/コミット/)).toHaveTextContent(/^コミット 9c2521ce$/);
    });

    it("手元で動いている版は、版の代わりにそう出す", async () => {
      const dialog = await openVersion({ commit: null, started_at: "2026-10-08T22:00:00Z" });

      expect(
        await within(dialog).findByText("手元で動いているバージョンです[本番のバージョンではありません]。"),
      ).toBeInTheDocument();
    });
  });
});
