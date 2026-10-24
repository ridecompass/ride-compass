/**
 * `app/page.tsx`——トップページのうち、地図に置く地点。
 *
 * 見ること: ピンを押しても消えずルート設定ではその地点を選ぶこと、閉じている間は地点の名前のあるピンだけが小窓を開き押せる見た目を
 * 持つこと、目的地の行で探して置いた地点と、名前のある点を押して置いた地点が地図に立ち、行にその名前が出ること、周回の間は置いた目的地を地図にも行にも出さず地図を押しても目的地にしないで、
 * 外すと戻すこと、名前を付けて保存した地点を打つ欄から選び直せ、「保存済み」の「地点」から呼び出すと条件タブへ移って置くこと。
 *
 * ここで見ないもの: 地図を押したときの意味をどのパネルが決めるか・区間を押したときは`app/page.map.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { screen, within } from "@testing-library/react";
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
} from "@/testing/homePage";
import type { PointedFeature } from "@/testing/maplibre";
import type { Coordinates } from "@/types/route";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

beforeEach(() => {
  serveHome();
});

describe("地図に置く地点", () => {
  it("ピンを押しただけでは消えず、ルート設定ではその地点を選んで詳しくを出し、閉じている間は呼び名しか無いピンは小窓を開かず押せる見た目にもしない", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);
    await user.click(screen.getByRole("button", { name: "出発地: 現在地" }));

    const [destinationPin] = marksAt(DESTINATION);
    await user.click(destinationPin.element);
    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByRole("region", { name: "目的地" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    await user.click(destinationPin.element);
    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.queryByText(/目的地:/)).toBeNull();
    expect(destinationPin.element.style.cursor).toBe("default");
  });

  it("名前のある点を押すと、選んでいる地点をその点へその名前で置き、地図と地点の並びに出す。閉じている間は置かない", async () => {
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
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩ポイント" }));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "経由地を足す" }));
    // 押した所は絵の端でも、点そのものの位置へ置く。
    clickMap(ELSEWHERE, pointed);
    expect(marksAt(shop)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "経由地1: 角の店" })).toBeInTheDocument();

    await selectDestination(user);
    clickMap(shop, pointed);
    expect(marksAt(shop)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "目的地: 角の店" })).toBeInTheDocument();
    // 地図の印は役割の名前で見分けられ、地点の並びの印と同じ記号を描く。
    const [waypointMark, destinationMark] = marksAt(shop).map(({ element }) => element);
    expect(waypointMark).toHaveAccessibleName("経由地 1");
    expect(destinationMark).toHaveAccessibleName("目的地");
    expect(screen.getByRole("img", { name: "出発地" })).toBeInTheDocument();
    const listedDestination = screen.getByRole("button", { name: "目的地: 角の店" }).querySelector("svg");
    // 大きさは置き場ごとに違うので、記号の中身で比べる。
    expect(listedDestination?.innerHTML).toBeTruthy();
    expect(destinationMark.querySelector("svg")?.innerHTML).toBe(listedDestination?.innerHTML);

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    clickMap(ELSEWHERE, pointed);
    expect(marksAt(shop)).toHaveLength(2);

    // 閉じている間、地点の名前のあるピンは押すと呼び名と名前を小窓に出す。
    expect(destinationMark.style.cursor).toBe("pointer");
    await user.click(destinationMark);
    expect(screen.getByText("目的地: 角の店")).toBeInTheDocument();
  });

  it("目的地を探して選んだ地点は地図に目的地として立ち、地点の並びにその名前が出る", async () => {
    const candidate = {
      kind: "facility",
      level: "point",
      name: "浅草寺",
      area: "台東区浅草二丁目",
      latitude: 35.7148,
      longitude: 139.7967,
    } as const;
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [candidate] }));
    const { user } = renderHome();
    await selectDestination(user);
    const searchBox = screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" });

    await user.type(searchBox, "浅草寺{Enter}");
    await user.click(await screen.findByRole("button", { name: new RegExp(candidate.name) }));

    expect(marksAt(candidate)).toHaveLength(1);
    expect(screen.getByRole("button", { name: `目的地: ${candidate.name}` })).toBeInTheDocument();
  });

  it("周回にすると置いた目的地を地図にも地点の並びにも出さず、地図を押しても目的地にせず、周回を外すとその目的地が戻る", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);

    await user.click(screen.getByRole("button", { name: "周回", pressed: false }));
    expect(marksAt(DESTINATION)).toEqual([]);
    expect(screen.getByText("終点: 現在地[周回]")).toBeInTheDocument();
    clickMap(ELSEWHERE);
    expect(screen.getByText("終点: 地図で選んだ地点[周回]")).toBeInTheDocument();
    expect(marksAt(DESTINATION)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "周回", pressed: true }));
    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "目的地: 地図で選んだ地点" })).toBeInTheDocument();
  });

  it("名前を付けて保存した地点は、目的地を消したあとも打つ欄を押して選び直せ、「保存済み」の「地点」から呼び出すと条件タブへ移って置く", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);
    await user.click(screen.getByRole("button", { name: "地点を保存" }));
    const dialog = screen.getByRole("dialog", { name: "地点を保存" });
    const nameInput = within(dialog).getByRole("textbox", { name: "保存する地点の名前" });
    await user.clear(nameInput);
    await user.type(nameInput, "いつものカフェ");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("button", { name: "目的地を消す" }));
    expect(marksAt(DESTINATION)).toEqual([]);

    await user.click(screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" }));
    const saved = screen.getByRole("list", { name: "保存した地点" });
    await user.click(within(saved).getByRole("button", { name: /いつものカフェ/ }));

    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "目的地: いつものカフェ" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "保存済み" }));
    await user.click(screen.getByRole("tab", { name: "地点" }));
    await user.click(screen.getByRole("button", { name: "「いつものカフェ」を呼び出す" }));
    const menu = screen.getByRole("dialog", { name: "「いつものカフェ」をどこに置くか" });
    await user.click(within(menu).getByRole("button", { name: "経由地に足す" }));

    expect(screen.getByRole("tab", { name: "条件" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "経由地1" })).toHaveTextContent("いつものカフェ");
    expect(marksAt(DESTINATION)).toHaveLength(2);
  });
});
