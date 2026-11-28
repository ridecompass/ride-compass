/**
 * `BackendStatus.tsx`——backendの疎通の答えが画面に出ること。
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { onBackend } from "@/testing/backendServer";

import BackendStatus from "./BackendStatus";

describe("BackendStatus", () => {
  it("疎通の答えが来たら、疎通できた状態を出す", async () => {
    onBackend("GET", "/health", () => Response.json({ status: "ok" }));
    render(<BackendStatus />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveAttribute("data-state", "ok"));
  });
});
