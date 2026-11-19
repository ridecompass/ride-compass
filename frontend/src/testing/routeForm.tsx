// 「ルート設定」区分の各タブの中身（`features/route/RouteForm/RouteForm.tsx`）を描いて操る足場。生成の条件とほかの props の既定を置き、
// 選んでいる地点と地点の検索の欄の中身を持つ親の代わりと`Tabs`で包んで描き、上げた操作を受け取る関数と、タブ・地図の真ん中を
// 変えて描き直す関数を返す。タブの中身を描くには`Tabs`の中に置く必要があるので、囲む側の代わりに`Tabs`で包む。
// 保存した地点を渡さなければ本物の置き場（この端末の保存）を通すので、保存した地点・検索の履歴を見るテストは`beforeEach`で
// `window.localStorage.clear()`を呼ぶ。
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps, type ReactNode } from "react";
import { vi } from "vitest";

import { Tabs } from "@/components/ui/Tabs/Tabs";
import { usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { useSavedPlaces } from "@/features/route/useSavedPlaces";
import RouteForm, { type SettingsTab } from "@/features/route/RouteForm/RouteForm";
import type { Coordinates, PointTarget } from "@/types/route";

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
  distanceTargeted: true,
  waypoints: [],
  destination: null,
  origin: ORIGIN,
  originManual: false,
  originLocated: true,
  originAtHere: true,
  selectedPoint: { role: "origin" },
  here: ORIGIN,
  isMobile: false,
  placing: true,
  foundAt: () => null,
  originFound: null,
  weightsPanel: null,
  exclusionsPanel: null,
  saveConditionsButton: null,
  savedConditionsPanel: null,
} satisfies Options;

/** 置いた経由地（地点は並べるだけ）。 */
export function waypointsOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({ latitude: 35 + i * 0.01, longitude: 139 }));
}

/** 選んでいる地点・地点の検索の欄の中身・保存した地点を持つ親の代わり（選ぶと上げ、その地点を選んだことにして描き直す）。 */
function Selecting({
  initial,
  onSelect,
  mapCenter,
  children,
}: {
  initial: PointTarget;
  onSelect: (target: PointTarget) => void;
  mapCenter: Coordinates;
  children: (
    selected: PointTarget,
    select: (target: PointTarget) => void,
    lookup: ReturnType<typeof usePlaceLookup>,
    savedPlaces: Props["savedPlaces"],
  ) => ReactNode;
}) {
  const [selected, setSelected] = useState(initial);
  const lookup = usePlaceLookup(mapCenter);
  const savedPlaces = useSavedPlaces();
  return children(
    selected,
    (target) => {
      setSelected(target);
      onSelect(target);
    },
    lookup,
    savedPlaces,
  );
}

export function renderForm(options: Options = {}, tab: SettingsTab = "generate", mapCenter: Coordinates = ORIGIN) {
  const handlers = {
    setDistanceInput: vi.fn(),
    setDistanceTargeted: vi.fn(),
    setLoop: vi.fn(),
    removeWaypoint: vi.fn(),
    reorderPoints: vi.fn(),
    clearDestination: vi.fn(),
    onOriginReset: vi.fn(),
    selectPoint: vi.fn(),
    onPlaceFound: vi.fn(),
    onPlace: vi.fn(),
  };
  const element = (nextTab: SettingsTab, center: Coordinates) => {
    const {
      origin,
      originManual,
      originLocated,
      originAtHere,
      onOriginReset,
      originFound,
      onPlace,
      onPlaceFound,
      weightsPanel,
      exclusionsPanel,
      saveConditionsButton,
      savedConditionsPanel,
      savedPlaces,
      here,
      isMobile,
      placing,
      selectedPoint,
      selectPoint,
      ...conditions
    } = {
      ...BASE,
      ...handlers,
      ...options,
    };
    return (
      <Selecting initial={selectedPoint} onSelect={selectPoint} mapCenter={center}>
        {(selected, select, lookup, storedPlaces) => (
          <Tabs value={nextTab}>
            <RouteForm
              conditions={{ ...conditions, selectedPoint: selected, selectPoint: select }}
              origin={origin}
              originManual={originManual}
              originLocated={originLocated}
              originAtHere={originAtHere}
              originAsks={0}
              originRowRef={{ current: null }}
              onOriginReset={onOriginReset}
              originFound={originFound}
              here={here}
              lookup={lookup}
              onPlace={onPlace}
              onPlaceFound={onPlaceFound}
              savedPlaces={savedPlaces ?? storedPlaces}
              isMobile={isMobile}
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
  let shown = { tab, center: mapCenter };
  const view = render(element(tab, mapCenter));
  const show = (next: Partial<typeof shown>) => {
    shown = { ...shown, ...next };
    view.rerender(element(shown.tab, shown.center));
  };
  return {
    ...handlers,
    showTab: (nextTab: SettingsTab) => show({ tab: nextTab }),
    moveMap: (center: Coordinates) => show({ center }),
  };
}

/** 消す・現在地に戻す等のボタン。 */
export function button(name: string) {
  return screen.getByRole("button", { name });
}

/** 地点の一覧（通る順）の行の、押すと検索の小窓を開く所の名前（「出発地 現在地」「目的地 未設定」等）。 */
export function pointRows() {
  return within(screen.getByRole("list", { name: "通る順" }))
    .getAllByRole("button")
    .filter((row) => row.hasAttribute("aria-pressed"))
    .map((row) => row.getAttribute("aria-label") ?? row.textContent);
}

/** 地点の行を押して、その地点を探す小窓を開いて返す。 */
export async function openPointSearch(row: string, title = row.split(" ")[0]) {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(`^${row}( |$)`) }));
  return screen.getByRole("dialog", { name: `${title}を探す` });
}
