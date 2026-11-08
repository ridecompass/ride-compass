/**
 * `RoadInspectorPopup.tsx`——開いている間に利用者の値・走行の条件が変わったとき、押した道の負担を取り直すか、前の負担を
 * 出し続けるか。
 *
 * ここで見ないもの: 負担と事実の中身の出し方 → `RoadInspectorPopup.test.tsx`
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { inspectorResult, RIDE, serveInspector } from "@/testing/roadInspector";
import RoadInspectorPopup from "./RoadInspectorPopup";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";

const props = {
  properties: { osm_way_id: 1, feature_key: "1" },
  track: null,
  ...RIDE,
};

/** 既定の応答（道の向きの合計が12秒）が出たときの合計の文。 */
const SHOWN = "+12秒";

describe("負担の利用者の値", () => {
  it("つまみや倍率を変えたら、前の値で取った負担を見せずに取り直す", async () => {
    serveInspector(inspectorResult());
    const { rerender } = render(<RoadInspectorPopup {...props} />);
    await screen.findByText(SHOWN);

    rerender(<RoadInspectorPopup {...props} costPreference={{ ...STANDARD_COST_PREFERENCE, strength: 2 }} />);

    expect(screen.queryByText(SHOWN)).not.toBeInTheDocument();
    expect(await screen.findByText(SHOWN)).toBeInTheDocument();
  });
});

describe("負担の走行の条件", () => {
  const CONDITIONS = RIDE.conditions;

  it("開いている間に出発時刻が進んでも、開いたときの条件で取った負担を出し続ける", async () => {
    serveInspector(inspectorResult());
    const { rerender } = render(<RoadInspectorPopup {...props} conditions={CONDITIONS} />);
    await screen.findByText(SHOWN);

    rerender(<RoadInspectorPopup {...props} conditions={{ ...CONDITIONS, at: new Date("2026-09-24T00:05:00Z") }} />);

    expect(screen.getByText(SHOWN)).toBeInTheDocument();
  });

  it("同じ道を同じ条件・利用者の値で開き直したときは、取り直さずに前の負担を出す", async () => {
    serveInspector(inspectorResult());
    const first = render(<RoadInspectorPopup {...props} conditions={CONDITIONS} />);
    await screen.findByText(SHOWN);
    first.unmount();

    render(<RoadInspectorPopup {...props} conditions={{ ...CONDITIONS }} />);

    expect(screen.getByText(SHOWN)).toBeInTheDocument();
  });
});
