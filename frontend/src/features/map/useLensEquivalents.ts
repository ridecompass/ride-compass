"use client";

import { useQuery } from "@tanstack/react-query";
import { lensPreferenceQuery } from "@/lib/costPreference";
import { getQueryClient } from "@/lib/queryClient";
import { getLensEquivalents, type LensEquivalentsResponse } from "@/services/costAxisCatalogApi";
import type { CostPreference } from "@/types/route";

/** 凡例の下に書く段の境目の目安を、地図のレンズと同じ利用者の値`preference`で引く（色と目安を同じ値で揃える）。費用のレンズを
 * 塗っていない間（`enabled`がfalse）・届くまで・定義が無い間はundefined。 */
export function useLensEquivalents(preference: CostPreference, enabled: boolean): LensEquivalentsResponse | undefined {
  const query = lensPreferenceQuery(preference, "", true);
  const { data } = useQuery(
    { queryKey: ["lens-equivalents", query], queryFn: () => getLensEquivalents(query), enabled },
    getQueryClient(),
  );
  return data ?? undefined;
}
