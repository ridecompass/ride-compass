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

/** 同意をやめる（`DELETE /api/me/consent`）。以後の走りは受けられず、それまでの走りは残る。 */
export async function withdrawConsent(): Promise<void> {
  await requestApi((init) => backendApi.DELETE("/api/me/consent", { ...init, ...WITH_SESSION }), {
    category: "api:account",
    messages: { failure: "記録をやめられませんでした", parseFailure: "記録をやめられませんでした" },
  });
}

/** ログアウトする（`POST /api/me/logout`）。札の cookie は応答が消す。 */
export async function signOut(): Promise<void> {
  await requestApi((init) => backendApi.POST("/api/me/logout", { ...init, ...WITH_SESSION }), {
    category: "api:account",
    messages: { failure: "ログアウトできませんでした", parseFailure: "ログアウトできませんでした" },
  });
}

/** 走行ログの1件の要約（始めた時刻・距離・かかった時間）。 */
export type RideSummary = components["schemas"]["RideSummary"];
/** 走行ログの1件と、走った線（休むごとに分けた線。点は[経度, 緯度]）。 */
export type RideDetail = components["schemas"]["RideDetail"];

/** 自分の走りの一覧を、新しい順に読む（`GET /api/me/rides`）。 */
export function listMyRides(): Promise<RideSummary[]> {
  return requestApi((init) => backendApi.GET("/api/me/rides", { ...init, ...WITH_SESSION }), {
    category: "api:account",
    messages: { failure: "走行ログを読めませんでした", parseFailure: "走行ログを読めませんでした" },
  });
}

/** 自分の走りの1件を読む（`GET /api/me/rides/{ride_id}`）。 */
export function getMyRide(rideId: string): Promise<RideDetail> {
  return requestApi(
    (init) =>
      backendApi.GET("/api/me/rides/{ride_id}", { ...init, ...WITH_SESSION, params: { path: { ride_id: rideId } } }),
    {
      category: "api:account",
      messages: { failure: "走りを読めませんでした", parseFailure: "走りを読めませんでした" },
    },
  );
}

/** 自分の走りの1件を消す（`DELETE /api/me/rides/{ride_id}`）。 */
export async function deleteMyRide(rideId: string): Promise<void> {
  await requestApi(
    (init) =>
      backendApi.DELETE("/api/me/rides/{ride_id}", {
        ...init,
        ...WITH_SESSION,
        params: { path: { ride_id: rideId } },
      }),
    {
      category: "api:account",
      messages: { failure: "走りを消せませんでした", parseFailure: "走りを消せませんでした" },
    },
  );
}
