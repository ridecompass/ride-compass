import type { Coordinates, PlaceCandidate, PointTarget } from "@/types/route";

/** 地図で置いた地点の名前（探して置いた名前の無い地点）と、その出どころ。 */
export const MAP_PLACED = "地図で選んだ地点";

interface PointNamesInputs {
  waypoints: readonly Coordinates[];
  destination: Coordinates | null;
  /** 地点が、探して・名前のある点で置いたときの位置のままなら、その候補。 */
  foundAt: (at: Coordinates | null) => PlaceCandidate | null;
  /** 出発地が、探して置いたときの位置のままなら、その候補。 */
  originFound: PlaceCandidate | null;
  /** 出発地を手で置いてあるか。 */
  originManual: boolean;
  /** 出発地が実際の位置か（現在地を取れたか、手で置いたか）。 */
  originLocated: boolean;
  /** 出発地の位置と、地点の位置から引いた辺り（引いていない・引けなければnull）。渡すと、名前を持たない地点を辺りで呼ぶ。 */
  areas?: { origin: Coordinates; areaOf: (at: Coordinates) => string | null };
}

/** 地点の名前のうち、探して・名前のある点で置いた地点の名前（無ければnull。地図で置いた地点・現在地は名前を持たない）。 */
function placeNames({
  waypoints,
  destination,
  foundAt,
  originFound,
}: Pick<PointNamesInputs, "waypoints" | "destination" | "foundAt" | "originFound">): {
  origin: string | null;
  waypoints: (string | null)[];
  destination: string | null;
} {
  return {
    origin: originFound?.name ?? null,
    waypoints: waypoints.map((point) => foundAt(point)?.name ?? null),
    destination: destination === null ? null : (foundAt(destination)?.name ?? null),
  };
}

/**
 * 地点の名前。探して置いた地点は候補の名前、地図で置いた地点は辺り（引けていなければ「地図で選んだ地点」）、手で置いていない出発地は
 * 「現在地（辺り）」（取れていなければそう言う——「現在地」と出ている出発地は、本当に取れた位置である）、目的地が無ければ「未設定」。
 * 辺りは`areas`を渡したときだけ使う。
 */
export function pointNames(inputs: PointNamesInputs): { origin: string; waypoints: string[]; destination: string } {
  const { waypoints, originManual, originLocated, destination, areas } = inputs;
  const found = placeNames(inputs);
  const areaOf = (at: Coordinates) => areas?.areaOf(at) ?? null;
  const placed = (at: Coordinates) => areaOf(at) ?? MAP_PLACED;
  const originArea = areas === undefined ? null : areaOf(areas.origin);
  const current = originArea === null ? "現在地" : `現在地（${originArea}）`;
  return {
    origin:
      found.origin ??
      (originManual ? (originArea ?? MAP_PLACED) : originLocated ? current : "現在地を取得できていません"),
    waypoints: found.waypoints.map((name, index) => name ?? placed(waypoints[index])),
    destination: destination === null ? "未設定" : (found.destination ?? placed(destination)),
  };
}

/** 地点の呼び名（出発地／経由地2／目的地／新しい経由地）。 */
export function pointTitle(target: PointTarget): string {
  if (target.role === "origin") return "出発地";
  if (target.role === "destination") return "目的地";
  return target.index === null ? "新しい経由地" : `経由地${target.index + 1}`;
}

/** 探した候補を選ぶと、その地点に何が起きるか。 */
export function chooseResultOf(target: PointTarget): string {
  if (target.role === "origin") return "出発地にします";
  if (target.role === "destination") return "目的地にします";
  return target.index === null ? "経由地に足します" : `${pointTitle(target)}を置き直します`;
}

/** 通る順の並び（出発地・経由地・目的地。周回の間は目的地を除く）の`index`番目の呼び名。 */
function orderTitle(index: number, count: number, loop: boolean): string {
  if (index === 0) return "出発地";
  if (!loop && index === count - 1) return "目的地";
  return `経由地${index}`;
}

/**
 * 通る順の並びの`from`番目を`to`番目へ動かしたあと、動かした地点が並びの何番目にあるかと、各行が前の並びの何番目だったか
 * （`order`）と、何がどこへ動いたかを名前で言う文。
 * `names`は並びの順の名前で、置いていない目的地はnull（経由地をそこへ動かすと目的地になり、空の席は並びから抜ける）。
 */
export function describeReorder(
  names: readonly (string | null)[],
  loop: boolean,
  from: number,
  to: number,
): { movedTo: number; order: number[]; note: string } {
  const order = names.map((_, index) => index);
  order.splice(to, 0, ...order.splice(from, 1));
  // 空の目的地の席は、末尾に残るときだけ並びに残る（間に入ると、経由地には数えない）。
  const last = order.length - 1;
  const kept = order.filter((index, at) => names[index] !== null || (!loop && at === last));
  const titleAfter = new Map(kept.map((index, at) => [index, orderTitle(at, kept.length, loop)]));
  const before = (index: number) => orderTitle(index, names.length, loop);
  const shifted = kept.filter((index) => index !== from && titleAfter.get(index) !== before(index));
  const moved = `「${names[from]}」を${before(from)}から${titleAfter.get(from)}へ動かしました。`;
  const rest =
    shifted.length === 0
      ? ""
      : `前の${shifted.map(before).join("・")}は${shifted.map((index) => titleAfter.get(index)).join("・")}になりました。`;
  return { movedTo: kept.indexOf(from), order: kept, note: moved + rest };
}
