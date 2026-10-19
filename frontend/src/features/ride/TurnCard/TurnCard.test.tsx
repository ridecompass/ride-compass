/**
 * 曲がる所のカード（`features/ride/TurnCard/TurnCard.tsx`）——走行モードの間、次に曲がる所の向きの矢印とそこまでの距離を
 * 出す。文字の札（「右折」等）は出さず、向きは読み上げの名前で伝える。
 *
 * ここで見ないもの: どの曲がる所を出すか → `nextTurn.test.ts`。走行中のページに出ること → `app/page.test.tsx`
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import TurnCard from "./TurnCard";

describe("TurnCard", () => {
  it.each([
    { case: "1km未満は10m単位", distanceM: 347, direction: "right" as const, label: "350m先で右折", text: "350m" },
    { case: "1km以上は0.1km単位", distanceM: 1260, direction: "left" as const, label: "1.3km先で左折", text: "1.3km" },
  ])("$case", ({ distanceM, direction, label, text }) => {
    render(<TurnCard direction={direction} distanceM={distanceM} />);
    const card = screen.getByRole("status", { name: label });
    expect(card).toHaveTextContent(text);
    expect(card).not.toHaveTextContent("右折");
    expect(card).not.toHaveTextContent("左折");
  });
});
