/**
 * `app/page.tsx`——トップページの走行モードのうち、走りの記録。走行モードの間の位置・候補と生成の条件・見せた予報・休むが1つの走りとして
 * 溜まり、案内を終えると送られ、送れなければ端末に残して次に一緒に送ること。
 *
 * ここで見ないもの: 読み込み直したときに走りの記録が同じ走りを続けること——記録中の走りはモジュールが持ち、テストの中で描き直してもモジュールは
 * 読み直されないので、ここでは作れない。続け方は`lib/rideTrack.test.ts`がモジュールを読み直して見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stopRideTrack } from "@/lib/rideTrack";
import { pendingRideUploads, type RideUploadBody } from "@/lib/rideTrackStore";
import { gunzippedJson, inTurn, onSameOrigin, onUrl } from "@/testing/backendServer";
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
  });
});
