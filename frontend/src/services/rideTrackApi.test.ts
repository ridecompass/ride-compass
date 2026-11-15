/**
 * `services/rideTrackApi.ts`——走り終えて送っていない走りを送る。書けた走りだけを消し、断られても後ろを送ることと、送りの最中に終えた走りも送ること。
 *
 * ここで見ないもの: 案内を終えたときに送ること（`app/page.rideControl.test.tsx`）、溜め方（`lib/rideTrack.test.ts`）。
 */
import { afterEach, expect, it, vi } from "vitest";

import { pendingRideUploads, setRideTrackWriteKey, startRideTrack, stopRideTrack } from "@/lib/rideTrack";
import { gunzippedJson, heldReplies, onUrl } from "@/testing/backendServer";

import { sendRideTracks } from "./rideTrackApi";

const HOUR_MS = 3_600_000;

function endRide(atMs: number): void {
  startRideTrack(atMs);
  stopRideTrack(atMs + 1_000);
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("書けた走りだけを端末から消し、断られた走りは（理由によらず）残したまま、後ろの走りを続けて送る", async () => {
  setRideTrackWriteKey("key");
  for (const ride of [0, 1, 2]) endRide(ride * HOUR_MS);
  const [malformed, written, refused] = pendingRideUploads().map(({ id }) => id);
  const statusOf = { [malformed]: 422, [written]: 204, [refused]: 401 };
  onUrl(
    "*/api/rides",
    async (request) => new Response(null, { status: statusOf[((await gunzippedJson(request)) as { id: string }).id] }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});

  await sendRideTracks();

  expect(pendingRideUploads().map(({ id }) => id)).toEqual([malformed, refused]);
});

it("送りの最中に走り終えた走りも、今の送りが済んでから送る", async () => {
  setRideTrackWriteKey("key");
  endRide(0);
  const held = heldReplies();
  onUrl("*/api/rides", held.reply);

  const first = sendRideTracks();
  await vi.waitFor(() => expect(held.arrived()).toBe(1));
  endRide(HOUR_MS);
  const second = sendRideTracks();
  await held.answer(0, new Response(null, { status: 204 }));
  await held.answer(1, new Response(null, { status: 204 }));
  await Promise.all([first, second]);

  expect(pendingRideUploads()).toEqual([]);
});
