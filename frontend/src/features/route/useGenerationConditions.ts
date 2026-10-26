"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { useStoredBooleanState, useStoredJsonState, useStoredState } from "@/hooks/useStoredState";
import { readRoadAvoidance, withCurrentRoadKeys } from "@/features/route/roadAvoidance";
import { alignRoutePreference, routePreferenceToSend } from "@/features/route/routePreferenceSync";
import {
  acceptedDistanceInput,
  acceptedMaxRoutesInput,
  destinationInUse,
  type GenerationConditionsSnapshot,
} from "@/features/route/savedConditions";
import type {
  Coordinates,
  PinRole,
  PlaceCandidate,
  PointTarget,
  RoadAvoidanceOverride,
  RoutePreferenceWeights,
} from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

const WEIGHT_OVERRIDE_ENABLED_STORAGE_KEY = "ridecompass:weight-override-enabled";
const ROUTE_PREFERENCE_STORAGE_KEY = "ridecompass:route-preference";
const ROAD_AVOIDANCE_STORAGE_KEY = "ridecompass:road-avoidance";
const NO_ROAD_AVOIDANCE: RoadAvoidanceOverride = {};

/** 経由地を、生成が受け付ける数まで置いてあるか（置いてあれば、もう足さない）。 */
export function waypointsFull(waypoints: readonly Coordinates[]): boolean {
  return waypoints.length >= routeGenerateConfig.max_waypoints;
}

/** 並びの`from`番目を`to`番目へ動かしたあと、いま`index`番目のものが何番目になるか（間のものは1つずつ詰まる）。 */
export function reorderedIndex(index: number, from: number, to: number): number {
  if (index === from) return to;
  if (from < index && index <= to) return index - 1;
  if (to <= index && index < from) return index + 1;
  return index;
}
// 「条件」タブの入力値。場所（目的地・経由地のピン）は持たない——行くたびに変わるうえ、
// 古いピンが残っていると気づかないまま生成してしまう。
const LOOP_STORAGE_KEY = "ridecompass:loop";
const DISTANCE_TARGETED_STORAGE_KEY = "ridecompass:distance-targeted";
const DISTANCE_STORAGE_KEY = "ridecompass:distance-km";
const MAX_ROUTES_STORAGE_KEY = "ridecompass:max-routes";

/** 形の項目ごとに入れ方を呼ぶ。入れ方の表は形と同じキーを全部持つ型なので、形に項目を足すと入れ方が要る。 */
function applyEachField<T extends object>(apply: { [K in keyof T]-?: (value: T[K]) => void }, value: T) {
  for (const key in apply) apply[key](value[key]);
}

interface GenerationConditionsInputs {
  /** 地図で出発地を置いたとき（出発地は位置の取得と同じ持ち主が持つ）。 */
  onOriginPlace: (point: Coordinates) => void;
}

/**
 * 生成の条件（「ルート設定」の入力）: 周回か・全長の目標を決めるか・距離・候補数・地点（出発地以外）・重み・除外・避け方と、地図のタップで
 * 置く地点の選びと、保存した条件での入れ替え。保存する値は、読むときに今の画面が受け付ける範囲・今の項目へ揃える。
 */
export function useGenerationConditions({ onOriginPlace }: GenerationConditionsInputs) {
  const axisCatalog = useAxisCatalog();

  // 経由地（通る順）。
  const [waypoints, setWaypoints] = useState<Coordinates[]>([]);
  const moveWaypoint = useCallback((index: number, point: Coordinates) => {
    setWaypoints((prev) => prev.map((current, i) => (i === index ? point : current)));
  }, []);
  const addWaypoint = useCallback((point: Coordinates) => {
    setWaypoints((prev) => [...prev, point]);
  }, []);

  // 周回か（終点を出発地にする）。周回の間も置いた目的地は消さずに覚えておき、生成にも画面にも使わない（外すと戻る）。
  const [loop, setLoop] = useStoredBooleanState(LOOP_STORAGE_KEY, true);

  // 置いた目的地（周回の間は覚えておくだけ）。生成と画面が読むのは、周回の間を外した`destination`（下の返り値）。
  const [placedDestination, setDestination] = useState<Coordinates | null>(null);
  const clearDestination = useCallback(() => setDestination(null), []);
  const destination = destinationInUse({ loop, destination: placedDestination });

  // 選んでいる地点（地図のタップが置く地点）。何も選んでいない・周回で目的地を使わない間は出発地——
  // 周回を作る人が地図を触っても目的地が置かれず、詳しくに出ている地点と置かれる地点がいつも同じになる。
  // 経由地を減らす操作は、選んでいる経由地も同じ操作の中で直す。
  const [chosenPoint, setChosenPoint] = useState<PointTarget | null>(null);
  const selectedPoint = useMemo<PointTarget>(
    () => (chosenPoint === null || (chosenPoint.role === "destination" && loop) ? { role: "origin" } : chosenPoint),
    [chosenPoint, loop],
  );

  const selectPoint = useCallback((target: PointTarget) => setChosenPoint(target), []);
  // 通る順の並び（出発地・経由地・目的地。周回の間は目的地を除く）の`from`番目を`to`番目へ動かし、置いた位置の役割にする。
  // 置いていない目的地は空の席として並びの末尾にあり、経由地をそこへ動かすと目的地になる。出発地は位置の持ち主が持つので、
  // 呼び出し側が今の位置を渡す（先頭が変わったら、新しい先頭を出発地として置く。現在地を追っていた出発地も、動かした時点の
  // 位置の地点になる）。選んでいる地点は、番号・役割ではなく同じ地点に付けたままにする（番号のまま残すと、入れ替わった別の
  // 地点を選んだことになる）。
  const reorderPoints = useCallback(
    (from: number, to: number, origin: Coordinates) => {
      const order: (Coordinates | null)[] = [origin, ...waypoints, ...(loop ? [] : [placedDestination])];
      const next = [...order];
      next.splice(to, 0, ...next.splice(from, 1));
      const [first] = next;
      if (first === null) return;
      const last = loop ? next.length : next.length - 1;
      if (first !== origin) onOriginPlace(first);
      setWaypoints(next.slice(1, last).filter((point) => point !== null));
      if (!loop) setDestination(next[last]);
      if (chosenPoint === null || (chosenPoint.role === "waypoint" && chosenPoint.index === null)) return;
      const chosenAt =
        selectedPoint.role === "origin"
          ? 0
          : selectedPoint.role === "destination"
            ? last
            : (selectedPoint.index ?? 0) + 1;
      if (order[chosenAt] === null) return;
      const movedTo = reorderedIndex(chosenAt, from, to);
      setChosenPoint(
        movedTo === 0
          ? { role: "origin" }
          : !loop && movedTo === last
            ? { role: "destination" }
            : { role: "waypoint", index: movedTo - 1 },
      );
    },
    [waypoints, loop, placedDestination, onOriginPlace, chosenPoint, selectedPoint],
  );
  // 経由地を消すと後ろの番号を詰めるので、選んでいる経由地も同じに詰める（番号のまま残すと、次の経由地を選んだことになる）。
  const removeWaypoint = useCallback((index: number) => {
    setWaypoints((prev) => prev.filter((_, i) => i !== index));
    setChosenPoint((current) => {
      if (current?.role !== "waypoint" || current.index === null || current.index < index) return current;
      return current.index === index ? null : { role: "waypoint", index: current.index - 1 };
    });
  }, []);

  // 検索・名前のある点で置いた地点の候補。名前を出すのは、その地点がまだ候補の位置にある間だけ（ピンを動かす・地図で置き直すと、
  // 名前の所ではなくなる）。
  const [found, setFound] = useState<PlaceCandidate[]>([]);

  // 地図のタップで、選んでいる地点を置く。新しい経由地を選んでいる間は置くたびに足す（続けて何地点も置くのが普通の使い方で、
  // 1つ置くたびに選び直させない）が、生成が受け付ける数を超える点は置かない。名前のある点（店など）を押したなら、その点の
  // 候補として置く。
  const placeAtSelected = useCallback(
    (point: Coordinates, spot: PlaceCandidate | null) => {
      if (selectedPoint.role === "origin") onOriginPlace(point);
      else if (selectedPoint.role === "destination") setDestination(point);
      else if (selectedPoint.index !== null) moveWaypoint(selectedPoint.index, point);
      else if (!waypointsFull(waypoints)) addWaypoint(point);
      else return;
      if (spot !== null) setFound((prev) => [...prev, spot]);
    },
    [selectedPoint, onOriginPlace, moveWaypoint, addWaypoint, waypoints],
  );
  // 探して選んだ地点を置く（経由地は`waypointIndex`番目を置き直し、無ければ足して、足した経由地を選ぶ——どこに置いたかを
  // 詳しくで確かめられる）。足すのは生成が受け付ける数まで（開いた候補の一覧からは、数に達した後にも選べる）。
  const placeFound = useCallback(
    (role: PinRole, candidate: PlaceCandidate, waypointIndex: number | null) => {
      const point = { latitude: candidate.latitude, longitude: candidate.longitude };
      if (role === "origin") onOriginPlace(point);
      else if (role === "destination") setDestination(point);
      else if (waypointIndex !== null) moveWaypoint(waypointIndex, point);
      else if (!waypointsFull(waypoints)) {
        addWaypoint(point);
        setChosenPoint({ role: "waypoint", index: waypoints.length });
      } else return;
      setFound((prev) => [...prev, candidate]);
    },
    [onOriginPlace, moveWaypoint, addWaypoint, waypoints],
  );
  /** 地点`at`が検索で置いたときの位置のままなら、その候補。 */
  const foundAt = useCallback(
    (at: Coordinates | null): PlaceCandidate | null =>
      at === null
        ? null
        : (found.findLast((candidate) => candidate.latitude === at.latitude && candidate.longitude === at.longitude) ??
          null),
    [found],
  );
  // 並びに出ている経由地と目的地を一度に消す（周回の間に覚えている目的地は消さない）。選んでいる地点も出発地に戻す（消した地点を
  // 置き直す途中のまま残さない）。
  const clearPoints = useCallback(() => {
    setWaypoints([]);
    if (!loop) setDestination(null);
    setChosenPoint(null);
  }, [loop]);

  // 全長の目標を決めるか。外すと距離を送らず、置いた地点へ良い道で向かう。
  const [distanceTargeted, setDistanceTargeted] = useStoredBooleanState(DISTANCE_TARGETED_STORAGE_KEY, true);

  // 距離の入力（文字列のまま）。表示中の候補を作った条件と比べて「生成条件が変更されています」を出すため、入力の形で持つ。
  const [distanceInput, setDistanceInput] = useStoredState(DISTANCE_STORAGE_KEY, "30", {
    serialize: (value) => value,
    deserialize: acceptedDistanceInput,
  });
  // 候補数（文字列のまま、送るときに数へ）。
  const [maxRoutesInput, setMaxRoutesInput] = useStoredState(
    MAX_ROUTES_STORAGE_KEY,
    String(routeGenerateConfig.default_max_routes),
    {
      serialize: (value) => value,
      deserialize: acceptedMaxRoutesInput,
    },
  );

  // 重みを上書きして送るか。OFFの間は重みを送らず、backendの既定で探す。重みを操作するとONになる。
  const [weightOverrideEnabled, setWeightOverrideEnabled] = useStoredBooleanState(
    WEIGHT_OVERRIDE_ENABLED_STORAGE_KEY,
    false,
  );
  // 初期値は空。既定の重みは実行時の軸カタログが配り、下で揃えるときに補う（ビルド時の写しを初期値にすると、
  // 軸の増減が次のデプロイまで届かない）。
  const [storedRoutePreference, setRoutePreference] = useStoredJsonState<RoutePreferenceWeights>(
    ROUTE_PREFERENCE_STORAGE_KEY,
    {},
  );
  // 画面が読む重みは、軸カタログの公開軸へ揃えたこの値だけ（保存値は次に重みを動かしたときに揃った形で書かれる）。
  // 上書きしていない間は保存した重みを読まず、送らない間に効く既定の重みにする（重みのタブが出す値と送る値を食い違わせない）。
  const routePreference = useMemo(
    () => alignRoutePreference(weightOverrideEnabled ? storedRoutePreference : {}, axisCatalog),
    [weightOverrideEnabled, storedRoutePreference, axisCatalog],
  );
  // 道の区分の行ごとに選んだ避け方。選んだ段だけを覚え、常に送る。
  const [roadAvoidance, setRoadAvoidance] = useStoredState<RoadAvoidanceOverride>(
    ROAD_AVOIDANCE_STORAGE_KEY,
    NO_ROAD_AVOIDANCE,
    {
      serialize: JSON.stringify,
      deserialize: (raw) => readRoadAvoidance(JSON.parse(raw)),
    },
  );
  // 軸カタログが届いたら、前の鍵に選んだ段を今の鍵へ書き直して保存へ書き戻す。
  const avoidanceView = axisCatalog.roadClasses.avoidance;
  useEffect(() => {
    if (axisCatalog.loaded && withCurrentRoadKeys(roadAvoidance, avoidanceView) !== roadAvoidance) {
      setRoadAvoidance((prev) => withCurrentRoadKeys(prev, avoidanceView));
    }
  }, [axisCatalog.loaded, avoidanceView, roadAvoidance, setRoadAvoidance]);

  // いまの条件を、保存・呼び出しと同じ形1つで返す（保存・生成の入力・保存の説明はこれを読む）。
  const snapshot: GenerationConditionsSnapshot = useMemo(
    () => ({
      loop,
      distanceTargeted,
      distance: distanceInput,
      maxRoutes: maxRoutesInput,
      waypoints,
      destination: placedDestination,
      routePreference: weightOverrideEnabled ? routePreference : null,
      roadAvoidance,
    }),
    [
      loop,
      distanceTargeted,
      distanceInput,
      maxRoutesInput,
      waypoints,
      placedDestination,
      weightOverrideEnabled,
      routePreference,
      roadAvoidance,
    ],
  );

  // 保存した条件で入れ替える（出発地は位置の持ち主が受け取るので、呼び出し側が渡す）。地点を入れ替えたので、選んでいる地点は
  // 出発地に戻す。
  const restore = useCallback(
    (saved: GenerationConditionsSnapshot) => {
      applyEachField<GenerationConditionsSnapshot>(
        {
          loop: setLoop,
          distanceTargeted: setDistanceTargeted,
          distance: setDistanceInput,
          maxRoutes: setMaxRoutesInput,
          waypoints: setWaypoints,
          destination: setDestination,
          routePreference: (weights) => {
            if (weights !== null) setRoutePreference(weights);
            setWeightOverrideEnabled(weights !== null);
          },
          roadAvoidance: setRoadAvoidance,
        },
        saved,
      );
      setChosenPoint(null);
    },
    [
      setLoop,
      setDistanceTargeted,
      setDistanceInput,
      setMaxRoutesInput,
      setRoutePreference,
      setWeightOverrideEnabled,
      setRoadAvoidance,
    ],
  );

  return {
    snapshot,
    restore,
    loop,
    setLoop,
    distanceTargeted,
    setDistanceTargeted,
    distanceInput,
    setDistanceInput,
    maxRoutesInput,
    setMaxRoutesInput,
    waypoints,
    removeWaypoint,
    moveWaypoint,
    reorderPoints,
    /** 地点を選んで出しているか（何も選んでいない間の`selectedPoint`は出発地）。 */
    pointChosen: chosenPoint !== null,
    /** 生成と画面（地点の並び・地図のピン）が使う目的地（周回の間はnull）。 */
    destination,
    setDestination,
    clearDestination,
    clearPoints,
    selectedPoint,
    selectPoint,
    placeAtSelected,
    placeFound,
    foundAt,
    weightOverrideEnabled,
    setWeightOverrideEnabled,
    routePreference,
    setRoutePreference,
    /** 生成リクエストと道の評価へ載せる重み（上書きしていない間・軸カタログが無い間はnull）。 */
    routePreferenceToSend: routePreferenceToSend(routePreference, axisCatalog.loaded, weightOverrideEnabled),
    roadAvoidance,
    setRoadAvoidance,
  };
}

export type GenerationConditionsState = ReturnType<typeof useGenerationConditions>;
