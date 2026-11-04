/**
 * `RoadInspectorPopup.tsx`——開いている間に重み・走行の条件が変わったとき、押した道の評価を取り直すか、前の評価を出し続けるか。
 *
 * ここで見ないもの: 評価と事実の中身の出し方 → `RoadInspectorPopup.test.tsx`
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AXES, AXIS_COLORS, inspectorResult, openEvaluation, RIDE, serveInspector } from "@/testing/roadInspector";
import RoadInspectorPopup from "./RoadInspectorPopup";

const props = {
  properties: { osm_way_id: 1, feature_key: "1" },
  track: null,
  axes: AXES,
  axisColors: AXIS_COLORS,
  ...RIDE,
};

describe("評価の利用者の値", () => {
  it("つまみや倍率を変えたら、前の値で取った評価を見せずに取り直しへ戻る", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult());
    const { rerender } = render(<RoadInspectorPopup {...props} />);
    await openEvaluation(user);
    await screen.findByRole("region", { name: "難易度" });

    rerender(<RoadInspectorPopup {...props} costPreference={{ strength: 2, multipliers: {} }} />);

    expect(screen.queryByRole("region", { name: "難易度" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "この道の評価を見る" })).toBeInTheDocument();
  });
});

describe("評価の走行の条件", () => {
  const CONDITIONS = RIDE.conditions;

  it("開いている間に出発時刻が進んでも、押したときの条件で取った評価を出し続ける", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult());
    const { rerender } = render(<RoadInspectorPopup {...props} conditions={CONDITIONS} />);
    await openEvaluation(user);
    await screen.findByRole("region", { name: "難易度" });

    rerender(<RoadInspectorPopup {...props} conditions={{ ...CONDITIONS, at: new Date("2026-09-24T00:05:00Z") }} />);

    expect(screen.getByRole("region", { name: "難易度" })).toBeInTheDocument();
  });

  it("同じ道を同じ条件・利用者の値で開き直したときは、取り直さずに前の評価を出す", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult());
    const first = render(<RoadInspectorPopup {...props} conditions={CONDITIONS} />);
    await openEvaluation(user);
    await screen.findByRole("region", { name: "難易度" });
    first.unmount();

    render(<RoadInspectorPopup {...props} conditions={{ ...CONDITIONS }} />);

    expect(screen.getByRole("region", { name: "難易度" })).toBeInTheDocument();
  });
});
