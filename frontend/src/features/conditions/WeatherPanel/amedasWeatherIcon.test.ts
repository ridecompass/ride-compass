// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MoonIcon, RaindropIcon, SunIcon } from "@/components/ui/icons/lucideIcons";
import { vocabulary } from "@/types/generated/vocabulary";

import { getAmedasWeatherDisplay } from "./amedasWeatherIcon";

const category = (key: string) => vocabulary.weatherCategories.find((entry) => entry.key === key)!;

describe("getAmedasWeatherDisplay", () => {
  it("晴れだけは昼夜で絵を変える", () => {
    const clear = category("clear");
    expect(getAmedasWeatherDisplay(clear.codes[0], true)).toEqual({ Icon: SunIcon, label: clear.label });
    expect(getAmedasWeatherDisplay(clear.codes[0], false)).toEqual({ Icon: MoonIcon, label: clear.label });
  });

  it("晴れ以外は、分類の名前と分類のアイコンになる", () => {
    const rain = category("rain");
    expect(getAmedasWeatherDisplay(rain.codes[0], false)).toEqual({ Icon: RaindropIcon, label: rain.label });
  });
});
