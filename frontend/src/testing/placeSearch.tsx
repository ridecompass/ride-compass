/**
 * 地点を住所・施設で探す小窓（`features/route/PlaceSearch/PointSearch.tsx`）を、「ルート設定」の条件タブの目的地の行から開いて操る足場。
 * 描くのは`testing/routeForm.tsx: renderForm`で、保存した地点と履歴は本物の置き場（この端末の保存）を通すので、使うテストは`beforeEach`で
 * `window.localStorage.clear()`を呼ぶ。
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { openPointSearch, renderForm } from "@/testing/routeForm";
import type { Coordinates } from "@/types/route";

/** 地図の真ん中（東京駅）。丸の内二丁目まで直線で0.4km、浅草寺まで4.6km。 */
export const TOKYO_STATION: Coordinates = { latitude: 35.681, longitude: 139.767 };
/** 浅草寺のすぐ南（浅草寺まで直線で0.2km）。 */
export const NEAR_SENSOJI: Coordinates = { latitude: 35.713, longitude: 139.7967 };

/** 目的地の行を押して、目的地を探す小窓を開く。置いた地点は`onPlace`へ上がる。 */
export async function renderSearch({ mapCenter = TOKYO_STATION, isMobile = false } = {}) {
  const form = renderForm({ isMobile }, "generate", mapCenter);
  await openPointSearch("目的地");
  return form;
}

export function searchBox() {
  return screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" });
}

export async function searchFor(text: string) {
  await userEvent.clear(searchBox());
  await userEvent.type(searchBox(), `${text}{Enter}`);
}
