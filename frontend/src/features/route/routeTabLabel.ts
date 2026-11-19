import type { RouteCandidate } from "@/types/route";

// 候補の一覧の並び・群・名前を組み立てる純関数。
//
// 最速の印は**backendが付ける値**（route_generator.py: _label）で、ここは読むだけ。idの文字列や
// 生成の要求の形から決め直さない。

/** 一覧の群。並びは最速 → 生成した候補 → 合成で、群が変わる所に区切りの線を引く。 */
export type RouteListGroup = "fastest" | "generated" | "spliced";

/**
 * 一覧の1行。`name`はそのルートを指す名前（「元との違い」の元の名前にも使う）で、`label`は名前の列に印と並べて
 * 出す文字（最速は印だけなので空、合成は番号）。
 */
interface RouteListEntry<T> {
  route: T;
  group: RouteListGroup;
  name: string;
  label: string;
}

/** 一覧の先頭に置く、backendが最速の印を付けた候補の名前。 */
const FASTEST_ROUTE_NAME = "最速";

type ListedRoute = Pick<RouteCandidate, "id" | "is_fastest">;

/**
 * 「ルート結果」の一覧の並びと名前。
 *
 * 最速の印の付いた1本を「最速」として先頭に置き、残りの生成候補に1から番号を振り、合成で作ったルートを作った順に
 * 「合成N」で続ける。比べる基準の1本を、合成の前後で動かさずに一番上へ置くため。
 */
export function routeListEntries<T extends ListedRoute>(
  generated: readonly T[],
  edits: readonly { route: T; number: number }[],
): RouteListEntry<T>[] {
  const fastest = generated
    .filter((route) => route.is_fastest)
    .map((route) => ({ route, group: "fastest" as const, name: FASTEST_ROUTE_NAME, label: "" }));
  const numbered = generated
    .filter((route) => !route.is_fastest)
    .map((route, index) => ({ route, group: "generated" as const, name: `${index + 1}`, label: `${index + 1}` }));
  const spliced = edits.map(({ route, number }) => ({
    route,
    group: "spliced" as const,
    name: `合成${number}`,
    label: `${number}`,
  }));
  return [...fastest, ...numbered, ...spliced];
}
