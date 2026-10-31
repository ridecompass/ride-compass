import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Ruler, { type RulerFrame } from "./Ruler";

// ドラッグ・ホイール・吸着はEmbla（ライブラリ）が持つ。ここでは差し替えた代役で、
// 「Emblaが選んだコマを報告する」「外から変わった位置へEmblaを動かす」つなぎだけを見る。
const embla = vi.hoisted(() => {
  const listeners = new Map<string, () => void>();
  const api = {
    selected: 0,
    options: {} as { active?: boolean },
    scrollTo: vi.fn(),
    selectedScrollSnap: () => api.selected,
    on: (event: string, handler: () => void) => listeners.set(event, handler),
    off: (event: string) => listeners.delete(event),
    /** Emblaが最寄りのコマを選び直したことにする。 */
    select(index: number) {
      api.selected = index;
      listeners.get("select")?.();
    },
  };
  return api;
});
vi.mock("embla-carousel-react", () => ({
  default: (options: { active?: boolean }) => {
    embla.options = options;
    return [() => {}, embla];
  },
}));
vi.mock("embla-carousel-wheel-gestures", () => ({ WheelGesturesPlugin: () => ({}) }));

const FRAMES: RulerFrame[] = [
  { label: "5km", tickLabel: "5" },
  { label: "10km", major: true, tickLabel: "10" },
  { label: "15km" },
];

beforeEach(() => {
  embla.scrollTo.mockClear();
  embla.selected = 0;
});

function renderRuler(index: number, disabled?: boolean) {
  const onIndexChange = vi.fn();
  const view = render(
    <Ruler
      frames={FRAMES}
      index={index}
      onIndexChange={onIndexChange}
      ariaLabel="距離"
      usage={null}
      disabled={disabled}
    />,
  );
  return { onIndexChange, ...view };
}

function ruler() {
  return screen.getByRole("slider", { name: "距離" });
}

describe("Ruler 表示", () => {
  it("読み上げには選んだコマの文とコマの数を渡す", () => {
    renderRuler(1);
    expect(ruler()).toHaveAttribute("aria-valuetext", "10km");
    expect(ruler()).toHaveAttribute("aria-valuemax", "2");
  });

  it("大きい目盛りのコマは広く取り、目盛りの下に短い文字を書く", () => {
    renderRuler(0);
    const ticks = [...ruler().firstElementChild!.children] as HTMLElement[];
    expect(parseFloat(ticks[1].style.width)).toBeGreaterThan(parseFloat(ticks[0].style.width));
    expect(ticks.map((tick) => tick.textContent)).toEqual(["5", "10", ""]);
  });
});

describe("Ruler 操作", () => {
  it("矢印キーで1コマ、Home・Endで端へ動かす。他のキーでは何もしない", async () => {
    const { onIndexChange } = renderRuler(1);
    act(() => ruler().focus());
    for (const key of ["{ArrowRight}", "{ArrowLeft}", "{Home}", "{End}", "{Enter}"]) await userEvent.keyboard(key);
    expect(onIndexChange.mock.calls.map(([index]) => index)).toEqual([2, 0, 0, 2]);
  });

  it("端では、その向きのキーは報告しない", async () => {
    const { onIndexChange } = renderRuler(0);
    act(() => ruler().focus());
    await userEvent.keyboard("{ArrowLeft}{Home}");
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it("押せない間は、ドラッグを止め、フォーカスに入らず、キーでも動かない", async () => {
    const { onIndexChange } = renderRuler(1, true);
    expect(embla.options.active).toBe(false);
    expect(ruler()).toHaveAttribute("aria-disabled", "true");
    expect(ruler()).toHaveAttribute("tabindex", "-1");
    act(() => ruler().focus());
    await userEvent.keyboard("{ArrowRight}");
    expect(onIndexChange).not.toHaveBeenCalled();
  });
});

describe("Ruler Emblaとのつなぎ", () => {
  it("出した時は、選んでいるコマへすぐに合わせる", () => {
    renderRuler(1);
    expect(embla.scrollTo).toHaveBeenCalledWith(1, true);
  });

  it("Emblaが別のコマを選んだら親へ知らせ、同じコマのままなら知らせない", () => {
    const { onIndexChange } = renderRuler(0);
    act(() => embla.select(0));
    expect(onIndexChange).not.toHaveBeenCalled();
    act(() => embla.select(2));
    expect(onIndexChange).toHaveBeenCalledWith(2);
  });

  it("外から位置が変わったときだけEmblaを動かす（自分が知らせた位置へは動かし直さない）", () => {
    const { rerender, onIndexChange } = renderRuler(0);
    embla.scrollTo.mockClear();
    act(() => embla.select(2));
    const props = { frames: FRAMES, onIndexChange, ariaLabel: "距離", usage: null };
    rerender(<Ruler {...props} index={2} />);
    expect(embla.scrollTo).not.toHaveBeenCalled();
    rerender(<Ruler {...props} index={0} />);
    expect(embla.scrollTo).toHaveBeenCalledWith(0, false);
  });
});
