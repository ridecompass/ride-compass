import { backendApi, requestApi } from "@/lib/apiClient";
import type { components } from "@/types/generated/api";

/** 自分の状態（ログインしているか・今の規約の版に同意しているか・ログインのボタンに使うクライアント ID）。 */
export type AccountStatus = components["schemas"]["AccountStatus"];

// ログインの札は backend の名前に付く cookie で、fetch は別のオリジンへの要求に頼まないと cookie を付けないので、自分の口と
// 走りを受ける口への要求で頼む。
export const WITH_SESSION = { credentials: "include" } as const satisfies RequestInit;

/** 自分の状態を読む（`GET /api/me`）。 */
export function getAccountStatus(): Promise<AccountStatus> {
  return requestApi((init) => backendApi.GET("/api/me", { ...init, ...WITH_SESSION }), {
    category: "api:account",
    messages: { failure: "ログインの状態を読めませんでした", parseFailure: "ログインの状態を読めませんでした" },
  });
}

/** Google が渡した ID トークンでログインする（`POST /api/me/google-login`）。札は応答の cookie で届く。 */
export function signInWithGoogle(credential: string): Promise<AccountStatus> {
  return requestApi(
    (init) => backendApi.POST("/api/me/google-login", { ...init, ...WITH_SESSION, body: { credential } }),
    {
      category: "api:account",
      messages: { failure: "ログインできませんでした", parseFailure: "ログインできませんでした" },
    },
  );
}

/** 見せた規約の版に同意する（`PUT /api/me/consent`）。 */
export async function consentToTerms(termsVersion: number): Promise<void> {
  await requestApi(
    (init) => backendApi.PUT("/api/me/consent", { ...init, ...WITH_SESSION, body: { terms_version: termsVersion } }),
    {
      category: "api:account",
      messages: { failure: "同意を残せませんでした", parseFailure: "同意を残せませんでした" },
    },
  );
}
