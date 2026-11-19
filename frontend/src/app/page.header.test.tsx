/**
 * `app/page.tsx`——トップページのヘッダーとメニュー。
 *
 * 見ること: ヘッダーの「未取得」に並ぶ出所と「現在地に移動」の失敗、観測値の失敗の印を取り直しの間も保つこと、「現在地に移動」が
 * 出発地を変えずに地図を寄せて現在地に点を出すこと、メニューから入る使い方の説明とデバッグログ、閉じた初回の案内をメニューから出し直すこと。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDebugEnabled } from "@/lib/debugLog";
import { SECOND_MS } from "@/lib/duration";
import refreshIntervals from "@/types/generated/refresh-intervals.json";
import { heldReplies, onBackend, onSameOrigin } from "@/testing/backendServer";
import { installGeolocation } from "@/testing/geolocation";
import { ELSEWHERE, HERE, clickMap, marksAt, renderHome, serveHome } from "@/testing/homePage";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

beforeEach(() => {
  serveHome();
});

afterEach(() => {
  setDebugEnabled(false);
});

describe("ヘッダーとメニュー", () => {
  it("ヘッダーの「未取得」に、現在地・画面の設定・警報の取れないものが並ぶ。「現在地に移動」が取れなければ地図の上に理由を出す", async () => {
    installGeolocation(null);
    onBackend("GET", "/api/client-config", () => Response.json({ detail: "失敗" }, { status: 502 }));
    onBackend("GET", "/api/weather/warnings", () => Response.json({ detail: "失敗" }, { status: 502 }));
    const { user } = renderHome();
    const missing = () => screen.getByRole("button", { name: /を取得できていません。押すと/ });
    await waitFor(() => expect(missing()).toHaveAccessibleName(/現在地.*画面の設定|画面の設定.*現在地/));
    expect(missing()).not.toHaveAccessibleName(/警報/);

    await user.click(screen.getByRole("button", { name: "現在地に移動" }));
    expect(screen.getByText(/現在地を取得できませんでした/)).toBeInTheDocument();

    clickMap(HERE);
    await waitFor(() => expect(missing()).toHaveAccessibleName(/警報/));
    expect(missing()).not.toHaveAccessibleName(/現在地/);
  });

  it("ヘッダーの観測値の失敗の印は、間隔ごとに取り直している間も出したままにする", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      onBackend("GET", "/api/weather/amedas", () => Response.json({ detail: "失敗" }, { status: 502 }));
      renderHome();
      const mark = () => screen.queryByRole("img", { name: "観測値を取得できません" });
      await waitFor(() => expect(mark()).not.toBeNull());

      const held = heldReplies();
      onBackend("GET", "/api/weather/amedas", held.reply);
      act(() => vi.advanceTimersByTime(refreshIntervals.amedas_seconds * SECOND_MS));
      await waitFor(() => expect(held.arrived()).toBe(1));
      expect(mark()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("「現在地に移動」は現在地を取り直して地図を寄せ、出発地は変えずに現在地に点を出す", async () => {
    const { user } = renderHome();
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "現在地に移動" }));

    expect(marksAt(ELSEWHERE)).toHaveLength(1);
    expect(screen.getByRole("img", { name: "現在地" })).toBeInTheDocument();
    expect(marksAt(HERE).map(({ element }) => element.getAttribute("aria-label"))).toEqual(["現在地"]);
  });

  it("メニューから使い方の説明に入って「やめる」で抜け、デバッグログをメニューから開いてログの側から閉じられる", async () => {
    const { user } = renderHome();
    // 地図を開いたあとに入れる（代役の地図は基礎地図の道路を持たず、地図がそのことをデバッグログへ警告する）。
    act(() => setDebugEnabled(true));
    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "使い方を見る" }));
    expect(screen.getByText("説明モード")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "やめる" }));
    expect(screen.queryByText("説明モード")).toBeNull();

    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "デバッグログを表示" }));
    expect(screen.getByText(/^デバッグログ\[/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^デバッグログ\[.*を閉じる$/ }));
    expect(screen.queryByText(/^デバッグログ\[/)).toBeNull();
  });

  it("閉じた初回の案内は、メニューの「初回の案内をもう一度見る」で地図の上にまた出る", async () => {
    onSameOrigin("GET", "/api/version", () => Response.json({ commit: null, started_at: "2026-10-08T22:00:00Z" }));
    const { user } = renderHome();
    const intro = () => screen.queryByRole("region", { name: "RideCompass" });
    await user.click(screen.getByRole("button", { name: "はじめる" }));
    expect(intro()).toBeNull();

    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "初回の案内をもう一度見る" }));

    expect(intro()).toBeInTheDocument();
  });
});
