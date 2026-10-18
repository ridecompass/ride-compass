"use client";

// 種類・はい/いいえの材料の値ごとの道の延長の割合の取得（軸スタジオの較正の画面）。

import { useQuery } from "@tanstack/react-query";

import { fetchMaterialValueShares, type MaterialValueShares } from "@/features/admin/adminApi";
import { getQueryClient } from "@/lib/queryClient";

interface MaterialValueSharesResult {
  shares: MaterialValueShares | null;
  failed: boolean;
}

/** 道の標本は画面を開いている間に変わらないので、同じ材料を取りに行くのは1回。届く前と失敗は`shares`がnullで、失敗は`failed`で分ける。 */
export function useMaterialValueShares(materialId: string): MaterialValueSharesResult {
  const { data, isError } = useQuery(
    {
      queryKey: ["material-value-shares", materialId],
      queryFn: () => fetchMaterialValueShares(materialId),
      staleTime: Infinity,
    },
    getQueryClient(),
  );
  return { shares: data ?? null, failed: isError };
}
