// @vitest-environment node
/**
 * `features/route/savedPlaces.ts`——保存した地点の一覧を読む・一覧への入れ方・打った文字での絞り込みと、検索で選んだ地点の
 * 履歴への入れ方・消し方・出す件の絞り込み。読むときは、今の画面が受け付けない件だけを捨ててほかの件を残す。同じ名前か同じ位置で
 * 保存すると置き換える。履歴は同じ位置を置き換え、上限を超えた古い件を捨て、保存した地点と同じ位置の件を出さない。
 *
 * ここで見ないもの:
 * - 一覧をどこに出し、選ぶと何が起きるか → `PlaceSearch/PlaceSearch.test.tsx`
 * - 一覧として読めない保存値・入れた件を先頭に置くこと → `lib/storedList.test.ts`
 */
import { describe, expect, it } from "vitest";

import {
  historyMatching,
  PLACE_HISTORY_LIMIT,
  readSavedPlaces,
  savedPlacesMatching,
  withHistoryPlace,
  withoutHistoryPlaceAt,
  withSavedPlace,
  type SavedPlace,
} from "./savedPlaces";

const CAFE: SavedPlace = {
  kind: "facility",
  level: "point",
  name: "いつものカフェ",
  area: "文京区本駒込二丁目",
  latitude: 35.73,
  longitude: 139.75,
};
const HOME: SavedPlace = {
  kind: "facility",
  level: "point",
  name: "自宅",
  area: null,
  latitude: 35.75,
  longitude: 139.73,
};

describe("readSavedPlaces", () => {
  it("今の画面が受け付けない件だけを捨て、ほかの件は残す", () => {
    const raw = JSON.stringify([
      CAFE,
      { ...HOME, name: " " },
      { ...HOME, kind: "station" },
      { ...HOME, latitude: "35.75" },
      { ...HOME, area: 1 },
      null,
      HOME,
    ]);

    expect(readSavedPlaces(raw)).toEqual([CAFE, HOME]);
  });

  it("街区・地番（block）で決めた住所の地点も読み戻す", () => {
    const block: SavedPlace = { ...HOME, kind: "address", level: "block", name: "実家" };

    expect(readSavedPlaces(JSON.stringify([block]))).toEqual([block]);
  });
});

describe("withSavedPlace", () => {
  it("入れた件を先頭に置き、同じ名前・同じ位置の件を置き換える", () => {
    const renamed = { ...CAFE, name: "カフェ" };
    const moved = { ...HOME, latitude: 35.76 };

    expect(withSavedPlace([CAFE, HOME], renamed)).toEqual([renamed, HOME]);
    expect(withSavedPlace([CAFE, HOME], moved)).toEqual([moved, CAFE]);
  });
});

describe("savedPlacesMatching", () => {
  it("打った文字を名前に含むものだけを、前後の空白と大文字・小文字を問わずに残す。空なら全部", () => {
    const shop = { ...CAFE, name: "Bike Shop" };

    expect(savedPlacesMatching([CAFE, HOME, shop], " shop ")).toEqual([shop]);
    expect(savedPlacesMatching([CAFE, HOME, shop], "")).toEqual([CAFE, HOME, shop]);
  });
});

describe("履歴", () => {
  it("入れた件を先頭に置き、同じ位置の件を置き換え、上限を超えた古い件を捨てる", () => {
    const full = Array.from({ length: PLACE_HISTORY_LIMIT }, (_, i) => ({
      ...HOME,
      name: `地点${i}`,
      latitude: 35 + i / 100,
    }));
    const again = { ...full[3], name: "名前を変えて選び直した地点" };

    expect(withHistoryPlace(full, again)).toEqual([again, ...full.slice(0, 3), ...full.slice(4)]);
    expect(withHistoryPlace(full, CAFE)).toEqual([CAFE, ...full.slice(0, -1)]);
  });

  it("消すと、その位置の件だけが無くなる", () => {
    expect(withoutHistoryPlaceAt([CAFE, HOME], { latitude: HOME.latitude, longitude: HOME.longitude })).toEqual([CAFE]);
  });

  it("打った文字を名前に含み、保存した地点と同じ位置でないものだけを出す", () => {
    const savedHere = { ...CAFE, name: "前に検索で選んだカフェ" };
    const shop = { ...HOME, name: "Bike Shop", latitude: 35.8 };

    expect(historyMatching([savedHere, HOME, shop], [CAFE], "")).toEqual([HOME, shop]);
    expect(historyMatching([savedHere, HOME, shop], [CAFE], "shop")).toEqual([shop]);
  });
});
