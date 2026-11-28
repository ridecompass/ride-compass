// @vitest-environment node
/**
 * `app/admin/api/[...path]/route.ts`——管理画面が送った値が、資格情報つきでbackendの管理APIへそのまま届き、
 * backendが返した値がそのまま画面へ返ること。
 */

import { describe, expect, it, vi } from "vitest";

import { BACKEND_INTERNAL_URL } from "@/lib/backendInternalUrl";
import { onUrl } from "@/testing/backendServer";

import { PUT } from "./route";

vi.mock("@/lib/adminBasicAuth", () => ({
  adminBasicAuthCredentials: () => ({ username: "admin", password: "s3cret" }),
}));

describe("管理APIの口", () => {
  it("送られた本文を、資格情報つきで同じパスの管理APIへ渡し、backendの応答を返す", async () => {
    const forwarded = onUrl(`${BACKEND_INTERNAL_URL}/*`, () => Response.json({ value: 1 }));

    const response = await PUT(
      new Request("http://frontend.test/admin/api/tuning/g.alpha", { method: "PUT", body: '{"value":1}' }),
    );

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].url).toBe(`${BACKEND_INTERNAL_URL}/api/admin/tuning/g.alpha`);
    expect(forwarded[0].headers.get("Authorization")).toBe(`Basic ${Buffer.from("admin:s3cret").toString("base64")}`);
    expect(await forwarded[0].text()).toBe('{"value":1}');
    await expect(response.json()).resolves.toEqual({ value: 1 });
  });
});
