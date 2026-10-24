import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RulerFrame } from "@/components/ui/Ruler/Ruler";
import DynamicLayerTimeSlider from "./DynamicLayerTimeSlider";

// ルーラーの操作（ドラッグ・キー・Emblaとのつなぎ）は`components/ui/Ruler/Ruler.test.tsx`が見る。
// ここは選んだ時刻の文とボタンだけを見る。
vi.mock("embla-carousel-react", () => ({ default: () => [() => {}, undefined] }));
vi.mock("embla-carousel-wheel-gestures", () => ({ WheelGesturesPlugin: () => ({}) }));

const FRAMES: RulerFrame[] = [
  { label: "9/24 09:55", tickLabel: "55" },
  { label: "9/24 10:00", major: true, tickLabel: "10:00" },
  { label: "9/24 11:00", major: true },
];

function renderSlider(index: number, currentIndex = 0) {
  const onIndexChange = vi.fn();
  const onNow = vi.fn();
  const view = render(
    <DynamicLayerTimeSlider
      frames={FRAMES}
      index={index}
      onIndexChange={onIndexChange}
      currentIndex={currentIndex}
      onNow={onNow}
      ariaLabel="出発時刻"
    />,
  );
  return { onIndexChange, onNow, ...view };
}

describe("DynamicLayerTimeSlider 表示", () => {
  it("選んだコマの日付つきの時刻を上に出す", () => {
    renderSlider(1);
    expect(screen.getByText("9/24 10:00", { selector: "div" })).toBeInTheDocument();
  });
});

describe("DynamicLayerTimeSlider 操作", () => {
  it("‹・›で1コマずつ動かし、端ではそれ以上動かせない", async () => {
    const first = renderSlider(0);
    expect(screen.getByRole("button", { name: "出発時刻を1つ前へ" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "出発時刻を1つ次へ" }));
    expect(first.onIndexChange).toHaveBeenCalledWith(1);
    first.unmount();

    const last = renderSlider(2);
    expect(screen.getByRole("button", { name: "出発時刻を1つ次へ" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "出発時刻を1つ前へ" }));
    expect(last.onIndexChange).toHaveBeenCalledWith(1);
  });

  it("「現在に戻す」は文字の無いアイコンで、今のコマを見ていない間だけ押せ、押すと親へ知らせる", async () => {
    const away = renderSlider(2, 0);
    const backToNow = screen.getByRole("button", { name: "出発時刻を現在に戻す" });
    expect(backToNow).toHaveTextContent(/^$/);
    expect(backToNow.querySelector("svg")).not.toBeNull();
    await userEvent.click(backToNow);
    expect(away.onNow).toHaveBeenCalled();
    away.unmount();

    renderSlider(0, 0);
    expect(screen.getByRole("button", { name: "出発時刻を現在に戻す" })).toBeDisabled();
  });
});
