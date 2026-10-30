/**
 * `app/page.tsx`——トップページのうち、地図に置く地点。
 *
 * 見ること: ピンを押しても消えずルート設定ではその地点を選ぶこと、閉じている間は地点の名前のあるピンだけが小窓を開き押せる見た目を
 * 持つこと、名前のある点を押して置いた地点が地図に立ち、行にその名前が出ること、地図の上端の地点の検索の欄（パネルを閉じていても
 * 出る）が詳しくの探すボタンでその地点の役割で開き、選んだ候補をその役割で地図に立てて「ルート設定」にその詳しくを見せること、
 * 探している間のブラウザの「戻る」で検索だけを閉じること、周回の間は置いた目的地を地図にも行にも出さず地図を押しても目的地にしないで、
 * 外すと戻すこと、名前を付けて保存した地点を検索の欄から選び直せ、「保存済み」の「地点」から呼び出すと条件タブへ移って置くこと。
 * 上端の欄で探すと候補を地図に番号の点で出して全部が入る所へ寄せ、点を押すとその候補を選び（デスクトップは一覧の行、スマホは下の札）、
 * 置くボタンで出発地・経由地・目的地に置くこと。
 *
 * ここで見ないもの: 地図を押したときの意味をどのパネルが決めるか・区間を押したときは`app/page.map.test.tsx`が見る。
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
  useMobileLayout,
  type User,
} from "@/testing/homePage";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
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
const KAMINARIMON = { ...SENSOJI, name: "雷門", latitude: 35.7111, longitude: 139.7964 } as const;

/** 地図に出ている、探した候補の点。 */
function candidatePoints() {
  return mapOnScreen()
    .markers()
    .filter((mark) => /^候補\d+:/.test(mark.element.getAttribute("aria-label") ?? ""));
}

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

    // 閉じている間、名前のある点は小窓を開く（地点は置かない）。ピンは押せる物に数えない（呼び名と名前は、ピンの形と地点の並びで分かる）。
    expect(screen.getByRole("group", { name: "点の小窓の上の帯" })).toBeInTheDocument();
    clickMap(ELSEWHERE);
    expect(destinationMark.style.cursor).toBe("default");
    await user.click(destinationMark);
    expect(screen.queryByRole("group", { name: /小窓の上の帯$/ })).toBeNull();
  });

  it.each([
    ["出発地", async () => screen.getByRole("button", { name: "出発地: 現在地" }), "出発地にする", "出発地: 浅草寺"],
    [
      "新しい経由地",
      async () => screen.getByRole("button", { name: "経由地を足す" }),
      "経由地に足す",
      "経由地1: 浅草寺",
    ],
    [
      "経由地1",
      async (user: User) => {
        await user.click(screen.getByRole("button", { name: "経由地を足す" }));
        clickMap(ELSEWHERE);
        return screen.getByRole("button", { name: "経由地1: 地図で選んだ地点" });
      },
      "経由地1を置き直す",
      "経由地1: 浅草寺",
    ],
    [
      "目的地",
      async (user: User) => {
        await user.click(screen.getByRole("button", { name: "周回", pressed: true }));
        return screen.getByRole("button", { name: "目的地: 未設定" });
      },
      "目的地にする",
      "目的地: 浅草寺",
    ],
  ] as const)(
    "地点の並びで%sを押し、詳しくの探すボタンを押すと上端の欄がその役割で開き、探した候補をその役割の札で地図に立てる",
    async (title, chipOf, placeLabel, placed) => {
      onBackend("GET", "/api/place-search", () => Response.json({ candidates: [SENSOJI] }));
      const { user } = renderHome();
      await user.click(await chipOf(user));

      await user.click(screen.getByRole("button", { name: `${title}を探す` }));
      const searchBox = screen.getByRole("searchbox", { name: `${title}を住所・施設で探す` });
      expect(searchBox).toHaveFocus();
      await user.type(searchBox, "浅草寺{Enter}");
      const list = await screen.findByRole("list", { name: "地点の候補" });
      await user.click(within(list).getByRole("button", { name: placeLabel }));

      expect(marksAt(SENSOJI)).toHaveLength(1);
      expect(screen.getByRole("button", { name: placed })).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "地点の候補" })).toBeNull();
    },
  );

  it("上端の欄はパネルを閉じていても出ていて、選ぶと「ルート設定」を開いて置いた地点の詳しくを見せる", async () => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [SENSOJI] }));
    const { user } = renderHome();
    await selectDestination(user);
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    expect(screen.queryByRole("region", { name: "目的地" })).toBeNull();

    await user.type(screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" }), "浅草寺{Enter}");
    await user.click(await screen.findByRole("button", { name: "目的地にする" }));

    expect(screen.getByRole("region", { name: "目的地" })).toHaveTextContent(SENSOJI.name);
  });

  it("上端の欄で探している間にブラウザの「戻る」を押すと、検索だけを閉じて打った文字を消す", async () => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [SENSOJI] }));
    const { user } = renderHome();
    await selectDestination(user);
    await user.click(screen.getByRole("button", { name: "目的地を探す" }));
    const searchBox = screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" });
    await user.type(searchBox, "浅草寺{Enter}");
    await screen.findByRole("list", { name: "地点の候補" });

    act(() => window.history.back());

    await waitFor(() => expect(screen.queryByRole("list", { name: "地点の候補" })).toBeNull());
    expect(searchBox).toHaveValue("");
    expect(searchBox).not.toHaveFocus();
    expect(screen.getByRole("region", { name: "目的地" })).toBeInTheDocument();
  });

  it("上端の欄で探すと候補を地図に番号の点で出して全部が入る所へ寄せ、点を押すと一覧のその行を選び、置くボタンで置く", async () => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [SENSOJI, KAMINARIMON] }));
    const { user } = renderHome();
    const fitsBefore = mapOnScreen().fits().length;

    await user.type(screen.getByRole("searchbox", { name: "出発地を住所・施設で探す" }), "浅草{Enter}");
    const list = await screen.findByRole("list", { name: "地点の候補" });

    expect(candidatePoints().map(({ coordinates }) => coordinates)).toEqual([
      { latitude: SENSOJI.latitude, longitude: SENSOJI.longitude },
      { latitude: KAMINARIMON.latitude, longitude: KAMINARIMON.longitude },
    ]);
    expect(candidatePoints().map(({ element }) => element.getAttribute("aria-label"))).toEqual([
      "候補1: 浅草寺",
      "候補2: 雷門",
    ]);
    expect(mapOnScreen().fits().slice(fitsBefore)).toEqual([
      expect.objectContaining({
        bounds: [
          [KAMINARIMON.longitude, KAMINARIMON.latitude],
          [SENSOJI.longitude, SENSOJI.latitude],
        ],
      }),
    ]);
    const pressed = () => candidatePoints().map(({ element }) => element.getAttribute("aria-pressed"));
    expect(pressed()).toEqual(["true", "false"]);

    await user.click(candidatePoints()[1].element);
    expect(pressed()).toEqual(["false", "true"]);
    expect(within(list).getByRole("button", { name: /雷門/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(list).getByRole("button", { name: "経由地に足す" }));

    expect(candidatePoints()).toEqual([]);
    expect(marksAt(KAMINARIMON)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "経由地1: 雷門" })).toBeInTheDocument();
  });

  it("スマホで探すと、シートを開いていれば札をシートの地点の並びの下に、閉じていれば地図の下に出し、札を送ると札の候補の点を強調し、点を押すとその札へ送り、札の地点の並びで置いてもシートの開き閉じを変えない", async () => {
    useMobileLayout();
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [SENSOJI, KAMINARIMON] }));
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    await user.click(screen.getByRole("button", { name: "周回", pressed: true }));

    await user.type(screen.getByRole("searchbox", { name: "出発地を住所・施設で探す" }), "浅草{Enter}");
    const sheet = screen.getByRole("dialog", { name: "ルート設定" });
    const card = await within(sheet).findByRole("region", { name: "探した候補" });
    const pressed = () => candidatePoints().map(({ element }) => element.getAttribute("aria-pressed"));
    expect(card).toHaveTextContent("1 / 2: 浅草寺");
    expect(pressed()).toEqual(["true", "false"]);

    await user.click(within(card).getByRole("button", { name: "次の候補" }));
    expect(pressed()).toEqual(["false", "true"]);
    await user.click(candidatePoints()[0].element);
    expect(card).toHaveTextContent("1 / 2: 浅草寺");

    await user.click(within(card).getByRole("button", { name: "目的地にする" }));
    expect(candidatePoints()).toEqual([]);
    expect(marksAt(SENSOJI)).toHaveLength(1);
    expect(within(sheet).getByRole("button", { name: "目的地: 浅草寺" })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(sheet).getByRole("button", { name: "閉じる" }));
    await user.type(screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" }), "雷門{Enter}");
    const floating = await screen.findByRole("region", { name: "探した候補" });
    expect(screen.queryByRole("dialog", { name: "ルート設定" })).toBeNull();
    await user.click(within(floating).getByRole("button", { name: "経由地に足す" }));
    expect(screen.queryByRole("dialog", { name: "ルート設定" })).toBeNull();
    expect(marksAt(SENSOJI)).toHaveLength(2);
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

  it("名前を付けて保存した地点は、目的地を消したあとも探すボタンから選び直せ、「保存済み」の「地点」から呼び出すと条件タブへ移って置く", async () => {
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

    await user.click(screen.getByRole("button", { name: "目的地を探す" }));
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
