/**
 * `app/page.tsx`——トップページの走行モードのうち、走りの記録。走行モードの間の位置・候補と生成の条件・見せた予報・休むが1つの走りとして
 * 溜まり、案内を終えると、ログインして同意した人のものだけが送られ（それ以外の人には残すかを聞き、ログインと同意を経て送る）、送れなければ
 * 端末に残して次に一緒に送ること。
 *
 * ここで見ないもの: 読み込み直したときに走りの記録が同じ走りを続けること——記録中の走りはモジュールが持ち、テストの中で描き直してもモジュールは
 * 読み直されないので、ここでは作れない。続け方は`lib/rideTrack.test.ts`がモジュールを読み直して見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）、Google のログインのスクリプト（`window.google`。
 * 外から読むスクリプトで、テスト環境に無い）。子の部品は本物を描く。
 */
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stopRideTrack } from "@/lib/rideTrack";
import { pendingRideUploads, type RideUploadBody } from "@/lib/rideTrackStore";
import { accountStatus, gunzippedJson, inTurn, onBackend, onSameOrigin, onUrl } from "@/testing/backendServer";
import { installGeolocation } from "@/testing/geolocation";
import {
  HERE,
  LOOP_CONDITIONS,
  RIDDEN,
  RIDDEN_MIDDLE,
  candidateTabs,
  generate,
  renderHome,
  serveHome,
} from "@/testing/homePage";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

afterEach(() => {
  delete window.google;
  stopRideTrack(Date.now());
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("走りの記録", () => {
  it("走行モードの間の位置・候補と生成の条件・見せた予報・休むを1つの走りとして溜め、案内を終えるとその走りを送る。送れなければ端末に残して次に案内を終えたときに一緒に送り、送れたら端末から消す", async () => {
    onSameOrigin("GET", "/api/version", () => Response.json({ commit: "abc1234", started_at: "2026-11-16T00:00:00Z" }));
    const sent = onUrl(
      "*/api/rides",
      inTurn(
        new Response(null, { status: 503 }),
        new Response(null, { status: 204 }),
        new Response(null, { status: 204 }),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const geolocation = installGeolocation(HERE);
    const first = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(first.user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const rideButton = () => screen.getByRole("button", { name: "走行モード" });

    await first.user.click(rideButton());
    geolocation.deliver({ ...RIDDEN_MIDDLE, altitude: 12.4, speed: 4, heading: 90, timestamp: Date.now() + 1_000 });
    const { user } = first;
    await user.click(rideButton());
    await user.click(screen.getByRole("button", { name: "休む" }));
    await user.click(screen.getByRole("button", { name: "続きから走る" }));
    await user.click(rideButton());
    await user.click(screen.getByRole("button", { name: "案内を終える" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const ride = (await gunzippedJson(sent[0])) as RideUploadBody;
    expect(ride.points.map(([, lat, lon, ele, , speed, course]) => [lat, lon, ele, speed, course])).toEqual([
      [Math.round(RIDDEN_MIDDLE.latitude * 1e6), Math.round(RIDDEN_MIDDLE.longitude * 1e6), 124, 400, 90],
    ]);
    expect(ride.events.map(([, kind]) => kind)).toEqual(
      expect.arrayContaining(["start", "route", "rest", "resume", "end"]),
    );
    expect(Object.values(ride.routes)).toEqual([RIDDEN]);
    expect(Object.keys(ride.conditions)).toEqual(Object.keys(ride.routes));
    expect((ride.forecasts as { kind: string }[]).map(({ kind }) => kind)).toContain("gridPointToday");
    expect(ride.app_version).toBe("abc1234");
    expect(pendingRideUploads().length).toBe(1);

    await user.click(rideButton());
    await user.click(rideButton());
    await user.click(screen.getByRole("button", { name: "案内を終える" }));
    await waitFor(() => expect(pendingRideUploads().length).toBe(0));
    expect(await gunzippedJson(sent[1])).toEqual(ride);
    expect(await screen.findByRole("heading", { name: "走行ログに残しました" })).toBeInTheDocument();
  });

  it("ログインしていなければ、案内を終えても送らずに残すかを聞き、「残さない」ならその走りを端末から消す", async () => {
    onBackend("GET", "/api/me", () => Response.json(accountStatus({ signed_in: false, consented: false })));
    const sent = onUrl("*/api/rides", () => new Response(null, { status: 204 }));
    const { user } = await rideOnce();

    expect(await screen.findByRole("heading", { name: "この走りを残しますか" })).toBeInTheDocument();
    expect(pendingRideUploads().length).toBe(1);
    await user.click(screen.getByRole("button", { name: "残さない" }));

    expect(screen.queryByRole("heading", { name: "この走りを残しますか" })).not.toBeInTheDocument();
    expect(pendingRideUploads().length).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("「この走りを残す」から Google でログインし、今の規約の版に同意すると、その走りを送る", async () => {
    onBackend("GET", "/api/me", () => Response.json(accountStatus({ signed_in: false, consented: false })));
    const login = onBackend("POST", "/api/me/google-login", () =>
      Response.json(accountStatus({ consented: false, terms_version: 3 })),
    );
    const consent = onBackend("PUT", "/api/me/consent", () => new Response(null, { status: 204 }));
    const sent = onUrl("*/api/rides", () => new Response(null, { status: 204 }));
    const signIn = installGoogleSignIn();
    const { user } = await rideOnce();

    await user.click(await screen.findByRole("button", { name: "この走りを残す" }));
    await user.click(await screen.findByRole("button", { name: "Google のボタン" }));
    expect(signIn.clientId).toBe(accountStatus().google_client_id);
    await waitFor(() => expect(login.map(({ body }) => body)).toEqual([{ credential: "id-token" }]));
    expect(sent).toHaveLength(0);
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
    await user.click(screen.getByRole("button", { name: "同意して残す" }));

    expect(await screen.findByRole("heading", { name: "走行ログに残しました" })).toBeInTheDocument();
    expect(consent.map(({ body }) => body)).toEqual([{ terms_version: 3 }]);
    expect(sent).toHaveLength(1);
    expect(pendingRideUploads().length).toBe(0);
  });
});

/** 候補を1つ作り、走行モードで1つ位置を受けて案内を終える。 */
async function rideOnce() {
  const geolocation = installGeolocation(HERE);
  const rendered = renderHome();
  jobs.respond([RIDDEN], LOOP_CONDITIONS);
  await generate(rendered.user);
  await waitFor(() => expect(candidateTabs()).toHaveLength(1));
  await rendered.user.click(screen.getByRole("button", { name: "走行モード" }));
  geolocation.deliver({ ...RIDDEN_MIDDLE, timestamp: Date.now() + 1_000 });
  await rendered.user.click(screen.getByRole("button", { name: "走行モード" }));
  await rendered.user.click(screen.getByRole("button", { name: "案内を終える" }));
  return rendered;
}

/** Google のログインの口を置く。描いたボタンを押すと、初めに渡された受け口へ ID トークンを渡す。 */
function installGoogleSignIn() {
  const seen: { clientId: string | null } = { clientId: null };
  let callback: ((response: { credential: string }) => void) | null = null;
  window.google = {
    accounts: {
      id: {
        initialize(config) {
          seen.clientId = config.client_id;
          callback = config.callback;
        },
        renderButton(parent) {
          const button = document.createElement("button");
          button.textContent = "Google のボタン";
          button.onclick = () => callback?.({ credential: "id-token" });
          parent.append(button);
        },
      },
    },
  };
  return seen;
}
