// 天気の印（風の矢印・落雷・災害の範囲）の形。地図へ登録する画素（`features/map/layers/weatherMarkIcon.ts`）と凡例の見本
// （`components/WeatherMarkSwatch/WeatherMarkSwatch.tsx`）が同じ宣言を読む——別々に描くと、見本と地図の絵が食い違う。
// 凡例の行（`legendFilter.ts: LegendEntry`）が名指すので、両方が読むこの層に置く。

/** 形の線を書く座標の一辺。線の外に縁を引く余白を、四方に`WEATHER_MARK_PAD`ずつ足して描く。 */
export const WEATHER_MARK_FRAME = 24;
export const WEATHER_MARK_PAD = 3;

/** 印の形（北＝上を向けた線の並び）と線の太さ（`WEATHER_MARK_FRAME`の座標）。線の外に白い縁、その外に暗い細線を引く（`whiteHalo`が false の印は暗い細線だけ）。
 * 風の矢印は凡例の明るい色（水色・黄緑・黄）が白い縁に溶けないよう、落雷より太い線にする。 */
export const WEATHER_MARKS = {
  // 風は矢羽根（天気図で風を示す形）。矢じりが風の吹いていく向き、羽根が風上の側で、ただの矢印と見分けられる。
  // 輪郭は外の暗い細線だけにする（白い縁と重ねると、格子点に並ぶ矢羽根の輪郭がうるさい）。
  windArrow: {
    lines: ["M12 21V3", "m8.5 6.5 3.5-3.5 3.5 3.5", "M12 21l-5-3", "M12 17.5l-5-3"],
    width: 3,
    whiteHalo: false,
  },
  // 落雷の地点は、稲妻と地面（落ちた所）。雷の範囲の印の中の稲妻（`thunder`）と凡例で見分けられる。
  liden: { lines: ["M14 2 7 12h5l-2.5 7 8-9.5h-5z", "M4 22h16"], width: 2.6 },
  // 災害の範囲の印の中の絵（`HAZARD_BADGES`の背景に載せる）。雷・竜巻・雨粒・波は lucide の zap・tornado・droplets・
  // waves-arrow-up。土砂災害は合う形が無く（mountain は標高の印に使っている）、斜面と転がる石を描く。
  thunder: { lines: ["M13 2 4 14h7l-1 8 9-12h-7z"], width: 2.6 },
  tornado: { lines: ["M21 4H3", "M18 8H6", "M19 12H9", "M16 16h-6", "M11 20H9"], width: 2.6 },
  heavyRain: {
    lines: [
      "M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z",
      "M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97",
    ],
    width: 2.6,
  },
  landslide: {
    lines: [
      "M2 21h20",
      "M3 21 10 4l5 9",
      "M17 14a2 2 0 1 0 0.01 0",
      "M20.5 17.5a1.8 1.8 0 1 0 0.01 0",
      "M15.5 18.5a1.6 1.6 0 1 0 0.01 0",
    ],
    width: 2.6,
  },
  inundation: {
    lines: [
      "M12 2v8",
      "m8 6 4-4 4 4",
      "M2 15c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1",
      "M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1",
    ],
    width: 2.6,
  },
} as const satisfies Record<
  string,
  { readonly lines: readonly string[]; readonly width: number; readonly whiteHalo?: boolean }
>;

export type WeatherMark = keyof typeof WEATHER_MARKS;

/** 災害の範囲の印の背景の形（`WEATHER_MARK_FRAME`の座標）と、中へ載せる災害の絵の中心と縮め方。注意報（塗らない段）は三角、
 * 警報（すぐに行動が要る塗る段）は八角にし、形で段の重さを、塗りの色で段を、中の絵で災害の種類を見せる。 */
export const HAZARD_BADGES = {
  attention: {
    shape: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
    glyph: { x: 12, y: 14.2, scale: 0.42 },
  },
  warning: { shape: "M8.2 2h7.6L22 8.2v7.6L15.8 22H8.2L2 15.8V8.2z", glyph: { x: 12, y: 12, scale: 0.5 } },
} as const;

export type HazardBadge = keyof typeof HAZARD_BADGES;

/** 背景の形の輪郭の太さと、中の絵の線の太さ（中の絵の座標）。背景は白い縁を付けず、太い輪郭で地図から浮かせる。 */
export const HAZARD_BADGE_STROKE = 2.6;
export const HAZARD_GLYPH_STROKE = 3.4;

/** 白い縁と、その外の暗い細線の太さ（線の太さへの足し分）と、白い縁を付けない印の暗い細線の太さ。 */
export const WEATHER_MARK_HALO_EXTRA = 3.9;
export const WEATHER_MARK_EDGE_EXTRA = 5.5;
export const WEATHER_MARK_BARE_EDGE_EXTRA = 1.6;
