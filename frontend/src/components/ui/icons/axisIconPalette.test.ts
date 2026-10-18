// @vitest-environment node
/**
 * `components/ui/icons/axisIconPalette.tsx`——軸の`icon_id`からアイコンを引く。
 *
 * 見るもの: パレットにある`icon_id`はその形を、無い・未設定の`icon_id`は汎用のアイコンを返すこと。
 *
 * ここで見ないもの: アイコンの絵そのもの → `components/ui/icons/layerIcons.tsx`・`components/ui/icons/lucideIcons.tsx`。
 */
import { describe, expect, it } from "vitest";

import { AXIS_ICON_PALETTE, axisIconFor } from "./axisIconPalette";

describe("axisIconFor", () => {
  it("パレットにある`icon_id`は、その形を返す", () => {
    const [iconId, Icon] = Object.entries(AXIS_ICON_PALETTE)[0];

    expect(axisIconFor(iconId)).toBe(Icon);
  });

  it("未設定とパレットに無い`icon_id`は、パレットのどの形とも違う同じアイコンを返す", () => {
    const fallback = axisIconFor(undefined);

    expect(axisIconFor("no-such-shape")).toBe(fallback);
    expect(Object.values(AXIS_ICON_PALETTE)).not.toContain(fallback);
  });
});
