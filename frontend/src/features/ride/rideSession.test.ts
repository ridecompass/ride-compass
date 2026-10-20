// @vitest-environment node
import { describe, expect, it } from "vitest";

import { makeRouteCandidate } from "@/testing/routeFixtures";

import { RIDE_SESSION_TTL_MS, readRideSession, writeRideSession } from "./rideSession";

const ROUTE = makeRouteCandidate({ id: "r1" });
const SAVED_AT = Date.UTC(2026, 9, 13, 6, 0);
const WRITTEN = JSON.parse(writeRideSession({ route: ROUTE, km: 3.5, resting: true }, SAVED_AT)) as Record<
  string,
  unknown
>;

describe("rideSession: 走行中のルートの一時保存の書き方と読み方", () => {
  it("書いたものを期限の内に読むと、同じルートと、前に当てたルートの上の距離と、休んでいたかが返る", () => {
    const raw = writeRideSession({ route: ROUTE, km: 3.5, resting: true }, SAVED_AT);
    expect(readRideSession(raw, SAVED_AT + RIDE_SESSION_TTL_MS)).toEqual({ route: ROUTE, km: 3.5, resting: true });
  });

  it.each([
    {
      case: "期限を過ぎた保存",
      raw: writeRideSession({ route: ROUTE, km: 3.5, resting: true }, SAVED_AT),
      now: SAVED_AT + RIDE_SESSION_TTL_MS + 1,
    },
    { case: "保存が無い", raw: null, now: SAVED_AT },
    { case: "消した保存（空）", raw: "", now: SAVED_AT },
    { case: "読めない保存", raw: "{", now: SAVED_AT },
    { case: "形の違う保存", raw: JSON.stringify({ ...WRITTEN, savedAt: "朝" }), now: SAVED_AT },
    // 距離の欄は、まだ当てていなければnullで書く。欄の無い保存（距離を足す前の版）も形が違う側に入る。
    { case: "距離の欄の無い保存", raw: JSON.stringify({ ...WRITTEN, km: undefined }), now: SAVED_AT },
    { case: "休んでいたかの欄の無い保存", raw: JSON.stringify({ ...WRITTEN, resting: undefined }), now: SAVED_AT },
    // 型の印は、ルート候補の型が今の版と違う版で書いた保存を見分ける。印の無い保存も同じ側に入る。
    { case: "ルート候補の型が違う版で書いた保存", raw: JSON.stringify({ ...WRITTEN, shape: "前の版" }), now: SAVED_AT },
  ])("$case は使わない", ({ raw, now }) => {
    expect(readRideSession(raw, now)).toBeNull();
  });
});
