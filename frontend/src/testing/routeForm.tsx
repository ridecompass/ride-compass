// 「ルート設定」区分の各タブの中身（`features/route/RouteForm/RouteForm.tsx`）を描いて操る足場。生成の条件とほかの props の既定を置き、
// 選んでいる地点を持つ親の代わりと`Tabs`で包んで描き、上げた操作を受け取る関数と、条件やタブを変えて描き直す関数を返す。
// タブの中身を描くには`Tabs`の中に置く必要があるので、囲む側の代わりに`Tabs`で包む。
import { render, screen, within } from "@testing-library/react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { vi } from "vitest";

import { Tabs } from "@/components/ui/Tabs/Tabs";
import RouteForm, { type SettingsTab } from "@/features/route/RouteForm/RouteForm";
import type { PointTarget } from "@/types/route";

type Props = ComponentProps<typeof RouteForm>;
/** 部品へ渡す値。生成の条件の欄（`conditions`）とほかの props を並べて渡し、`renderForm` が分ける。 */
type Options = Partial<Props["conditions"]> & Partial<Omit<Props, "conditions">>;

/** 出発地の位置（現在地）。 */
export const ORIGIN = { latitude: 35.75, longitude: 139.73 };

/** 置いた目的地。 */
export const DESTINATION = { latitude: 35.1, longitude: 139.1 };

/** コールバック以外の既定。見たい値はテストが渡す。 */
const BASE = {
  loop: false,
  distanceInput: "30",
  maxRoutesInput: "8",
  distanceTargeted: true,
  waypoints: [],
  destination: null,
  origin: ORIGIN,
  originManual: false,
  originLocated: true,
  originAtHere: true,
  selectedPoint: { role: "origin" },
  placing: false,
  foundAt: () => null,
  originFound: null,
  mapCenter: { latitude: 35.681, longitude: 139.767 },
  weightsPanel: null,
  exclusionsPanel: null,
  saveConditionsButton: null,
  savedConditionsPanel: null,
  savedPlaces: { places: [], save: () => {}, remove: () => {} },
} satisfies Options;

/** 置いた経由地（地点は並べるだけ）。 */
export function waypointsOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({ latitude: 35 + i * 0.01, longitude: 139 }));
}

/** 選んでいる地点を持つ親の代わり（選ぶと上げ、その地点の詳しくを出し直す）。 */
function Selecting({
  initial,
  onSelect,
  children,
}: {
  initial: PointTarget;
  onSelect: (target: PointTarget) => void;
  children: (selected: PointTarget, select: (target: PointTarget) => void) => ReactNode;
}) {
  const [selected, setSelected] = useState(initial);
  return children(selected, (target) => {
    setSelected(target);
    onSelect(target);
  });
}

export function renderForm(options: Options = {}, tab: SettingsTab = "generate") {
  const handlers = {
    setDistanceInput: vi.fn(),
    setMaxRoutesInput: vi.fn(),
    setDistanceTargeted: vi.fn(),
    setLoop: vi.fn(),
    removeWaypoint: vi.fn(),
    clearDestination: vi.fn(),
    clearPoints: vi.fn(),
    onOriginReset: vi.fn(),
    selectPoint: vi.fn(),
    onPlaceFound: vi.fn(),
    onPointsShow: vi.fn(),
  };
  const element = (nextTab: SettingsTab, changed: Options = {}) => {
    const {
      origin,
      originManual,
      originLocated,
      originAtHere,
      onOriginReset,
      originFound,
      mapCenter,
      onPlaceFound,
      onPointsShow,
      weightsPanel,
      exclusionsPanel,
      saveConditionsButton,
      savedConditionsPanel,
      savedPlaces,
      placing,
      selectedPoint,
      selectPoint,
      ...conditions
    } = {
      ...BASE,
      ...handlers,
      ...options,
      ...changed,
    };
    return (
      <Selecting initial={selectedPoint} onSelect={selectPoint}>
        {(selected, select) => (
          <Tabs value={nextTab}>
            <RouteForm
              conditions={{ ...conditions, selectedPoint: selected, selectPoint: select }}
              origin={origin}
              originManual={originManual}
              originLocated={originLocated}
              originAtHere={originAtHere}
              onOriginReset={onOriginReset}
              originFound={originFound}
              mapCenter={mapCenter}
              onPlaceFound={onPlaceFound}
              onPointsShow={onPointsShow}
              savedPlaces={savedPlaces}
              placing={placing}
              weightsPanel={weightsPanel}
              exclusionsPanel={exclusionsPanel}
              saveConditionsButton={saveConditionsButton}
              savedConditionsPanel={savedConditionsPanel}
            />
          </Tabs>
        )}
      </Selecting>
    );
  };
  const view = render(element(tab));
  return {
    ...handlers,
    showTab: (nextTab: SettingsTab) => view.rerender(element(nextTab)),
  };
}

/** 消す・現在地に戻す等のボタン。 */
export function button(name: string) {
  return screen.getByRole("button", { name });
}

/** 押した地点の詳しく（呼び名・出どころ・名前・打つ欄・操作）。 */
export function detail(title: string) {
  return screen.getByRole("region", { name: title });
}

/** 詳しくの打つ欄。 */
export function pointBox(title: string) {
  return screen.getByRole("searchbox", { name: `${title}を住所・施設で探す` });
}

/** 地点の並び（出発地 › 経由地の番号の丸 ＋ › 目的地）の、押せるものの名前。 */
export function strip() {
  return within(screen.getByRole("group", { name: "地点の並び" }))
    .getAllByRole("button")
    .map((chip) => chip.getAttribute("aria-label"));
}
