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

/**
 * 地点の名前。探して置いた地点は候補の名前、地図で置いた地点は「地図で選んだ地点」、手で置いていない出発地は「現在地」
 * （取れていなければそう言う——「現在地」と出ている出発地は、本当に取れた位置である）、目的地が無ければ「未設定」。
 * 地点の並びと、地図のピンを押したときの小窓が同じ名前を出す。
 */
export function pointNames({
  waypoints,
  destination,
  foundAt,
  originFound,
  originManual,
  originLocated,
}: PointNamesInputs): { origin: string; waypoints: string[]; destination: string } {
  return {
    origin: originFound?.name ?? (originManual ? MAP_PLACED : originLocated ? "現在地" : "現在地を取得できていません"),
    waypoints: waypoints.map((point) => foundAt(point)?.name ?? MAP_PLACED),
    destination: destination === null ? "未設定" : (foundAt(destination)?.name ?? MAP_PLACED),
  };
}
