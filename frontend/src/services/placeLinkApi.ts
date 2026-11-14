import { queryOptions } from "@tanstack/react-query";
import { backendApi, getOptions, requestApi } from "@/lib/apiClient";
import { API_TIMEOUT_MS } from "@/lib/apiTimeouts";

/** 地図の点（名前と位置。位置は経度・緯度の順）から開く外の地図のリンク。所在（住所か辺り）の決め方とリンクの形は backend が持ち、
 * 所在が分からなければ null。 */
async function placeLink(name: string, lngLat: readonly [number, number]): Promise<string | null> {
  const data = await requestApi(
    (init) =>
      backendApi.GET("/api/place-link", {
        params: { query: { name, latitude: lngLat[1], longitude: lngLat[0] } },
        ...init,
      }),
    getOptions({ timeoutMs: API_TIMEOUT_MS.default, category: "api:placeLink", errorLabel: "外の地図のリンク" }),
  );
  return data.url;
}

/** 点のリンクを引く問い合わせ。小窓を開いたときに引き、押す前に済ませる（押してから引くと、iPhone の Safari が新しい窓を止める）。 */
export function placeLinkQuery(name: string, lngLat: readonly [number, number]) {
  return queryOptions({
    queryKey: ["place-link", name, lngLat[0], lngLat[1]],
    queryFn: () => placeLink(name, lngLat),
    // 答えは地点の表の作り直しまで変わらない（backend もブラウザに1日持たせる）。小窓を開き直すたびに取り直さない。
    staleTime: Infinity,
  });
}
