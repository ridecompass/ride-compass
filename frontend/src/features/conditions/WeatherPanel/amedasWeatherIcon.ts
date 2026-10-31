import { vocabulary } from "@/types/generated/vocabulary";
import type { MapIconComponent } from "@/components/ui/icons/icons";
import { CloudIcon, MoonIcon, RaindropIcon, SnowflakeIcon, SunIcon } from "@/components/ui/icons/lucideIcons";

// WMO天気コードの分類と名前は生成物の語彙から引き、画面は分類ごとのアイコンだけを持つ。
type WeatherCategory = (typeof vocabulary.weatherCategories)[number];
type WeatherCodeCategory = WeatherCategory["key"];

const CATEGORY_BY_CODE: ReadonlyMap<number, WeatherCategory> = new Map(
  vocabulary.weatherCategories.flatMap((category) => category.codes.map((code) => [code, category] as const)),
);

const WEATHER_CATEGORY_ICON: Record<WeatherCodeCategory, MapIconComponent> = {
  clear: SunIcon,
  cloudy: CloudIcon,
  rain: RaindropIcon,
  snow: SnowflakeIcon,
};

// 夜に絵を変える分類だけを持つ（ほかは昼夜どちらでも同じアイコンで伝わる）。
const NIGHT_ICON: Partial<Record<WeatherCodeCategory, MapIconComponent>> = { clear: MoonIcon };

interface AmedasWeatherDisplay {
  Icon: MapIconComponent;
  label: string;
}

/** 天気コードと昼夜から天気アイコンとラベルを決める。コードが無い・分類に無ければnull（天気の分からないコードで、別の天気に見せない）。 */
export function getAmedasWeatherDisplay(weatherCode: number | null, isDay: boolean): AmedasWeatherDisplay | null {
  const category = weatherCode == null ? undefined : CATEGORY_BY_CODE.get(weatherCode);
  if (category === undefined) return null;
  const Icon = (!isDay && NIGHT_ICON[category.key]) || WEATHER_CATEGORY_ICON[category.key];
  return { Icon, label: category.label };
}
