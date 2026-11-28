/**
 * `app/page.tsx`——トップページのうち、地図に置く地点。
 *
 * 見ること: ピンを押しても消えずルート設定ではその地点を選ぶこと、閉じている間は地点の名前のあるピンだけが小窓を開き押せる見た目を
 * 持つこと、名前のある点を押して置いた地点が地図に立ち、行にその名前が出ること、地点の行を押して開く小窓で探した候補をその役割で
 * 地図に立てること、小窓を開いている間のブラウザの「戻る」で小窓だけを閉じること、周回の間は置いた目的地を地図にも行にも出さず
 * 地図を押しても目的地にしないで、外すと戻すこと、保存した地点を小窓から選び直せ、「保存」の「地点」から呼び出すと条件タブへ
 * 移って置くこと。
 *
 * ここで見ないもの: 地図を押したときの意味をどのパネルが決めるか・区間を押したときは`app/page.map.test.tsx`が見る。小窓を開いたまま
 * 地図を押すと閉じるだけで置かないことは、小窓が外の押下を止めるのがブラウザの当たり判定なので`e2e/destination.spec.ts`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POINT_TILE_SOURCES } from "@/features/map/scene/groups/points";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import { onBackend } from "@/testing/backendServer";
import {
  DESTINATION,
  ELSEWHERE,
  clickMap,
  marksAt,
  renderHome,
  selectDestination,
  serveHome,
  type User,
} from "@/testing/homePage";
import { type PointedFeature } from "@/testing/maplibre";
import type { Coordinates } from "@/types/route";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

beforeEach(() => {
  serveHome();
});

const SENSOJI = {
  kind: "facility",
  level: "point",
  name: "浅草寺",
  area: "台東区浅草二丁目",
  latitude: 35.7148,
  longitude: 139.7967,
} as const;

/** 「＋ 経由地」で足す行を出す（小窓は開かない）。 */
async function addWaypointRow(user: User) {
  await user.click(screen.getByRole("button", { name: "＋ 経由地" }));
}

/** 小窓で浅草寺を探し、候補の一覧を返す。 */
async function searchSensoji(user: User, title: string) {
  await user.type(screen.getByRole("searchbox", { name: `${title}を住所・施設で探す` }), "浅草寺{Enter}");
  return screen.findByRole("list", { name: "地点の候補" });
}

describe("地図に置く地点", () => {
  it("ピンを押しただけでは消えず、ルート設定ではその地点を選び、閉じている間は呼び名しか無いピンは小窓を開かず押せる見た目にもしない", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);
    await user.click(screen.getByRole("button", { name: "出発地 現在地" }));
    await user.keyboard("{Escape}");

    const [destinationPin] = marksAt(DESTINATION);
    await user.click(destinationPin.element);
    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "目的地 地図で選んだ地点" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    await user.click(destinationPin.element);
    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.queryByRole("group", { name: /小窓の上の帯$/ })).toBeNull();
    expect(destinationPin.element.style.cursor).toBe("default");
  });

  it("名前のある点を押すと、選んでいる地点をその点へその名前で置き、地図と地点の行に出す。閉じている間は置かない", async () => {
    const shop: Coordinates = { latitude: 35.71, longitude: 139.71 };
    const pointed = [
      {
        layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
        properties: { name: "角の店", kind: "convenience" },
        geometry: { type: "Point", coordinates: [shop.longitude, shop.latitude] },
      } satisfies PointedFeature,
    ];
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩" }));
    await user.keyboard("{Escape}");

    await addWaypointRow(user);
    // 押した所は絵の端でも、点そのものの位置へ置く。
    clickMap(ELSEWHERE, pointed);
    expect(marksAt(shop)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "経由地1 角の店" })).toBeInTheDocument();

    await selectDestination(user);
    clickMap(shop, pointed);
    expect(marksAt(shop)).toHaveLength(2);
    // 地図の印は役割の名前で見分けられ、地点の行の印と同じ記号を描く。
    const [waypointMark, destinationMark] = marksAt(shop).map(({ element }) => element);
    expect(waypointMark).toHaveAccessibleName("経由地1");
    expect(destinationMark).toHaveAccessibleName("目的地");
    expect(screen.getByRole("img", { name: "出発地" })).toBeInTheDocument();
    const listedDestination = screen.getByRole("button", { name: "目的地 角の店" }).closest("li")?.querySelector("svg");
    // 大きさは置き場ごとに違うので、記号の中身で比べる。
    expect(listedDestination?.innerHTML).toBeTruthy();
    expect(destinationMark.querySelector("svg")?.innerHTML).toBe(listedDestination?.innerHTML);

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    clickMap(ELSEWHERE, pointed);
    expect(marksAt(shop)).toHaveLength(2);

    // 閉じている間、名前のある点は小窓を開く（地点は置かない）。ピンは押せる物に数えない（呼び名と名前は、ピンの形と地点の行で分かる）。
    expect(screen.getByRole("group", { name: "点の小窓の上の帯" })).toBeInTheDocument();
    clickMap(ELSEWHERE);
    expect(destinationMark.style.cursor).toBe("default");
    await user.click(destinationMark);
    expect(screen.queryByRole("group", { name: /小窓の上の帯$/ })).toBeNull();
  });

  it.each([
    [
      "出発地",
      async (user: User) => user.click(screen.getByRole("button", { name: "出発地 現在地" })),
      "出発地 浅草寺",
    ],
    [
      "新しい経由地",
      async (user: User) => {
        await addWaypointRow(user);
        await user.click(screen.getByRole("button", { name: "新しい経由地 未設定" }));
      },
      "経由地1 浅草寺",
    ],
    [
      "経由地1",
      async (user: User) => {
        await addWaypointRow(user);
        clickMap(ELSEWHERE);
        await user.click(screen.getByRole("button", { name: "経由地1 地図で選んだ地点" }));
      },
      "経由地1 浅草寺",
    ],
    [
      "目的地",
      async (user: User) => {
        await user.click(screen.getByRole("radio", { name: "目的地" }));
        await user.click(screen.getByRole("button", { name: "目的地 未設定" }));
      },
      "目的地 浅草寺",
    ],
  ] as const)(
    "%sの行を押して開く小窓で探した候補を選ぶと、その役割で地図に立てて小窓を閉じる",
    async (title, open, placed) => {
      onBackend("GET", "/api/place-search", () => Response.json({ candidates: [SENSOJI] }));
      const { user } = renderHome();
      await open(user);

      const list = await searchSensoji(user, title);
      await user.click(within(list).getByRole("button", { name: /^浅草寺/ }));

      expect(marksAt(SENSOJI)).toHaveLength(1);
      expect(screen.getByRole("button", { name: placed })).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: `${title}を探す` })).toBeNull();
    },
  );

  it("小窓を開いている間にブラウザの「戻る」を押すと、小窓だけを閉じて打った文字を消す", async () => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [SENSOJI] }));
    const { user } = renderHome();
    await user.click(screen.getByRole("radio", { name: "目的地" }));
    await user.click(screen.getByRole("button", { name: "目的地 未設定" }));
    await searchSensoji(user, "目的地");

    act(() => window.history.back());

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "目的地を探す" })).toBeNull());
    expect(screen.getByRole("button", { name: "目的地 未設定" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "目的地 未設定" }));
    expect(screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" })).toHaveValue("");
  });

  it("周回にすると置いた目的地を地図にも地点の行にも出さず、地図を押しても目的地にせず、周回を外すとその目的地が戻る", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);

    await user.click(screen.getByRole("radio", { name: "周回" }));
    expect(marksAt(DESTINATION)).toEqual([]);
    expect(screen.queryByRole("button", { name: /^目的地 / })).toBeNull();
    expect(screen.getByText("出発地へ戻る")).toBeInTheDocument();
    clickMap(ELSEWHERE);
    expect(screen.getByRole("button", { name: "出発地 地図で選んだ地点" })).toBeInTheDocument();
    expect(marksAt(DESTINATION)).toEqual([]);

    await user.click(screen.getByRole("radio", { name: "目的地" }));
    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "目的地 地図で選んだ地点" })).toBeInTheDocument();
  });

  it("候補の☆で保存した地点は、目的地を消したあとも小窓から選び直せ、「保存」の「地点」から呼び出すと条件タブへ移って置く", async () => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [SENSOJI] }));
    const { user } = renderHome();
    await user.click(screen.getByRole("radio", { name: "目的地" }));
    await user.click(screen.getByRole("button", { name: "目的地 未設定" }));
    const list = await searchSensoji(user, "目的地");
    await user.click(within(list).getByRole("button", { name: "「浅草寺」を保存" }));
    await user.click(within(list).getByRole("button", { name: /^浅草寺/ }));
    await user.click(screen.getByRole("button", { name: "目的地を消す" }));
    expect(marksAt(SENSOJI)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "目的地 未設定" }));
    const saved = screen.getByRole("list", { name: "保存した地点" });
    await user.click(within(saved).getByRole("button", { name: /^浅草寺/ }));

    expect(marksAt(SENSOJI)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "目的地 浅草寺" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "保存" }));
    await user.click(screen.getByRole("tab", { name: "地点" }));
    await user.click(screen.getByRole("button", { name: "「浅草寺」を呼び出す" }));
    const menu = screen.getByRole("dialog", { name: "「浅草寺」をどこに置くか" });
    await user.click(within(menu).getByRole("button", { name: "経由地に足す" }));

    expect(screen.getByRole("tab", { name: "基本" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "経由地1 浅草寺" })).toBeInTheDocument();
    expect(marksAt(SENSOJI)).toHaveLength(2);
  });
});
