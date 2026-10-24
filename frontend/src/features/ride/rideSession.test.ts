// @vitest-environment node
import { describe, expect, it } from "vitest";

import { makeRouteCandidate } from "@/testing/routeFixtures";

import { RIDE_SESSION_TTL_MS, readRideSession, writeRideProgress, writeRideRoute } from "./rideSession";

const ROUTE = makeRouteCandidate({ id: "r1" });
const SAVED_AT = Date.UTC(2026, 9, 13, 6, 0);
const SESSION = { route: ROUTE, km: 3.5, resting: true };
const ROUTE_RAW = writeRideRoute(ROUTE);
const PROGRESS_RAW = writeRideProgress(SESSION, SAVED_AT);
const WRITTEN_ROUTE = JSON.parse(ROUTE_RAW) as Record<string, unknown>;
const WRITTEN_PROGRESS = JSON.parse(PROGRESS_RAW) as Record<string, unknown>;

describe("rideSession: 走行中のルートの一時保存の書き方と読み方", () => {
  it("書いたものを期限の内に読むと、同じルートと、前に当てたルートの上の距離と、休んでいたかが返る", () => {
    expect(readRideSession(ROUTE_RAW, PROGRESS_RAW, SAVED_AT + RIDE_SESSION_TTL_MS)).toEqual(SESSION);
  });

  it.each([
    { case: "期限を過ぎた保存", progress: PROGRESS_RAW, now: SAVED_AT + RIDE_SESSION_TTL_MS + 1 },
    { case: "ルートの保存が無い", route: null, now: SAVED_AT },
    { case: "距離の保存が無い", progress: null, now: SAVED_AT },
    { case: "読めない保存", route: "{", now: SAVED_AT },
    { case: "形の違う保存", progress: JSON.stringify({ ...WRITTEN_PROGRESS, savedAt: "朝" }), now: SAVED_AT },
    // 距離の欄は、まだ当てていなければnullで書く。欄の無い保存も形が違う側に入る。
    { case: "距離の欄の無い保存", progress: JSON.stringify({ ...WRITTEN_PROGRESS, km: undefined }), now: SAVED_AT },
    {
      case: "休んでいたかの欄の無い保存",
      progress: JSON.stringify({ ...WRITTEN_PROGRESS, resting: undefined }),
      now: SAVED_AT,
    },
    // ルートを書けずに前のルートが残ると、距離は別のルートのものになる。
    { case: "距離が別のルートの保存", route: writeRideRoute(makeRouteCandidate({ id: "r2" })), now: SAVED_AT },
    // 型の印は、ルート候補の型が今の版と違う版で書いた保存を見分ける。ルートと距離を1つに書いていた版の保存も、距離の保存が無い側に入る。
    {
      case: "ルート候補の型が違う版で書いた保存",
      route: JSON.stringify({ ...WRITTEN_ROUTE, shape: "前の版" }),
      now: SAVED_AT,
    },
  ])("$case は使わない", ({ route = ROUTE_RAW, progress = PROGRESS_RAW, now }) => {
    expect(readRideSession(route, progress, now)).toBeNull();
  });
});
