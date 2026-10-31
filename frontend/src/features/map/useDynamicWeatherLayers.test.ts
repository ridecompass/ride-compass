/**
 * 動的気象レイヤーのフックが、表示中のソースだけを配信元から取り、選んだ時刻のコマの描画内容とチップの取得状態を
 * 返すことを見る（docs/modules/frontend/dynamic-weather-layers.md）。配信元の中継（時刻一覧・地物・タイル。画面のオリジンへ出る）と
 * MSMの格子点（backendへ出る）は網の層で応える。応答を与えていない要求はテストを落とすので、取りに行かないソースは
 * 応答を与えないことで確かめる。
 *
 * ここで見ないもの: 時刻一覧の行の読み方・段のつなぎ方・コマの規則（`jmaDelivery.test.ts`・`weatherSources.test.ts`）、
 * タイルの失敗の記録（`jmaTileProtocol.test.ts`）とコマの突き合わせ（`dynamicWeather.test.ts`）。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

import { jmaTilePayload } from "@/features/map/layers/jmaDelivery";
import { registerJmaTileProtocol, withJmaTileProtocol } from "@/features/map/layers/jmaTileProtocol";
import type { MapLayerVisibility } from "@/features/map/layers/mapLayers";
import { MAP_FETCH_DEBOUNCE_MS } from "@/hooks/useDebouncedValue";
import { heldReplies, inTurn, onBackend, onSameOrigin } from "@/testing/backendServer";
import { protocolHandler } from "@/testing/maplibre";
import { jmaDeliveryOf, jmaTileUrlAt } from "@/testing/jmaDeliveries";
import { mapDisplay } from "@/types/generated/mapDisplay";

import { useDynamicWeatherLayers } from "./useDynamicWeatherLayers";

const NOW = new Date("2026-10-07T03:00:00Z");
const BASETIME = "20261007030000";
const FRAME = { basetime: BASETIME, member: "none", validtime: BASETIME };
const DISASTER_RISK = ["heavyRain", "landslide", "inundation", "flood"];
const DISASTER_NOWCAST = ["thunder", "tornado", "liden"];
const PRECIPITATION_EXCEPT_MAIN = ["linearRainband", "linearRainbandArea", "linearRainbandAreaForecast"];
/** MSMの格子点を取り始めるズーム。 */
const GRID_ZOOM = mapDisplay.layerDataSources.find((source) => source.key === "msmGrid")!.minZoom!;

const timesPath = (file: string) => `/api/jma-tile/bosai/jmatile/data/${file}`;
const rows = (...elements: string[]) => [{ ...FRAME, elements }];
const failure = () => new HttpResponse(null, { status: 500 });

type Options = Parameters<typeof useDynamicWeatherLayers>[0];

function render(
  shown: Partial<MapLayerVisibility>,
  hiddenSources: Options["hiddenSources"] = {},
  mapViewport: Options["mapViewport"] = null,
) {
  return renderHook(
    ({ at = NOW, viewport = mapViewport }: { at?: Date; viewport?: Options["mapViewport"] }) =>
      useDynamicWeatherLayers({
        visibility: shown as MapLayerVisibility,
        hiddenSources,
        mapViewport: viewport,
        at,
        now: NOW,
      }),
    { initialProps: {} },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useDynamicWeatherLayers", () => {
  it("表示中のソースだけを取りに行き、選んだ時刻のコマのタイルを描く（消したチップと隠したソースは描かず、チップのどれかのソースが描けていれば空としない）", async () => {
    onSameOrigin("GET", timesPath("risk/targetTimes.json"), () => Response.json(rows("rain_mesh", "land")));

    const { result } = render({ disaster: true }, { disaster: ["landslide", ...DISASTER_NOWCAST] });

    expect(result.current.dynamicWeatherDataStatus.disaster).toBe("loading");
    await waitFor(() =>
      expect(result.current.dynamicWeather.disaster?.heavyRain).toEqual({
        visible: true,
        payload: jmaTilePayload("rasterTile", jmaDeliveryOf("rain_mesh"), FRAME),
      }),
    );
    expect(result.current.dynamicWeather.disaster?.landslide).toEqual({ visible: false, payload: undefined });
    expect(result.current.dynamicWeather.precipitationNowcast?.main?.visible).toBe(false);
    expect(result.current.dynamicWeatherDataStatus).toEqual({
      disaster: undefined,
      precipitationNowcast: undefined,
    });
  });

  it("時刻一覧に描けるコマが無いチップは、取り終えたら空にする", async () => {
    onSameOrigin("GET", timesPath("risk/targetTimes.json"), () => Response.json([]));

    const { result } = render({ disaster: true }, { disaster: DISASTER_NOWCAST });

    await waitFor(() => expect(result.current.dynamicWeatherDataStatus.disaster).toBe("empty"));
  });

  it.each([
    {
      name: "一部のファイルが取れなければ、残りのファイルで描く",
      n1: () => Response.json(rows("hrpns")),
      status: undefined,
      drawn: true,
    },
    { name: "全部のファイルが取れなければ、失敗にする", n1: failure, status: "error", drawn: false },
  ])("時刻一覧が複数のファイルに分かれる配信は、$name", async ({ n1, status, drawn }) => {
    onSameOrigin("GET", timesPath("nowc/targetTimes_N1.json"), n1);
    onSameOrigin("GET", timesPath("nowc/targetTimes_N2.json"), failure);
    onSameOrigin("GET", timesPath("rasrf/targetTimes.json"), () => Response.json([]));

    const { result } = render({ precipitationNowcast: true }, { precipitationNowcast: PRECIPITATION_EXCEPT_MAIN });

    await waitFor(() => expect(result.current.dynamicWeatherDataStatus.precipitationNowcast).not.toBe("loading"));
    expect(result.current.dynamicWeatherDataStatus.precipitationNowcast).toBe(status);
    expect(result.current.dynamicWeather.precipitationNowcast?.main?.payload).toEqual(
      drawn ? jmaTilePayload("rasterTile", jmaDeliveryOf("hrpns"), FRAME) : undefined,
    );
  });

  it("時刻一覧の取り直しに失敗している間は、前に届いた一覧のコマで描き続け、失敗にする", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true });
    onSameOrigin("GET", timesPath("risk/targetTimes.json"), inTurn(Response.json(rows("rain_mesh")), failure()));
    const { result } = render({ disaster: true }, { disaster: DISASTER_NOWCAST });
    await waitFor(() => expect(result.current.dynamicWeather.disaster?.heavyRain?.payload).toBeDefined());

    act(() => vi.advanceTimersByTime(jmaDeliveryOf("rain_mesh").refreshIntervalMs));

    await waitFor(() => expect(result.current.dynamicWeatherDataStatus.disaster).toBe("error"));
    expect(result.current.dynamicWeather.disaster?.heavyRain?.payload).toEqual(
      jmaTilePayload("rasterTile", jmaDeliveryOf("rain_mesh"), FRAME),
    );
  });

  it("地物で描く段は選んでいるコマの地物だけを描き、取れていない間は読み込み中、取れなければ失敗にする", async () => {
    const row = (validtime: string) => ({ basetime: "20261007025500", member: "none", validtime, elements: ["liden"] });
    onSameOrigin("GET", timesPath("nowc/targetTimes_N3.json"), () =>
      Response.json([row("20261007025500"), row(BASETIME)]),
    );
    const geojson = heldReplies();
    onSameOrigin(
      "GET",
      "/api/jma-tile/bosai/jmatile/data/nowc/:basetime/none/:validtime/surf/liden/data.geojson",
      geojson.reply,
    );
    const point = { type: "Point", coordinates: [139, 35] };
    const { result, rerender } = render({ disaster: true }, { disaster: [...DISASTER_RISK, "thunder", "tornado"] });
    await waitFor(() => expect(geojson.arrived()).toBe(1));
    expect(result.current.dynamicWeatherDataStatus.disaster).toBe("loading");

    // 前のコマへ動かしたあとに、後のコマの地物が届いても描かない。
    rerender({ at: new Date("2026-10-07T02:55:00Z") });
    await geojson.answer(
      0,
      Response.json({ type: "FeatureCollection", features: [{ type: "Feature", geometry: point, properties: {} }] }),
    );
    await geojson.answer(1, new HttpResponse(null, { status: 404 }));

    await waitFor(() => expect(result.current.dynamicWeatherDataStatus.disaster).toBe("error"));
    expect(result.current.dynamicWeather.disaster?.liden?.payload).toBeUndefined();
    rerender({ at: NOW });
    expect(result.current.dynamicWeather.disaster?.liden?.payload).toMatchObject({
      kind: "gridMark",
      geojson: { features: [{ geometry: point }] },
    });
  });

  it("地物で描くソースがいくつ表示されていても、それぞれのソースの地物を描く", async () => {
    const row = (validtime: string) => ({
      basetime: BASETIME,
      member: "none",
      validtime,
      elements: ["slmcs_unify", "slmcs_unifyfcst"],
    });
    onSameOrigin("GET", timesPath("nowc/targetTimes_N3.json"), () =>
      Response.json([row(BASETIME), row("20261007030500"), row("20261007031000")]),
    );
    const pointOf = (path: string) => ({
      type: "Point",
      coordinates: [path.includes("slmcs_unifyfcst/") ? 140 : 139, 35],
    });
    onSameOrigin(
      "GET",
      "/api/jma-tile/bosai/jmatile/data/nowc/:basetime/none/:validtime/surf/:element/data.geojson",
      ({ path }) =>
        Response.json({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: pointOf(path), properties: {} }],
        }),
    );

    const { result } = render({ precipitationNowcast: true }, { precipitationNowcast: ["main", "linearRainband"] });

    await waitFor(() => expect(result.current.dynamicWeatherDataStatus.precipitationNowcast).not.toBe("loading"));
    const sources = result.current.dynamicWeather.precipitationNowcast;
    expect(sources?.linearRainbandArea?.payload).toMatchObject({
      geojson: { features: [{ geometry: pointOf("slmcs_unify/") }] },
    });
    expect(sources?.linearRainbandAreaForecast?.payload).toMatchObject({
      geojson: { features: [{ geometry: pointOf("slmcs_unifyfcst/") }] },
    });
  });

  it("MSMの格子点で描く段は、選んだ時刻の格子点の値を、矢印は格子点の位置に、降水は格子点を中心に格子点の間隔の升目に描く", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // 配信元の段が空なので、降水の時系列は格子点の段だけになる。
    for (const file of ["nowc/targetTimes_N1.json", "nowc/targetTimes_N2.json", "rasrf/targetTimes.json"]) {
      onSameOrigin("GET", timesPath(file), () => Response.json([]));
    }
    // 時刻はNOWとその1時間後（日本時間の壁時計）。値の欠けた格子点は描かない。
    onBackend("GET", "/api/weather/msm-grid", () =>
      Response.json({
        times: ["2026-10-07T12:00", "2026-10-07T13:00"],
        latitude_step_deg: 0.1,
        longitude_step_deg: 0.125,
        points: [
          {
            latitude: 35.6,
            longitude: 139.75,
            wind_speed_ms: [2, 5.5],
            wind_direction_deg: [0, 270],
            precipitation_mm: [0, 3.2],
          },
          {
            latitude: 35.7,
            longitude: 139.875,
            wind_speed_ms: [3, null],
            wind_direction_deg: [90, 90],
            precipitation_mm: [1, null],
          },
        ],
      }),
    );
    const viewport = { west: 139.7, south: 35.55, east: 139.9, north: 35.75, zoom: GRID_ZOOM, bearing: 0 };

    const { result, rerender } = render(
      { precipitationNowcast: true, windVector: true },
      { precipitationNowcast: PRECIPITATION_EXCEPT_MAIN },
      viewport,
    );
    await vi.waitFor(() => expect(result.current.dynamicWeather.windVector?.arrow?.payload).toBeDefined());
    rerender({ at: new Date("2026-10-07T04:00:00Z") });

    expect(result.current.dynamicWeather.windVector?.arrow?.payload).toEqual({
      kind: "gridMark",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [139.75, 35.6] },
            properties: { speed: 5.5, bearing: 90 },
          },
        ],
      },
      gridStepDeg: { latitude: 0.1, longitude: 0.125 },
    });
    const cells = result.current.dynamicWeather.precipitationNowcast?.main?.payload;
    expect(cells).toMatchObject({ kind: "gridFill", geojson: { features: [{ properties: { mmPerHour: 3.2 } }] } });
    const ring =
      cells?.kind === "gridFill" ? (cells.geojson.features[0].geometry as GeoJSON.Polygon).coordinates[0] : [];
    const corners = ring.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]);
    expect(corners).toEqual([
      [139.6875, 35.55],
      [139.8125, 35.55],
      [139.8125, 35.65],
      [139.6875, 35.65],
      [139.6875, 35.55],
    ]);
    expect(cells?.kind === "gridFill" && cells.geojson.features).toHaveLength(1);
  });

  it("表示範囲が少し動くだけなら格子点を取り直さず、矢印を描き直さない。大きく動けば取り直す", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sent = onBackend("GET", "/api/weather/msm-grid", () =>
      Response.json({
        times: ["2026-10-07T12:00"],
        latitude_step_deg: 0.05,
        longitude_step_deg: 0.0625,
        points: [
          { latitude: 35.65, longitude: 139.8125, wind_speed_ms: [4], wind_direction_deg: [0], precipitation_mm: [0] },
        ],
      }),
    );
    const viewport = { west: 139.7, south: 35.55, east: 139.9, north: 35.74, zoom: GRID_ZOOM, bearing: 0 };
    const shifted = (deg: number) => ({
      ...viewport,
      west: viewport.west + deg,
      east: viewport.east + deg,
      south: viewport.south + deg,
      north: viewport.north + deg,
    });
    const arrows = () => result.current.dynamicWeather.windVector?.arrow?.payload;
    const { result, rerender } = render({ windVector: true }, {}, viewport);
    await vi.waitFor(() => expect(arrows()).toBeDefined());
    const drawn = arrows();

    // 走行中に地図が現在地へ寄せ直すたびの、100mほどのずれ。取り直すと backend の回数の上限に当たり、断られた間は矢印が消える。
    rerender({ viewport: shifted(0.001) });
    await act(() => vi.advanceTimersByTimeAsync(MAP_FETCH_DEBOUNCE_MS));
    expect(sent).toHaveLength(1);
    expect(arrows()).toBe(drawn);

    rerender({ viewport: shifted(0.1) });
    await act(() => vi.advanceTimersByTimeAsync(MAP_FETCH_DEBOUNCE_MS));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
  });

  it("描いているコマのタイルの配信が落ちている間は、そのチップを失敗にする", async () => {
    onSameOrigin("GET", timesPath("risk/targetTimes.json"), () => Response.json(rows("rain_mesh")));
    const { result } = render({ disaster: true }, { disaster: DISASTER_NOWCAST });
    await waitFor(() => expect(result.current.dynamicWeather.disaster?.heavyRain?.payload).toBeDefined());
    expect(result.current.dynamicWeatherDataStatus.disaster).toBeUndefined();
    registerJmaTileProtocol();
    const requestTile = protocolHandler(withJmaTileProtocol("").split("://")[0]) as (
      params: { url: string },
      abort: AbortController,
    ) => Promise<unknown>;
    const template = jmaTilePayload("rasterTile", jmaDeliveryOf("rain_mesh"), FRAME).tileUrlTemplate;
    const tile = jmaTileUrlAt(template, 5, 28, 12);
    const tilePath = new URL(tile).pathname;

    onSameOrigin("GET", tilePath, failure);
    await act(() => requestTile({ url: withJmaTileProtocol(tile) }, new AbortController()));
    expect(result.current.dynamicWeatherDataStatus.disaster).toBe("error");

    // 配信が戻れば外れる（記録はモジュールが持つので、後のテストへ残さない）。
    onSameOrigin("GET", tilePath, () => new HttpResponse(new ArrayBuffer(0)));
    await act(() => requestTile({ url: withJmaTileProtocol(tile) }, new AbortController()));
    expect(result.current.dynamicWeatherDataStatus.disaster).toBeUndefined();
  });
});
