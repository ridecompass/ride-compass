/**
 * `app/page.tsx`——トップページを開いたとき、Google でログインして今の規約の版に同意するまで、地図の画面の代わりに最初の画面（アプリの説明・
 * Google でログイン・規約へのリンク）を出し、断って使う選択肢を置かないこと。ログインのあと同意していなければ同意を聞き、同意すると地図の画面へ
 * 進み、同意する前に端末に置いたままの走りを送らずに消すこと。
 *
 * ここで見ないもの: 地図の画面の中身（ほかの`app/page.*.test.tsx`が、ログインして同意した人として開いて見る）。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）、Google のログインのスクリプト（`window.google`。
 * 外から読むスクリプトで、テスト環境に無い）。子の部品は本物を描く。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startRideTrack, stopRideTrack } from "@/lib/rideTrack";
import { pendingRideUploads } from "@/lib/rideTrackStore";
import { accountStatus } from "@/testing/accountStatus";
import { onBackend, onUrl } from "@/testing/backendServer";
import { installGoogleSignIn } from "@/testing/googleSignIn";
import { serveHome } from "@/testing/homePage";

import Home from "./page";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

beforeEach(() => {
  serveHome();
});

afterEach(() => {
  delete window.google;
  localStorage.clear();
  vi.restoreAllMocks();
});

const rideModeButton = () => screen.queryByRole("button", { name: "走行モード" });

function renderHome() {
  const user = userEvent.setup();
  render(<Home />);
  return user;
}

describe("最初の画面", () => {
  it("ログインしていなければ、地図の前にアプリの説明・Google でログイン・規約へのリンクを出し、ログインと同意を済ませると地図の画面へ進む。同意する前に端末に置いた走りは送らずに消す", async () => {
    let status = accountStatus({ signed_in: false, consented: false });
    onBackend("GET", "/api/me", () => Response.json(status));
    const login = onBackend("POST", "/api/me/google-login", () => {
      status = accountStatus({ consented: false, terms_version: 3 });
      return Response.json(status);
    });
    const consent = onBackend("PUT", "/api/me/consent", () => new Response(null, { status: 204 }));
    const sent = onUrl("*/api/rides", () => new Response(null, { status: 204 }));
    startRideTrack(Date.now());
    stopRideTrack(Date.now());
    const signIn = installGoogleSignIn();
    const user = renderHome();

    expect(screen.getByRole("heading", { level: 1, name: "RideCompass" })).toBeInTheDocument();
    expect(
      screen.getByText(/アプリを使うと、走行モードで走った走りを送り、あなたの走行ログに残します/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
    // 押せるのは Google のログインのボタンだけで、断って使う選択肢は無い。
    await waitFor(() =>
      expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Google のボタン"]),
    );
    expect(rideModeButton()).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Google のボタン" }));
    expect(signIn.clientId).toBe(accountStatus().google_client_id);

    expect(await screen.findByRole("heading", { name: "走りの記録への同意" })).toBeInTheDocument();
    expect(login.map(({ body }) => body)).toEqual([{ credential: "id-token" }]);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["同意してはじめる"]);
    expect(rideModeButton()).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "同意してはじめる" }));

    expect(await screen.findByRole("button", { name: "走行モード" })).toBeInTheDocument();
    expect(consent.map(({ body }) => body)).toEqual([{ terms_version: 3 }]);
    expect(pendingRideUploads()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("同意を見せている間に規約の版が上がっていたら（409）、今の版を読み直して同意を聞き直す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let status = accountStatus({ consented: false, terms_version: 1 });
    onBackend("GET", "/api/me", () => Response.json(status));
    const consent = onBackend("PUT", "/api/me/consent", ({ body }) => {
      if ((body as { terms_version: number }).terms_version === 2) return new Response(null, { status: 204 });
      status = accountStatus({ consented: false, terms_version: 2 });
      return Response.json({ detail: "規約の版が変わりました" }, { status: 409 });
    });
    const user = renderHome();

    await user.click(await screen.findByRole("button", { name: "同意してはじめる" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("規約の版が変わりました");
    await user.click(screen.getByRole("button", { name: "同意してはじめる" }));

    expect(await screen.findByRole("button", { name: "走行モード" })).toBeInTheDocument();
    expect(consent.map(({ body }) => body)).toEqual([{ terms_version: 1 }, { terms_version: 2 }]);
  });

  it("ログインの状態を読めなければ、その文と「もう一度読む」を出し、読めたら進む", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    onBackend("GET", "/api/me", () => (fail ? new Response(null, { status: 503 }) : Response.json(accountStatus())));
    const user = renderHome();

    expect(await screen.findByRole("alert")).toHaveTextContent("ログインの状態を読めませんでした");
    fail = false;
    await user.click(screen.getByRole("button", { name: "もう一度読む" }));

    expect(await screen.findByRole("button", { name: "走行モード" })).toBeInTheDocument();
  });
});
