/**
 * 曲がる所のカード（`features/ride/TurnCard/TurnCard.tsx`）——走行モードの間、次に曲がる所の向きの矢印とそこまでの距離を
 * 出す。文字の札（「右折」等）は出さず、向きは読み上げの名前で伝える。
 *
 * ここで見ないもの: どの曲がる所を出すか → `nextTurn.test.ts`。距離の丸めと単位の境目 → `lib/geoDistance.test.ts`。走行中のページに出ること → `app/page.ride.test.tsx`
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import TurnCard from "./TurnCard";

describe("TurnCard", () => {
  it("距離を出し、向きの言葉は読み上げの名前にだけ出す", () => {
    render(<TurnCard direction="right" distanceM={347} />);
    const card = screen.getByRole("status", { name: "350m先で右折" });
    expect(card).toHaveTextContent("350m");
    expect(card).not.toHaveTextContent("右折");
  });
});
