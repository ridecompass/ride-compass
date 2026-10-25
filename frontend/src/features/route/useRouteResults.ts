"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import type { RouteCandidate, RoutePreferenceWeights, SelectedRouteSegment } from "@/types/route";

const NO_SELECTION = { routeId: null, reused: false };

/** 合成で作ったルートのidの頭。作った順の番号を足して、同じ生成の中で重ならないようにする。 */
const EDIT_ID_PREFIX = "spliced";

/** 区間の乗り換えで作ったルート。元にしたルートとは別の1本で、元を上書きしない。 */
export interface EditedRoute {
  route: RouteCandidate;
  /** 元にしたルートのid（生成した候補か、先に作った編集）。 */
  originId: string;
  /** 作った順の番号（1から）。画面の名前「合成N」に使う。 */
  number: number;
}

/**
 * 「ルート結果」の状態: 生成した候補・編集で作ったルート・選んだルート・地図で押した区間・生成に使われた重み。
 * 生成と区間の乗り換えが結果を入れ、「ルート結果」の部品と地図が読む。
 */
export function useRouteResults() {
  const [generated, setGenerated] = useState<RouteCandidate[]>([]);
  // 作った順。生成し直す・消すと一緒に消える（編集は元にした生成に結びつく）。
  const [edits, setEdits] = useState<EditedRoute[]>([]);
  // 次に作るルートの番号。足すときに選ぶidを同じ操作の中で決めるため、一覧の長さでなくここから振る（一覧と一緒に1へ戻す）。
  const nextEditNumber = useRef(1);
  // 選んだルートと、乗り換えで作った経路が既にあるこのルートと同じ道だったために選んだのか。どの操作で選び直しても外れる。
  const [selection, setSelection] = useState<{ routeId: string | null; reused: boolean }>(NO_SELECTION);
  const selectedRouteId = selection.routeId;
  // 選んでいる区間（地図で押しても、道のりのグラフで選んでも）。中身は地図の区間の小窓が出す。候補を切り替える・
  // 作り直す・消すと外す（別の候補の区間を指したまま残らない）。
  const [selectedRouteSegment, setSelectedRouteSegment] = useState<SelectedRouteSegment | null>(null);
  // 選んだルートの全体へ地図を収める頼み（生成した・カードを押した・乗り換えで作ったたびに新しい値。地図の線を押して選んだときは
  // 利用者がもうその範囲を見ているので頼まない）。
  const [routeFocus, setRouteFocus] = useState<object | null>(null);
  // 押した区間へ地図を寄せる頼み（押すたびに新しい値）と、押した区間が地図の見えている所の外にあるか（地図が知らせる）。
  // 区間を選んでも地図は動かさず、寄せるのは頼まれたときだけ。
  const [segmentFocus, setSegmentFocus] = useState<object | null>(null);
  const [segmentOutsideMap, setSegmentOutsideMap] = useState(false);
  const segmentOnMap = useMemo(
    () => ({ outside: segmentOutsideMap, onShow: () => setSegmentFocus({}) }),
    [segmentOutsideMap],
  );
  // 生成に使われた重み（利用者の重みは生成後も変わりうる）。
  const [usedWeights, setUsedWeights] = useState<RoutePreferenceWeights | null>(null);

  /** 生成の結果で一覧を入れ替える。最初に選ぶのは先頭（最速の1本か、最も早く着く候補）。 */
  const replaceWithGenerated = useCallback(
    (generated: RouteCandidate[], routePreference: RoutePreferenceWeights | null) => {
      setGenerated(generated);
      setEdits([]);
      nextEditNumber.current = 1;
      setSelection({ routeId: generated[0]?.id ?? null, reused: false });
      setRouteFocus({});
      // 候補が入れ替わると、押していた区間も意味を失う。
      setSelectedRouteSegment(null);
      setUsedWeights(routePreference);
    },
    [],
  );

  // 選び直すと、押していた区間は外す。地図は動かさない（収めるのは頼む操作が`focusRoute`で頼む）。
  const select = useCallback((routeId: string, reused: boolean) => {
    setSelectedRouteSegment(null);
    setSelection({ routeId, reused });
  }, []);

  /** 選んでいるルートの全体へ地図を収める。 */
  const focusRoute = useCallback(() => setRouteFocus({}), []);

  /** 区間の乗り換えで作ったルートを足して選ぶ。idは画面が振る（backendは同じ値を毎回返す）。 */
  const addEdit = useCallback(
    (route: RouteCandidate, originId: string) => {
      const number = nextEditNumber.current++;
      const id = `${EDIT_ID_PREFIX}-${number}`;
      setEdits((current) => [...current, { route: { ...route, id }, originId, number }]);
      select(id, false);
      focusRoute();
    },
    [select, focusRoute],
  );

  /** 候補・選択・使われた重みを消す。 */
  const clear = useCallback(() => replaceWithGenerated([], null), [replaceWithGenerated]);

  /** ルートを選ぶ（候補のカード・地図の候補の線）。地図は動かさない。 */
  const selectRoute = useCallback((routeId: string) => select(routeId, false), [select]);

  /** ルートを選び、その全体へ地図を収める。 */
  const showRoute = useCallback(
    (routeId: string) => {
      select(routeId, false);
      focusRoute();
    },
    [select, focusRoute],
  );

  /** 乗り換えで作った経路が既にある候補と同じ道だったので、足さずにその候補を選んで収める。 */
  const selectReused = useCallback(
    (routeId: string) => {
      select(routeId, true);
      focusRoute();
    },
    [select, focusRoute],
  );

  const routes = useMemo(() => [...generated, ...edits.map((edit) => edit.route)], [generated, edits]);
  const selectedCandidate = routes.find((route) => route.id === selectedRouteId) ?? null;
  const selectedEdit = useMemo(() => {
    const edit = edits.find((item) => item.route.id === selectedRouteId);
    return edit ? { ...edit, origin: routes.find((route) => route.id === edit.originId) ?? null } : null;
  }, [edits, routes, selectedRouteId]);

  return {
    /** 生成した候補と編集で作ったルートの全部（どちらも選べ、乗り換えの相手にもなる）。 */
    routes,
    generated,
    edits,
    selectedRouteId,
    /** 選んだ候補が、乗り換えで作った経路と同じ道だったために選んだものならそのid。 */
    reusedRouteId: selection.reused ? selectedRouteId : null,
    selectedCandidate,
    /** 選んだルートが編集で作ったものなら、その編集と元のルート。 */
    selectedEdit,
    /** 選んだ候補が区間の内訳を持つか（区間まで確定したか）。 */
    hasDetail: (selectedCandidate?.segments.length ?? 0) > 0,
    selectedRouteSegment,
    selectSegment: setSelectedRouteSegment,
    /** 地図へ渡す、選んだルートの全体へ収める頼み。新しい値になるたびに収める。 */
    routeFocus,
    /** 地図へ渡す、押した区間へ寄せる頼み。新しい値になるたびに寄せる。 */
    segmentFocus,
    /** 地図が、押した区間が見えている所の外にあるかを知らせる口。 */
    setSegmentOutsideMap,
    /** 区間の詳しくの「区間を地図で見る」へ渡す値。 */
    segmentOnMap,
    usedWeights,
    replaceWithGenerated,
    addEdit,
    clear,
    selectRoute,
    showRoute,
    focusRoute,
    selectReused,
  };
}

export type RouteResults = ReturnType<typeof useRouteResults>;
