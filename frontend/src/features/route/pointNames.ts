import type { Coordinates, PlaceCandidate } from "@/types/route";

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
 * 地点の名前。探して置いた地点は候補の名前、地図で置いた地点は「地図で選んだ地点」、手で置いていない出発地は「現在地」
 * （取れていなければそう言う——「現在地」と出ている出発地は、本当に取れた位置である）、目的地が無ければ「未設定」。
 */
export function pointNames(inputs: PointNamesInputs): { origin: string; waypoints: string[]; destination: string } {
  const { originManual, originLocated, destination } = inputs;
  const found = placeNames(inputs);
  return {
    origin: found.origin ?? (originManual ? MAP_PLACED : originLocated ? "現在地" : "現在地を取得できていません"),
    waypoints: found.waypoints.map((name) => name ?? MAP_PLACED),
    destination: destination === null ? "未設定" : (found.destination ?? MAP_PLACED),
  };
}
