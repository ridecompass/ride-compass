import type { Coordinates, PinRole, PlaceCandidate, PointTarget } from "@/types/route";

/** 地図で置いた地点の名前（探して置いた名前の無い地点）と、その出どころ。 */
const MAP_PLACED = "地図で選んだ地点";

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

/**
 * 地点の名前。探して置いた地点は候補の名前、地図で置いた地点は辺り（引けていなければ「地図で選んだ地点」）、手で置いていない出発地は
 * 「現在地（辺り）」（取れていなければそう言う——「現在地」と出ている出発地は、本当に取れた位置である）、目的地が無ければ「未設定」。
 * 辺りは`areas`を渡したときだけ使う。
 */
export function pointNames(inputs: PointNamesInputs): { origin: string; waypoints: string[]; destination: string } {
  const { waypoints, destination, foundAt, originFound, originManual, originLocated, areas } = inputs;
  const areaOf = (at: Coordinates) => areas?.areaOf(at) ?? null;
  const placed = (at: Coordinates) => areaOf(at) ?? MAP_PLACED;
  const originArea = areas === undefined ? null : areaOf(areas.origin);
  const current = originArea === null ? "現在地" : `現在地[${originArea}]`;
  return {
    origin:
      originFound?.name ??
      (originManual ? (originArea ?? MAP_PLACED) : originLocated ? current : "現在地を取得できていません"),
    waypoints: waypoints.map((point) => foundAt(point)?.name ?? placed(point)),
    destination: destination === null ? "未設定" : (foundAt(destination)?.name ?? placed(destination)),
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

/** 見つけた地点（保存した地点）を新しく置ける先とその名前と、置けないか。経由地は上限まで置いてあれば、目的地は周回の間は置けない。 */
export function newPlacings({ waypointsFull, loop }: { waypointsFull: boolean; loop: boolean }): {
  role: PinRole;
  label: string;
  disabled: boolean;
}[] {
  return [
    { role: "origin", label: "出発地にする", disabled: false },
    { role: "waypoint", label: "経由地に足す", disabled: waypointsFull },
    { role: "destination", label: "目的地にする", disabled: loop },
  ];
}
