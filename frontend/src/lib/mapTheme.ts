/** 地図の地の明るさ（明るい地図・暗い地図）。暗い地図の作り方は`features/map/basemapTheme.ts`。 */
import palette from "@/types/generated/palette.json";

export type MapTheme = "light" | "dark";

export type SemanticColors = typeof palette.semantic;

/** 地図の上に塗る役割の色。暗い地図では、暗い地に沈む色だけを差し替えた組をbackendが配る。 */
export function semanticColorsOn(theme: MapTheme): SemanticColors {
  return theme === "dark" ? palette.semantic_on_dark : palette.semantic;
}
