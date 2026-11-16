/**
 * 地点を住所・施設で探す欄（`features/route/PlaceSearch/PlaceSearch.tsx`）を、ページと同じく欄の中身・候補の引き方・保存した地点を包む側に
 * 持たせて描く足場。打つ欄のテストと、保存した地点・検索の履歴のテストが使う。保存した地点と履歴は本物の置き場（この端末の保存）を通すので、
 * 使うテストは`beforeEach`で`window.localStorage.clear()`を呼ぶ。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { vi } from "vitest";

import PlaceSearch from "@/features/route/PlaceSearch/PlaceSearch";
import { usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { newPlacings, placeLabelOf } from "@/features/route/pointNames";
import { useSavedPlaces } from "@/features/route/useSavedPlaces";
import type { Coordinates } from "@/types/route";

/** 地図の真ん中（東京駅）。丸の内二丁目まで直線で0.4km、浅草寺まで4.6km。 */
export const TOKYO_STATION: Coordinates = { latitude: 35.681, longitude: 139.767 };
/** 浅草寺のすぐ南（浅草寺まで直線で0.2km）。 */
export const NEAR_SENSOJI: Coordinates = { latitude: 35.713, longitude: 139.7967 };

/** 欄の中身と候補の引き方・保存した地点は、ページと同じく包む側が持つ。 */
function Search({
  mapCenter,
  ...props
}: { mapCenter: Coordinates } & Omit<React.ComponentProps<typeof PlaceSearch>, "savedPlaces" | "lookup">) {
  return <PlaceSearch {...props} lookup={usePlaceLookup(mapCenter)} savedPlaces={useSavedPlaces()} />;
}

export function renderSearch({ mapCenter = TOKYO_STATION, isMobile = false } = {}) {
  const onChoose = vi.fn();
  const onPlace = vi.fn();
  const inputRef = createRef<HTMLInputElement>();
  const search = (center: Coordinates) => (
    <Search
      title="目的地"
      chooseResult=""
      full={false}
      mapCenter={center}
      onChoose={onChoose}
      // 置く先のボタンは包む側が渡す（地点の並びの札は`app/page.places.test.tsx`が見る）。
      placeTo={(place) =>
        newPlacings({ waypointsFull: false, loop: false }).map(({ target }) => (
          <button key={target.role} type="button" onClick={() => place(target)}>
            {placeLabelOf(target)}
          </button>
        ))
      }
      onPlace={onPlace}
      onSearch={() => {}}
      isMobile={isMobile}
      cardIn="map"
      inputRef={inputRef}
    />
  );
  const { rerender } = render(search(mapCenter));
  return { onChoose, onPlace, moveMap: (center: Coordinates) => rerender(search(center)) };
}

export function searchBox() {
  return screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" });
}

export async function searchFor(text: string) {
  await userEvent.clear(searchBox());
  await userEvent.type(searchBox(), `${text}{Enter}`);
}
