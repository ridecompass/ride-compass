import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { getQueryClient } from "@/lib/queryClient";
import { serveAxisCatalog } from "@/testing/backendServer";
import { catalogResponse, dedicatedEntry } from "@/testing/catalogAxes";

import { WAY_BEARING_STEP_DEG } from "../mapHeading";
import MapNavigationControl from "./MapNavigationControl";

describe("MapNavigationControl 地図の向きの説明", () => {
  it("向きで値の変わる評価があれば、その名前と、走る向きを丸める刻みを書く", async () => {
    serveAxisCatalog(
      catalogResponse([dedicatedEntry("a", [1], { label: "評価A", dynamic_way_value_conditions: ["bearing_deg"] })]),
    );
    render(
      <MapNavigationControl
        bearing={0}
        onZoomIn={vi.fn()}
        onZoomOut={vi.fn()}
        onBearingChange={vi.fn()}
        onResetNorth={vi.fn()}
        linked={false}
        ride={null}
      />,
    );
    await waitFor(() => expect(getQueryClient().isFetching()).toBe(0));
    await userEvent.click(screen.getByRole("button", { name: "地図の向き" }));
    await userEvent.click(await screen.findByRole("button", { name: "地図の向きの使い方を表示" }));

    expect(
      await screen.findByText(
        new RegExp(`「評価A」で周りの道を塗るときと.*地図の上の向きを${WAY_BEARING_STEP_DEG}°刻みに丸めた向きです。`),
      ),
    ).toBeInTheDocument();
  });
});
