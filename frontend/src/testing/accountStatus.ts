// 自分の状態（`GET /api/me`）の組み立て。単体テストの足場（`testing/backendServer.ts`）と e2e・撮影の足場（`e2e/fixtures.ts`）が使う。
import type { AccountStatus } from "@/services/accountApi";

/** 自分の状態。既定はログインして今の版に同意した人。 */
export function accountStatus(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return { signed_in: true, consented: true, terms_version: 1, google_client_id: "test-client-id", ...overrides };
}
