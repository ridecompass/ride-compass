// 地図の地点から開く Google マップの Street View（Maps URLs。https://developers.google.com/maps/documentation/urls/get-started の
// 「Street View」）。地点に最も近い撮影地点のパノラマを開き、API キーは要らない。スマホでは Google マップのアプリがあればアプリで開く。

/** 地点`lngLat`（[経度, 緯度]）の Street View を開く URL。`headingDeg`（真北0・時計回りの度）を渡せばカメラをその向きにし、
 * nullなら Google が地点から決める。 */
export function streetViewUrl(lngLat: readonly [number, number], headingDeg: number | null): string {
  const params = new URLSearchParams({
    api: "1",
    map_action: "pano",
    viewpoint: `${lngLat[1].toFixed(6)},${lngLat[0].toFixed(6)}`,
  });
  if (headingDeg !== null) params.set("heading", String(Math.round(headingDeg)));
  return `https://www.google.com/maps/@?${params.toString()}`;
}
