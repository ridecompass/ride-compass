// 地図の「表示」の一覧（`features/map/MapOverlayControls/MapOverlayControls.tsx`）を描いて開き、行を読む道具。
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import MapOverlayControls from "@/features/map/MapOverlayControls/MapOverlayControls";
import type { OverlayLayerChip } from "@/features/map/MapOverlayControls/OverlayLayerRow";
import {
  MAP_LAYER_CATEGORY_ORDER,
  MAP_OVERLAY_GROUP_ORDER,
  mapOverlayGroupFor,
  type MapLayerCategory,
  type MapLayerId,
  type MapOverlayGroup,
} from "@/features/map/layers/mapLayers";

const TestIcon = () => <svg />;
export const LIST_NAME = "地図に出す情報";

/** 群ごとの、源泉の並びのカテゴリ。 */
export function categoriesOf(group: MapOverlayGroup): MapLayerCategory[] {
  return MAP_LAYER_CATEGORY_ORDER.filter((category) => mapOverlayGroupFor({ category }) === group);
}
export const [ROAD] = MAP_OVERLAY_GROUP_ORDER;

/** 1件のレイヤー。既定では道路の群の1件目のカテゴリに属する。 */
export function chip(id: string, overrides: Partial<OverlayLayerChip> = {}): OverlayLayerChip {
  return { id: id as MapLayerId, icon: TestIcon, label: id, on: false, category: categoriesOf(ROAD)[0], ...overrides };
}

type Overrides = { anyLegendHidden?: boolean; route?: { shown: boolean; selectable: boolean } };

export function propsOf(
  layers: OverlayLayerChip[],
  { route = { shown: true, selectable: true }, ...overrides }: Overrides = {},
) {
  return {
    layers,
    route: { ...route, onChange: vi.fn() },
    onToggle: vi.fn(),
    onLegendEntryToggle: vi.fn(),
    onLegendAxisSetHidden: vi.fn(),
    onHideAllLayers: vi.fn(),
    anyLegendHidden: false,
    onShowAllLegendRows: vi.fn(),
    ...overrides,
  };
}

/** 描いて「表示」のボタンを押し、一覧を開く。 */
export async function setup(layers: OverlayLayerChip[], overrides: Overrides = {}) {
  const props = propsOf(layers, overrides);
  const user = userEvent.setup();
  const view = render(<MapOverlayControls {...props} />);
  await user.click(screen.getByRole("button", { name: LIST_NAME }));
  return { user, props, list: screen.getByRole("dialog", { name: LIST_NAME }), ...view };
}

/** 群の外の先頭にある、ルートの行のチェックボックスの名前。 */
export const ROUTE_ROW = "ルート";

/** 群に並んでいるレイヤーの行の名前（行のチェックボックスの名前）。 */
export const rowNames = (list: HTMLElement) =>
  within(list)
    .queryAllByRole("checkbox")
    .map((box) => box.getAttribute("aria-label"))
    .filter((name) => name !== ROUTE_ROW);
