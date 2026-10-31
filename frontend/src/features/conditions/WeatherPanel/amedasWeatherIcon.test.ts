// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MoonIcon, RaindropIcon, SunIcon } from "@/components/ui/icons/lucideIcons";
import { vocabulary } from "@/types/generated/vocabulary";

import { getAmedasWeatherDisplay } from "./amedasWeatherIcon";

const category = (key: string) => vocabulary.weatherCategories.find((entry) => entry.key === key)!;

describe("getAmedasWeatherDisplay", () => {
  it.each([
    ["clear", true, SunIcon],
    ["clear", false, MoonIcon],
    ["rain", false, RaindropIcon],
  ] as const)("分類の名前と分類のアイコンにし、晴れだけは夜に絵を変える（%s・昼か: %s）", (key, isDay, Icon) => {
    const { codes, label } = category(key);
    expect(getAmedasWeatherDisplay(codes[0], isDay)).toEqual({ Icon, label });
  });

  it("天気が決まっていない・宣言に無いコードは、別の天気に見せず何も出さない", () => {
    const declared = new Set(vocabulary.weatherCategories.flatMap((entry) => entry.codes));
    expect(getAmedasWeatherDisplay(null, true)).toBeNull();
    expect(getAmedasWeatherDisplay(Math.max(...declared) + 1, true)).toBeNull();
  });
});
