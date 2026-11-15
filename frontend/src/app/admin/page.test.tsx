/**
 * `app/admin/page.tsx`——管理画面の入口の状態: システム状況の開閉、
 * デバッグモード中の案内、走りの位置の記録の入り切り・書き出し・消去。
 *
 * 各タブのパネルは本物を描き、パネルが取りに行く backend への要求には応えないまま止めておく（中身の振る舞いは
 * それぞれのファイルが持つ）。どのタブにどのパネルを置くかは画面の宣言で、ここでは書き写さない。
 *
 * 差し替えたもの: ファイルを落とす関数（`lib/downloadFile.ts: downloadFile`）。走りの記録の溜め方は`lib/rideTrack.test.ts`が見る。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadFile } from "@/lib/downloadFile";
import {
  clearRideTracks,
  isRideTrackEnabled,
  recordRideTrackFix,
  setRideTrackEnabled,
  startRideTrack,
  stopRideTrack,
} from "@/lib/rideTrack";
import { heldReplies, onBackend, onSameOrigin } from "@/testing/backendServer";

import AdminPage from "./page";

vi.mock("@/lib/downloadFile", () => ({ downloadFile: vi.fn() }));

beforeEach(() => {
  onBackend("GET", "/health", heldReplies().reply);
  onBackend("GET", "/api/debug/stats", heldReplies().reply);
  onSameOrigin("GET", "/api/version", heldReplies().reply);
});

afterEach(() => {
  stopRideTrack();
  clearRideTracks();
});

async function openDeveloperTab() {
  const user = userEvent.setup();
  render(<AdminPage />);
  await user.click(screen.getByRole("tab", { name: "開発者" }));
  return user;
}

describe("AdminPage", () => {
  it("システム状況は閉じた状態で始まり、ボタンで開閉し、パネル側から閉じても戻る", async () => {
    const user = await openDeveloperTab();

    await user.click(screen.getByRole("button", { name: "システム状況を表示" }));
    expect(screen.getByRole("button", { name: "システム状況を閉じる" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "システム状況を隠す" }));
    expect(screen.queryByRole("button", { name: "システム状況を閉じる" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "システム状況を表示" }));
    await user.click(screen.getByRole("button", { name: "システム状況を閉じる" }));
    expect(screen.queryByRole("button", { name: "システム状況を閉じる" })).not.toBeInTheDocument();
  });

  it("デバッグモード中だけ、ログの表示はトップページで行うと案内する", async () => {
    const user = await openDeveloperTab();
    const debugMode = screen.getByRole("checkbox", { name: "デバッグログを表示" });

    await user.click(debugMode);
    expect(screen.getByText(/トップページ/)).toBeInTheDocument();

    await user.click(debugMode);
    expect(screen.queryByText(/トップページ/)).not.toBeInTheDocument();
  });

  it("走りの位置の記録の入り切りを切り替え、記録した走りを一覧に出し、JSON で書き出し、消すと一覧が空になる", async () => {
    setRideTrackEnabled(true);
    startRideTrack(Date.parse("2026-11-15T00:00:00Z"));
    recordRideTrackFix({
      latitude: 35.68,
      longitude: 139.76,
      accuracyM: 5,
      speedMs: 4,
      timestampMs: Date.parse("2026-11-15T00:00:01Z"),
    });
    stopRideTrack();
    setRideTrackEnabled(false);
    const user = await openDeveloperTab();

    await user.click(screen.getByRole("checkbox", { name: "走行中の位置を端末に記録する" }));
    expect(isRideTrackEnabled()).toBe(true);
    const panel = screen.getByRole("region", { name: "走りの位置の記録" });
    expect(panel).toHaveTextContent("11/15 09:00 から・1点");
    await user.click(screen.getByRole("button", { name: "書き出す" }));
    const [fileName, content] = vi.mocked(downloadFile).mock.calls[0];
    expect(fileName).toMatch(/\.json$/);
    expect(JSON.parse(content)).toEqual([
      expect.objectContaining({ points: [expect.objectContaining({ atMs: 1_000, latitude: 35.68 })] }),
    ]);

    await user.click(screen.getByRole("button", { name: "消す" }));
    expect(panel).toHaveTextContent("記録した走りはありません。");
    expect(screen.getByRole("button", { name: "書き出す" })).toBeDisabled();
  });
});
