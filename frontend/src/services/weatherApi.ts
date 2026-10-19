import type { Coordinates } from "@/types/route";
import { backendApi, getOptions, requestApi } from "@/lib/apiClient";
import { API_TIMEOUT_MS } from "@/lib/apiTimeouts";

function weatherOptions(category: string, errorLabel: string) {
  return getOptions({ timeoutMs: API_TIMEOUT_MS.default, category, errorLabel });
}

/** 地点1つを問い合わせる項目。 */
function atPoint(point: Coordinates) {
  return { params: { query: { latitude: point.latitude, longitude: point.longitude } } };
}

export const getAmedasObservation = (point: Coordinates) =>
  requestApi(
    (init) => backendApi.GET("/api/weather/amedas", { ...atPoint(point), ...init }),
    weatherOptions("api:amedas", "アメダス観測値"),
  );

export const getWeatherWarnings = (point: Coordinates) =>
  requestApi(
    (init) => backendApi.GET("/api/weather/warnings", { ...atPoint(point), ...init }),
    weatherOptions("api:weatherWarnings", "警報・注意報"),
  );

export const getWbgtStatus = (point: Coordinates) =>
  requestApi(
    (init) => backendApi.GET("/api/weather/wbgt", { ...atPoint(point), ...init }),
    weatherOptions("api:wbgt", "暑さ指数"),
  );

export const getFloodForecasts = (point: Coordinates) =>
  requestApi(
    (init) => backendApi.GET("/api/weather/flood-forecast", { ...atPoint(point), ...init }),
    weatherOptions("api:floodForecast", "河川氾濫予報"),
  );

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** 表示範囲の中のMSMの格子点の、時刻ごとの風と降水。格子点が多い範囲ではbackendが格子点を同じ間隔おきに間引く。 */
export const getMsmGrid = (bbox: Bbox) =>
  requestApi(
    (init) =>
      backendApi.GET("/api/weather/msm-grid", {
        params: { query: { min_lon: bbox.minLon, min_lat: bbox.minLat, max_lon: bbox.maxLon, max_lat: bbox.maxLat } },
        ...init,
      }),
    { ...weatherOptions("api:msmGrid", "MSMの格子点"), successMeta: (data) => ({ points: data.points.length }) },
  );

/** JMAの動的タイルの在否。取れなくても呼ぶ側は間引きが効かないだけで表示は成り立つ。 */
export const fetchJmaTileIndex = () =>
  requestApi(
    (init) => backendApi.GET("/api/jma-tile-index", init),
    weatherOptions("api:jma-tile-index", "タイル在否インデックス"),
  );
