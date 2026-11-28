"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { getQueryClient } from "@/lib/queryClient";
import { getAccountStatus, signInWithGoogle, type AccountStatus } from "@/services/accountApi";

/** 自分の状態の取得の鍵。ログイン・同意・同意をやめる・ログアウトのあとに書き換える・読み直す所が同じ鍵を使う。 */
export const ACCOUNT_KEY = ["account"] as const;

/** 自分の状態（`GET /api/me`）。地図の画面の前の最初の画面と走行ログが、同じ取得を分かち合う。 */
export function useAccountStatus() {
  return useQuery({ queryKey: ACCOUNT_KEY, queryFn: getAccountStatus }, getQueryClient());
}

/** Google が渡した ID トークンでログインし、応答の自分の状態で取得を書き換える。 */
export function useGoogleSignIn() {
  const client = getQueryClient();
  return useMutation(
    {
      mutationFn: signInWithGoogle,
      onSuccess: (status: AccountStatus) => client.setQueryData(ACCOUNT_KEY, status),
    },
    client,
  );
}
