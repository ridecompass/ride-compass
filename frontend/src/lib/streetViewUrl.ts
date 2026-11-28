// 地図の地点から開く Google マップの Street View。API キーは要らない。
// - 既定は Maps URLs（https://developers.google.com/maps/documentation/urls/get-started の「Street View」）。地点に最も近い撮影地点の
//   パノラマを開き、スマホでは Google マップのアプリがあればアプリで開く。この文書は、Android のアプリが`heading`を読むとは約束しない。
// - Android は、Google マップのアプリの intent（https://developer.android.com/guide/components/google-maps-intents の
//   「Display a Street View panorama」。`cbp`の2つ目が真北0・時計回りの向き）を、Chrome の`intent:`の URL
//   （https://developer.chrome.com/docs/android/intents 。形は Android の`Intent.parseUri`）で渡す。アプリで開けなければ
//   `S.browser_fallback_url`の Maps URLs へ移る。Chrome が`intent:`を開くのは利用者が押したリンクだけなので、押す前に決まったリンクにする。

/** 地図の Street View を開く地点と、カメラの向き。 */
export interface StreetViewAim {
  /** [経度, 緯度]。 */
  lngLat: readonly [number, number];
  /** 真北0・時計回りの度。 */
  headingDeg: number;
}

const ANDROID_MAPS_PACKAGE = "com.google.android.apps.maps";

/** 地点と向き`aim`の Street View を開く URL。`android`なら、アプリへ向きが届く`intent:`の URL にする。 */
export function streetViewUrl({ lngLat, headingDeg }: StreetViewAim, android: boolean): string {
  const latLng = `${lngLat[1].toFixed(6)},${lngLat[0].toFixed(6)}`;
  const heading = String(Math.round(headingDeg));
  const params = new URLSearchParams({ api: "1", map_action: "pano", viewpoint: latLng, heading });
  const mapsUrl = `https://www.google.com/maps/@?${params.toString()}`;
  if (!android) return mapsUrl;
  return (
    `intent:cbll=${latLng}&cbp=0,${heading},0,0,0#Intent;scheme=google.streetview;package=${ANDROID_MAPS_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(mapsUrl)};end`
  );
}

/** この端末が Android か（ブラウザの`navigator.userAgent`で見る）。 */
export function onAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}
