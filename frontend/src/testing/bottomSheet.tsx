// スマホの下からせり上がるシート（`components/BottomSheet/BottomSheet.tsx`）を描いて操る足場。開いた「ルート設定」の
// シートを既定の高さで描き、閉じる操作・確定した高さの受け口と、propsを重ねて描き直す口を返す。高さを変える帯を引く
// `handle`と、高さの下限・上限（範囲の外の値を寄せた結果として取る）も持つ。
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import BottomSheet, { clampSheetHeightVh } from "@/components/BottomSheet/BottomSheet";

export type BottomSheetProps = React.ComponentProps<typeof BottomSheet>;

/** 高さの下限・上限。値を書き写さず、範囲の外の値を寄せた結果として取る（書き写すと、範囲を変えたときに
 * テストも一緒に動き、寄せることを誰も見なくなる）。 */
export const FLOOR = clampSheetHeightVh(0);
export const CEILING = clampSheetHeightVh(100);

export function sheetElement(
  props: Partial<BottomSheetProps>,
  handlers: Pick<BottomSheetProps, "onClose" | "onHeightChoose">,
) {
  return (
    <BottomSheet open title="ルート設定" headerAction={null} chosenHeightVh={50} {...handlers} {...props}>
      <p>中身</p>
    </BottomSheet>
  );
}

export function renderSheet(props: Partial<BottomSheetProps> = {}) {
  const handlers = { onClose: vi.fn(), onHeightChoose: vi.fn() };
  const view = render(sheetElement(props, handlers));
  let current = props;
  return {
    ...handlers,
    /** 前に渡したpropsへ`next`を重ねて描き直す。 */
    rerender: (next: Partial<BottomSheetProps>) => {
      current = { ...current, ...next };
      view.rerender(sheetElement(current, handlers));
    },
    container: view.container,
  };
}

/** 高さを変える帯。 */
export function handle() {
  return screen.getByRole("separator", { name: "パネルの高さを変更" });
}
