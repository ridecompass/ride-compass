/**
 * `app/ride-log/page.tsx`——走行ログのページ。ログインした人に自分の走りの一覧（日付・距離・かかった時間）を出し、1件を押すと走った線を
 * 地図に出し、1件ずつ消せること。ログアウトと記録をやめる（同意をやめる）操作を持ち、ログインしていなければ Google でログインしてもらうこと。
 *
 * 差し替えたもの: backend の応答（網の層）、地図の描画（`maplibre-gl`）、Google のログインのスクリプト（`window.google`）。
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RideDetail, RideSummary } from "@/services/accountApi";
import { accountStatus } from "@/testing/accountStatus";
import { onBackend } from "@/testing/backendServer";
import { installGoogleSignIn } from "@/testing/googleSignIn";
import { mapOnScreen } from "@/testing/maplibre";

import RideLogPage from "./page";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

afterEach(() => {
  delete window.google;
});

const MORNING: RideSummary = {
  id: "ride-morning",
  started_at: "2026-11-20T23:30:00Z",
  distance_m: 42_350,
  duration_s: 6_120,
};
const EVENING: RideSummary = {
  id: "ride-evening",
  started_at: "2026-11-18T08:05:00Z",
  distance_m: 820,
  duration_s: 900,
};
// 休んだ所で分かれた2本の線。
const MORNING_TRACK = [
  [
    [139.7, 35.68],
    [139.72, 35.69],
  ],
  [
    [139.73, 35.7],
    [139.75, 35.66],
  ],
];

function serveRides(rides: RideSummary[]) {
  onBackend("GET", "/api/me/rides", () => Response.json(rides));
}

function renderPage() {
  const user = userEvent.setup();
  render(<RideLogPage />);
  return user;
}

const rideButtons = () =>
  within(screen.getByRole("list", { name: "走りの一覧" }))
    .getAllByRole("button")
    .map((button) => button.textContent);

describe("走行ログ", () => {
  it("自分の走りを新しい順に日付・距離・かかった時間で並べ、1件を押すと走った線を地図に出して線へ寄せ、確かめてから消すとその走りを一覧から除く", async () => {
    let rides = [MORNING, EVENING];
    onBackend("GET", "/api/me/rides", () => Response.json(rides));
    const detail: RideDetail = { ...MORNING, track: { type: "MultiLineString", coordinates: MORNING_TRACK } };
    onBackend("GET", "/api/me/rides/:id", () => Response.json(detail));
    const deleted = onBackend("DELETE", "/api/me/rides/:id", () => {
      rides = [EVENING];
      return new Response(null, { status: 204 });
    });
    const user = renderPage();

    await waitFor(() => expect(rideButtons()).toEqual(["2026/11/21 08:3042.4km102分", "2026/11/18 17:05820m15分"]));
    await user.click(screen.getByRole("button", { name: /2026\/11\/21/ }));
    await screen.findByRole("region", { name: "走った線の地図" });
    act(() => {
      mapOnScreen().loadStyle([]);
      mapOnScreen().emit("load");
    });
    expect(
      mapOnScreen()
        .sourceFeatures("ride-track")
        .map((feature) => feature.geometry),
    ).toEqual(MORNING_TRACK.map((coordinates) => ({ type: "LineString", coordinates })));
    expect(
      mapOnScreen()
        .fits()
        .map(({ bounds }) => bounds),
    ).toEqual([
      [
        [139.7, 35.66],
        [139.75, 35.7],
      ],
    ]);

    await user.click(screen.getByRole("button", { name: "この走りを消す" }));
    await user.click(screen.getByRole("button", { name: "やめる" }));
    expect(deleted).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "この走りを消す" }));
    await user.click(screen.getByRole("button", { name: "消す" }));

    await waitFor(() => expect(rideButtons()).toEqual(["2026/11/18 17:05820m15分"]));
    expect(deleted.map(({ path }) => path)).toEqual(["/api/me/rides/ride-morning"]);
    expect(screen.queryByRole("region", { name: "走った線の地図" })).not.toBeInTheDocument();
  });

  it("走りが無ければ、走行モードで案内を終えると残ることを伝える", async () => {
    serveRides([]);
    renderPage();

    expect(
      await screen.findByText("まだ走りがありません。走行モードで案内を終えると、ここに残ります。"),
    ).toBeInTheDocument();
  });

  it("「記録をやめる」で同意をやめ、走りの一覧は残したまま、記録をやめていることを出す", async () => {
    let status = accountStatus();
    onBackend("GET", "/api/me", () => Response.json(status));
    serveRides([MORNING]);
    const withdrawn = onBackend("DELETE", "/api/me/consent", () => {
      status = accountStatus({ consented: false });
      return new Response(null, { status: 204 });
    });
    const user = renderPage();

    await user.click(await screen.findByRole("button", { name: "記録をやめる" }));

    expect(
      await screen.findByText("記録をやめています。地図の画面を開くと、同意をもう一度聞きます。"),
    ).toBeInTheDocument();
    expect(withdrawn).toHaveLength(1);
    expect(rideButtons()).toHaveLength(1);
  });

  it("「ログアウト」でログアウトし、ログインのボタンに戻る。Google でログインし直すと、その人の走りを出す", async () => {
    let status = accountStatus();
    onBackend("GET", "/api/me", () => Response.json(status));
    serveRides([MORNING]);
    const loggedOut = onBackend("POST", "/api/me/logout", () => {
      status = accountStatus({ signed_in: false, consented: false });
      return new Response(null, { status: 204 });
    });
    const login = onBackend("POST", "/api/me/google-login", () => Response.json(accountStatus()));
    const signIn = installGoogleSignIn();
    const user = renderPage();

    await user.click(await screen.findByRole("button", { name: "ログアウト" }));
    await user.click(await screen.findByRole("button", { name: "Google のボタン" }));

    expect(loggedOut).toHaveLength(1);
    expect(signIn.clientId).toBe(accountStatus().google_client_id);
    await waitFor(() => expect(rideButtons()).toHaveLength(1));
    expect(login.map(({ body }) => body)).toEqual([{ credential: "id-token" }]);
  });
});
