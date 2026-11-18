// 天気の印（風の矢印・落雷）の形。地図へ登録する画素（`features/map/layers/weatherMarkIcon.ts`）と凡例の見本
// （`components/WeatherMarkSwatch/WeatherMarkSwatch.tsx`）が同じ宣言を読む——別々に描くと、見本と地図の絵が食い違う。
// 凡例の行（`legendFilter.ts: LegendEntry`）が名指すので、両方が読むこの層に置く。

/** 形の線を書く座標の一辺。線の外に縁を引く余白を、四方に`WEATHER_MARK_PAD`ずつ足して描く。 */
export const WEATHER_MARK_FRAME = 24;
export const WEATHER_MARK_PAD = 3;

/** 印の形（北＝上を向けた線の並び）と線の太さ（`WEATHER_MARK_FRAME`の座標）。線の外に白い縁、その外に暗い細線を引く。
 * 風の矢印は凡例の明るい色（水色・黄緑・黄）が白い縁に溶けないよう、落雷より太い線にする。 */
export const WEATHER_MARKS = {
  windArrow: { lines: ["M12 19V5", "m7 10 5-5 5 5"], width: 3.4 },
  liden: { lines: ["M13 2 4 14h7l-1 8 9-12h-7z"], width: 2.6 },
} as const satisfies Record<string, { readonly lines: readonly string[]; readonly width: number }>;

export type WeatherMark = keyof typeof WEATHER_MARKS;

/** 白い縁と、その外の暗い細線の太さ（線の太さへの足し分）。 */
export const WEATHER_MARK_HALO_EXTRA = 3.9;
export const WEATHER_MARK_EDGE_EXTRA = 5.5;
