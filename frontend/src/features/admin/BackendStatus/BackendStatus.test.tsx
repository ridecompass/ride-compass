/**
 * `BackendStatus.tsx`——backendの疎通の答えが画面に出ること。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { onBackend } from "@/testing/backendServer";

import BackendStatus from "./BackendStatus";

describe("BackendStatus", () => {
  it("疎通の答えが来たら、OKと出す", async () => {
    onBackend("GET", "/health", () => Response.json({ status: "ok" }));
    render(<BackendStatus />);
    expect(await screen.findByText("サーバー接続: OK")).toBeInTheDocument();
  });
});
