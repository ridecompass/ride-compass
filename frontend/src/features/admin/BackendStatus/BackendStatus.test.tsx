/**
 * `BackendStatus.tsx`——backendの疎通を、確認中・OK・失敗の文言の3つで出すこと。
 *
 * ここで見ないもの:
 * - 疎通の失敗の文言 → `app/admin/adminApi.test.ts`
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { onBackend } from "@/testing/backendServer";

import BackendStatus from "./BackendStatus";

describe("BackendStatus", () => {
  it.each([
    ["サーバー接続: OK", () => Response.json({ status: "ok" })],
    [/バックエンドへの疎通確認に失敗しました/, () => new Response(null, { status: 503 })],
  ])("疎通の答えが来たら「%s」と出す", async (shown, reply) => {
    onBackend("GET", "/health", reply);
    render(<BackendStatus />);
    expect(await screen.findByText(shown)).toBeInTheDocument();
  });
});
