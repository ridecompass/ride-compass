// @vitest-environment node
import { describe, expect, it } from "vitest";

import { makeRouteCandidate } from "@/testing/routeFixtures";

import { RIDE_SESSION_TTL_MS, readRideSession, writeRideSession } from "./rideSession";

const ROUTE = makeRouteCandidate({ id: "r1" });
const SAVED_AT = Date.UTC(2026, 9, 13, 6, 0);

describe("rideSession: 走行中のルートの一時保存の書き方と読み方", () => {
  it("書いたものを期限の内に読むと、同じルート・走行モードの入切・候補を作ったときの想定速度が返る", () => {
    const session = { route: ROUTE, riding: true, assumedSpeedKmh: 22 };
    const raw = writeRideSession(session, SAVED_AT);
    expect(readRideSession(raw, SAVED_AT + RIDE_SESSION_TTL_MS)).toEqual(session);
  });

  it("想定速度の無い保存（想定速度を足す前に書いたもの）は、想定速度をnullとして読む", () => {
    const raw = JSON.stringify({ route: ROUTE, riding: true, savedAt: SAVED_AT });
    expect(readRideSession(raw, SAVED_AT)).toEqual({ route: ROUTE, riding: true, assumedSpeedKmh: null });
  });

  it.each([
    {
      case: "期限を過ぎた保存",
      raw: writeRideSession({ route: ROUTE, riding: true, assumedSpeedKmh: 22 }, SAVED_AT),
      now: SAVED_AT + RIDE_SESSION_TTL_MS + 1,
    },
    { case: "保存が無い", raw: null, now: SAVED_AT },
    { case: "消した保存（空）", raw: "", now: SAVED_AT },
    { case: "読めない保存", raw: "{", now: SAVED_AT },
    {
      case: "形の違う保存",
      raw: JSON.stringify({ route: { id: 1 }, riding: "yes", savedAt: SAVED_AT }),
      now: SAVED_AT,
    },
  ])("$case は使わない", ({ raw, now }) => {
    expect(readRideSession(raw, now)).toBeNull();
  });
});
