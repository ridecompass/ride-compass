/**
 * `app/error.tsx`——画面のエラーの境目。端末の保存値を消して再試行するとき、走りの記録（送るまでほかに写しが無い）は残す。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { startRideTrack, stopRideTrack } from "@/lib/rideTrack";
import { pendingRideUploads } from "@/lib/rideTrackStore";

import ErrorBoundary from "./error";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("「端末に保存した値を消して再試行」は、走りの記録を残して、ほかの保存値を消してから再試行する", async () => {
  startRideTrack(0);
  stopRideTrack(1_000);
  localStorage.setItem("ridecompass:place-history", "[]");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const retry = vi.fn();
  render(<ErrorBoundary error={new Error("壊れた")} retry={retry} />);

  await userEvent.click(screen.getByRole("button", { name: "端末に保存した値を消して再試行" }));

  expect(localStorage.getItem("ridecompass:place-history")).toBeNull();
  expect(pendingRideUploads().length).toBe(1);
  expect(retry).toHaveBeenCalled();
});
