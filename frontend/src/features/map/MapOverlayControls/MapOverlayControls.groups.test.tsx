/**
 * `MapOverlayControls.tsx`——「表示」の一覧が、レイヤーを源泉の群へ束ねて並べ、群をたため、群ごとに一覧に並べる項目を選べ、
 * どちらも次の訪問でも保つこと。「表示する項目を選ぶ」の「すべて」で、群の項目をまとめて選べること。
 *
 * 群・カテゴリの名前と並びはbackendの宣言（生成物）から導き、テストでも書き写さない。
 *
 * ここで見ないもの: 行・▶の内訳・行の印・ルートの行・まとめての操作 → `MapOverlayControls.test.tsx`
 */
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { categoriesOf, chip, LIST_NAME, ROAD, rowNames, setup } from "@/testing/mapOverlayControls";
import { MAP_OVERLAY_GROUP_LABELS, MAP_OVERLAY_GROUP_ORDER } from "@/features/map/layers/mapLayers";

const ROAD_LABEL = MAP_OVERLAY_GROUP_LABELS[ROAD];
const chooser = () => screen.getByRole("button", { name: `${ROAD_LABEL}の表示項目を選ぶ` });

afterEach(() => {
  window.localStorage.clear();
});

describe("群", () => {
  it("レイヤーを源泉の群へ束ね、群の並びで並べる", async () => {
    const members = MAP_OVERLAY_GROUP_ORDER.map((group) =>
      chip(`member_${group}`, { category: categoriesOf(group)[0] }),
    );
    const { list } = await setup(members.reverse());

    expect(
      within(list)
        .getAllByRole("region")
        .map((section) => section.getAttribute("aria-label")),
    ).toEqual(MAP_OVERLAY_GROUP_ORDER.map((group) => MAP_OVERLAY_GROUP_LABELS[group]));
    expect(rowNames(list)).toEqual(MAP_OVERLAY_GROUP_ORDER.map((group) => `member_${group}`));
  });

  it("群の中の行は、源泉のカテゴリの並びで並べる", async () => {
    const [first, second] = categoriesOf(ROAD);
    const { list } = await setup([chip("later", { category: second ?? first }), chip("earlier", { category: first })]);
    expect(rowNames(list)).toEqual(second ? ["earlier", "later"] : ["later", "earlier"]);
  });

  it("群の見出しを押すと中身をたたみ、もう一度押すと開く。たたんだ群は次の訪問でも保つ", async () => {
    const first = await setup([chip("member")]);
    const heading = () =>
      within(screen.getByRole("dialog", { name: LIST_NAME })).getByRole("button", { name: ROAD_LABEL });
    expect(heading()).toHaveAttribute("aria-expanded", "true");

    await first.user.click(heading());

    expect(heading()).toHaveAttribute("aria-expanded", "false");
    expect(rowNames(first.list)).toEqual([]);
    first.unmount();

    const second = await setup([chip("member")]);
    expect(rowNames(second.list)).toEqual([]);
    await second.user.click(heading());
    expect(rowNames(second.list)).toEqual(["member"]);
  });

  it("「表示する項目を選ぶ」で外した項目は一覧に並べず（地図に出していればOFFにする）、次の訪問でも保ち、並べ直してもONにはしない", async () => {
    const first = await setup([chip("kept"), chip("dropped", { on: true })]);

    await first.user.click(chooser());
    await first.user.click(screen.getByRole("checkbox", { name: "droppedを一覧に並べる" }));
    await first.user.click(chooser());

    expect(first.props.onToggle.mock.calls).toEqual([["dropped", false]]);
    expect(rowNames(first.list)).toEqual(["kept"]);
    first.unmount();

    const second = await setup([chip("kept"), chip("dropped")]);
    expect(rowNames(second.list)).toEqual(["kept"]);
    await second.user.click(chooser());
    expect(screen.getByRole("checkbox", { name: "droppedを一覧に並べる" })).not.toBeChecked();
    await second.user.click(screen.getByRole("checkbox", { name: "droppedを一覧に並べる" }));
    await second.user.click(chooser());
    expect(rowNames(second.list)).toEqual(["kept", "dropped"]);
    expect(second.props.onToggle).not.toHaveBeenCalled();
  });

  it("「表示する項目を選ぶ」の「すべて」は、1つでも外れていれば全部並べ、全部並んでいれば全部外す（外す項目のONはOFFにする）", async () => {
    const { user, props, list } = await setup([chip("shown", { on: true }), chip("off"), chip("dropped")]);
    const all = () => screen.getByRole("checkbox", { name: `${ROAD_LABEL}の項目をすべて選ぶ/外す` });

    await user.click(chooser());
    expect(all()).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "droppedを一覧に並べる" }));
    expect(all()).not.toBeChecked();
    await user.click(all());
    await user.click(chooser());
    expect(rowNames(list)).toEqual(["shown", "off", "dropped"]);
    expect(props.onToggle).not.toHaveBeenCalled();

    await user.click(chooser());
    await user.click(all());
    await user.click(chooser());
    expect(rowNames(list)).toEqual([]);
    expect(props.onToggle.mock.calls).toEqual([["shown", false]]);
  });
});
