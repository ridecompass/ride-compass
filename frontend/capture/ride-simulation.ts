import type { CaptureScript } from "./context";

// 模擬走行: ルートを作って走行モードを始め、選んだルートの線に沿って毎秒1点ずつ位置を流し、Android の Chrome と同じく北を基準にした
// 向きの出来事を毎秒30回届ける。走り終えたら、走行の記録（`lib/rideMetrics.ts` が端末に残す1分ごとの数）と、ページの CPU の時間
// （Chrome の Performance.getMetrics）を出力へ書く。実走の記録と同じ数を開発機で取り、直す前と後を同じ条件で比べる
// （電池の減りそのものと、スマホの GPU・画面の消費は測れない）。
//   node frontend/scripts/capture.mjs --script frontend/capture/ride-simulation.ts --api <本番の backend> --size 390x812
// 走る長さ（分）・速さ（km/h）・CPU を遅くする倍率は、環境変数 RIDE_SIM_MINUTES・RIDE_SIM_SPEED_KMH・RIDE_SIM_CPU_SLOWDOWN で変える。
// 走り終えたあとに同じ所で止まっている長さ（分。信号待ち・休憩に見立て、位置のぶれと向きの出来事は続ける）は RIDE_SIM_STOP_MINUTES、
// 出しておく層（「表示」の層の id をカンマで区切る。例: precipitationNowcast,windVector）は RIDE_SIM_LAYERS で選ぶ。
// 走行モードを始めたあとの地図の縮尺（利用者が引いて走る形）は RIDE_SIM_ZOOM で選ぶ（省けば走行モードが決めた縮尺のまま）。

/** 位置のぶれ（m）。実機の GPS の誤差の目安で、毎回この幅で散らす。 */
const JITTER_M = 4;
const ORIENTATION_PER_SECOND = 30;
const METERS_PER_DEGREE = 111_320;

type Point = [number, number];

function distanceM([lng1, lat1]: Point, [lng2, lat2]: Point): number {
  const x = (lng2 - lng1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180) * METERS_PER_DEGREE;
  const y = (lat2 - lat1) * METERS_PER_DEGREE;
  return Math.hypot(x, y);
}

function bearingDeg([lng1, lat1]: Point, [lng2, lat2]: Point): number {
  const x = (lng2 - lng1) * Math.cos((lat1 * Math.PI) / 180);
  return ((Math.atan2(x, lat2 - lat1) * 180) / Math.PI + 360) % 360;
}

/** 線の上を、始点から`alongM`進んだ点と、その点の進む向き。線の終わりを越えたら終点。 */
function pointAlong(line: readonly Point[], alongM: number): { at: Point; bearing: number } {
  let rest = alongM;
  for (let i = 0; i < line.length - 1; i++) {
    const length = distanceM(line[i], line[i + 1]);
    if (rest <= length && length > 0) {
      const t = rest / length;
      const at: Point = [
        line[i][0] + (line[i + 1][0] - line[i][0]) * t,
        line[i][1] + (line[i + 1][1] - line[i][1]) * t,
      ];
      return { at, bearing: bearingDeg(line[i], line[i + 1]) };
    }
    rest -= length;
  }
  const last = line.length - 1;
  return { at: line[last], bearing: last > 0 ? bearingDeg(line[last - 1], line[last]) : 0 };
}

const script: CaptureScript = async ({ page, fixtures, open, shot, expect }) => {
  const minutes = Number(process.env.RIDE_SIM_MINUTES ?? 3);
  const speedKmh = Number(process.env.RIDE_SIM_SPEED_KMH ?? 20);
  const slowdown = Number(process.env.RIDE_SIM_CPU_SLOWDOWN ?? 1);
  const stopMinutes = Number(process.env.RIDE_SIM_STOP_MINUTES ?? 0);
  const layers = (process.env.RIDE_SIM_LAYERS ?? "").split(",").filter((id) => id !== "");

  await open({ layers });
  await fixtures.generateRoutes(page, { distanceKm: 10 });
  // 結果のシートが地図の上の走行モードのボタンを覆うので閉じる。
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "ルート結果" })).toBeHidden();

  const line: Point[] = await page.evaluate(async () => {
    const source = window.__liveMap().getSource("route-selected") as unknown as {
      getData: () => Promise<GeoJSON.FeatureCollection>;
    };
    const data = await source.getData();
    return data.features.flatMap((feature) =>
      feature.geometry.type === "LineString"
        ? (feature.geometry.coordinates as [number, number][])
        : feature.geometry.type === "MultiLineString"
          ? (feature.geometry.coordinates.flat() as [number, number][])
          : [],
    );
  });
  expect(line.length, "選んだルートの線を地図から読めなかった").toBeGreaterThan(1);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  if (slowdown > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: slowdown });
  const metricsOf = async () =>
    Object.fromEntries(
      ((await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }).metrics.map(
        ({ name, value }) => [name, value],
      ),
    );

  const [startLng, startLat] = line[0];
  await page.context().setGeolocation({ latitude: startLat, longitude: startLng, accuracy: JITTER_M });
  await page.getByRole("button", { name: "走行モード" }).click();
  const zoom = process.env.RIDE_SIM_ZOOM === undefined ? null : Number(process.env.RIDE_SIM_ZOOM);
  if (zoom !== null) await page.evaluate((z) => window.__liveMap().zoomTo(z, { duration: 0 }), zoom);
  const before = await metricsOf();

  // 向きの出来事は、ページの中で毎秒30回届ける（手に持ったスマホの揺れとして、進む向きに数度のぶれを足す）。
  await page.evaluate((perSecond) => {
    const holder = window as unknown as { __simHeading: number; __simTimer: number };
    holder.__simHeading = 0;
    holder.__simTimer = window.setInterval(() => {
      const event = Object.assign(new Event("deviceorientationabsolute"), {
        alpha: (360 - holder.__simHeading + (Math.random() - 0.5) * 8 + 360) % 360,
        beta: 40,
        gamma: 0,
        absolute: true,
      });
      window.dispatchEvent(event);
    }, 1000 / perSecond);
  }, ORIENTATION_PER_SECOND);

  const metersPerSecond = speedKmh / 3.6;
  const movingSeconds = minutes * 60;
  for (let second = 0; second < movingSeconds + stopMinutes * 60; second++) {
    const { at, bearing } = pointAlong(line, Math.min(second, movingSeconds - 1) * metersPerSecond);
    const jitter = () => ((Math.random() - 0.5) * 2 * JITTER_M) / METERS_PER_DEGREE;
    await page
      .context()
      .setGeolocation({ latitude: at[1] + jitter(), longitude: at[0] + jitter(), accuracy: JITTER_M });
    await page.evaluate((heading) => {
      (window as unknown as { __simHeading: number }).__simHeading = heading;
    }, bearing);
    await page.waitForTimeout(1000);
  }

  const after = await metricsOf();
  await page.evaluate(() => window.clearInterval((window as unknown as { __simTimer: number }).__simTimer));
  await shot("模擬走行の終わり");
  await page.getByRole("button", { name: "走行モード" }).click();
  const record = await page.evaluate(() => window.localStorage.getItem("ridecompass:ride-metrics"));
  const cpu = Object.fromEntries(
    ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "JSHeapUsedSize"].map((name) => [
      name,
      name === "JSHeapUsedSize"
        ? Math.round((after[name] ?? 0) / 1024 / 1024)
        : Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000),
    ]),
  );
  // 出力の1行目は条件と CPU の時間（ms。メモリは MB）、2行目は走行の記録の JSON。
  console.log(
    `[ride-simulation] ${JSON.stringify({ minutes, stopMinutes, speedKmh, slowdown, layers, zoom, cpuMs: cpu })}`,
  );
  console.log(`[ride-simulation:record] ${record}`);
};

export default script;
