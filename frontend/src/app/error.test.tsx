/**
 * `app/error.tsx`——画面のエラーの境目。端末の保存値を消して再試行するとき、走りの位置の記録（ほかに写しが無い）は残す。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import {
  clearRideTracks,
  isRideTrackEnabled,
  readRideTracks,
  recordRideTrackFix,
  setRideTrackEnabled,
  startRideTrack,
  stopRideTrack,
} from "@/lib/rideTrack";

import ErrorBoundary from "./error";

afterEach(() => {
  stopRideTrack();
  clearRideTracks();
  vi.restoreAllMocks();
});

it("「端末に保存した値を消して再試行」は、走りの位置の記録と記録を入れた印を残して、ほかの保存値を消してから再試行する", async () => {
  setRideTrackEnabled(true);
  startRideTrack(0);
  recordRideTrackFix({ latitude: 35.68, longitude: 139.76, accuracyM: 5, speedMs: 4, timestampMs: 1_000 });
  stopRideTrack();
  localStorage.setItem("ridecompass:place-history", "[]");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const retry = vi.fn();
  render(<ErrorBoundary error={new Error("壊れた")} retry={retry} />);

  await userEvent.click(screen.getByRole("button", { name: "端末に保存した値を消して再試行" }));

  expect(localStorage.getItem("ridecompass:place-history")).toBeNull();
  expect(readRideTracks().map((track) => track.points.length)).toEqual([1]);
  expect(isRideTrackEnabled()).toBe(true);
  expect(retry).toHaveBeenCalled();
});
