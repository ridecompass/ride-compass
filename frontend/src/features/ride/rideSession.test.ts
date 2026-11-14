import { afterEach, describe, expect, it } from "vitest";

import { makeRouteCandidate } from "@/testing/routeFixtures";

import { RIDE_SESSION_TTL_MS, readRideSession, saveRideProgress, saveRideRoute } from "./rideSession";

const SAVED_AT = Date.UTC(2026, 9, 13, 6, 0);
const SESSION = { route: makeRouteCandidate({ id: "r1" }), km: 3.5, resting: true };

afterEach(() => {
  window.localStorage.clear();
});

describe("rideSession: 走行中のルートの一時保存", () => {
  it("期限の内に読むと保存したルートと距離と休んでいたかが返り、期限を過ぎると使わない", () => {
    saveRideRoute(SESSION.route);
    saveRideProgress(SESSION, SAVED_AT);

    expect(readRideSession(SAVED_AT + RIDE_SESSION_TTL_MS)).toEqual(SESSION);
    expect(readRideSession(SAVED_AT + RIDE_SESSION_TTL_MS + 1)).toBeNull();
  });
});
