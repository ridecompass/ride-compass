/** ルート（選んだ区間の範囲の縁取り・候補の参考線・選択中候補・区間の色分け・乗り換えの帯・合成ルート・
 * 進行方向の矢印）。
 *
 * **重なりはこのファイルの宣言の並びだけが決める**（背面→前面）。押したときに拾う対象は
 * 見た目の線とは別の透明な線が持つ——見た目の太さと、指で押せる幅を別々に決めるため。
 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import type { ExpressionSpecification, FilterSpecification } from "maplibre-gl";

import { createRouteArrowIcon, ROUTE_ARROW_ICON_ID } from "@/features/map/layers/routeArrowIcon";
import type { MapSceneImage } from "@/features/map/scene/mapScene";
import { declareGroup, type SceneLayerEntry } from "@/features/map/scene/mapSceneGroups";
import { noDataDashExpression, zoomScaleExpression } from "@/features/map/scene/sceneBuilders";
import { ROUTE_SOURCE as SOURCE, routeSourceEntries, type RoutePath, type RouteShape } from "./routeSources";

/** 見た目の値は源泉が配る（`backend/app/domain/map_display.py`）。ここは受け取って塗るだけ。 */
const ROUTE = mapDisplay.route;

/** 指の接地面。**見た目の線がどれだけ細くても押せる幅にする**ので、線の太さからは導けない
 * ——媒体（指の大きさ）が決める値で、配信側は知らない。 */
const HIT_WIDTH_PX = 24;

const TRAVELLED_OPACITY: ExpressionSpecification = [
  "case",
  ["==", ["get", "travelled"], true],
  ROUTE.opacities.travelled,
  1,
];

/** ルートの線を進む向きの左へずらす量（負が左）。往復で行きと帰りが同じ道を通る所でも2本の縁取りが接して並び、
 * 後に描く帰りが走り終えて薄めた行きを覆わない。左側通行と同じ側に並ぶので、どちらが行きかも読める。
 * 線・ハロー・当たり判定・矢印を同じだけずらし、見た目の線と押せる所と向きの印を揃える。 */
const ROUTE_OFFSET_PX = -ROUTE.casingWidthsPx.detail / 2;

const HIT_PAINT = { "line-color": palette.semantic.hit, "line-opacity": 0, "line-offset": ROUTE_OFFSET_PX } as const;
const ROUND_CAP = { "line-cap": "round", "line-join": "round" } as const;

export const ROUTE_HIT_TARGET_SEGMENT = "routeSegment";
export const ROUTE_HIT_TARGET_CANDIDATE = "routeCandidate";
export const ROUTE_HIT_TARGET_SPLICE_BAND = "routeSpliceBand";

export type RouteState = {
  readonly visible: boolean;
  readonly candidates: readonly { readonly routeId: string; readonly path: RoutePath }[];
  readonly selectedRouteId: string | null;
  /** 区間の形。`properties.travelled`が真の区間は、走り終えたものとして薄める。 */
  readonly segments: readonly RouteShape[];
  /** 区間の色。段の切り方・配色は軸カタログが決めるため、出来上がった式のまま受け取る。 */
  readonly segmentColor: string | ExpressionSpecification;
  /** 値が無い区間で真になる式。その区間を破線にする。値という考えを持たない塗り方（レンズ「なし」）では無い。 */
  readonly segmentNoData?: ExpressionSpecification;
  /** 凡例で隠した段を落とす絞り込み。色分け線・縁取り・当たり判定の3枚へ同じものを当てる。 */
  readonly hiddenBandFilter?: FilterSpecification;
  readonly spliceBands: readonly RouteShape[];
  readonly composite: RouteShape | null;
  /** 選んだ地点を含む区間の形。選んでいなければnull。 */
  readonly selectedSection: RoutePath | null;
};

/** 進行方向の矢印の絵。色を持たないシルエットで、色はレイヤーが決める。 */
const ROUTE_ARROW_IMAGE: MapSceneImage = {
  id: ROUTE_ARROW_ICON_ID,
  draw: () => ({ data: createRouteArrowIcon(), options: { sdf: true } }),
};

export const routeGroup = declareGroup<RouteState>((state) => {
  // 衝突判定を無効にする——有効にすると、同じ位置の2層のうち後ろが丸ごと落ちる。
  const arrowLayer = (role: string, scale: number, color: string, opacity: number): SceneLayerEntry => ({
    role,
    tier: "route",
    source: SOURCE.selected,
    type: "symbol",
    visible: state.visible,
    layout: {
      "icon-image": ROUTE_ARROW_ICON_ID,
      "symbol-placement": "line",
      "symbol-spacing": ROUTE.arrowSpacingPx,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-size": zoomScaleExpression(scale, ROUTE.arrowSizeByZoom),
      // 矢印の絵は右が進む向きで、線に沿って回ると上（負）が進む向きの左になる。ずらしは大きさ倍されるので、大きさで割る。
      "icon-offset": [
        "interpolate",
        ["linear"],
        ["zoom"],
        ...ROUTE.arrowSizeByZoom.flatMap(([zoom, factor]) => [
          zoom,
          ["literal", [0, ROUTE_OFFSET_PX / (scale * factor)]],
        ]),
      ],
    },
    paint: { "icon-color": color, "icon-opacity": opacity },
  });

  const selected = state.candidates.find((candidate) => candidate.routeId === state.selectedRouteId) ?? null;
  // 区間を描いている候補は参考線から外す——同じ線を2本重ねると、上の色分け線の下から
  // 単色の線がはみ出す。
  const detailed = state.segments.length > 0 ? selected : null;
  const references = state.candidates.filter((candidate) => candidate !== detailed);

  const sources = routeSourceEntries({
    references,
    selected,
    segments: state.segments,
    spliceBands: state.spliceBands,
    composite: state.composite,
    selectedSection: state.selectedSection,
  });

  const withBandFilter = (entry: SceneLayerEntry): SceneLayerEntry =>
    state.hiddenBandFilter === undefined ? entry : { ...entry, filter: state.hiddenBandFilter };

  // 背面から前面。
  const layers: readonly SceneLayerEntry[] = [
    // 選んだ区間の範囲は、どのルートの線より後ろに太く敷き、線の外側へはみ出た所で示す——線の上に重ねると、区間の色分けを隠す。
    {
      role: "selectedSection",
      tier: "route",
      source: SOURCE.selectedSection,
      type: "line",
      visible: state.visible && state.selectedSection !== null,
      layout: ROUND_CAP,
      paint: {
        "line-color": palette.semantic.selected_section,
        "line-width": ROUTE.lineWidthsPx.selectedSection,
        "line-opacity": ROUTE.opacities.selectedSection,
        "line-offset": ROUTE_OFFSET_PX,
      },
    },
    {
      role: "selectedHalo",
      tier: "route",
      source: SOURCE.selected,
      type: "line",
      visible: state.visible,
      paint: {
        "line-color": palette.semantic.route_selected_halo,
        "line-width": ROUTE.lineWidthsPx.selectedHalo,
        "line-opacity": ROUTE.opacities.selectedHalo,
        "line-offset": ROUTE_OFFSET_PX,
      },
    },
    {
      role: "candidateLine",
      tier: "route",
      source: SOURCE.candidates,
      type: "line",
      visible: state.visible,
      paint: {
        "line-color": palette.semantic.route_candidate,
        "line-width": ROUTE.lineWidthsPx.candidate,
        "line-opacity": ROUTE.opacities.candidate,
        "line-offset": ROUTE_OFFSET_PX,
      },
    },
    // 候補の線の当たり判定は、区間と乗り換えの帯の当たり判定より後ろ——重なった所は選んでいるルートの区間・帯を選ぶ。
    {
      role: "candidateHit",
      tier: "route",
      source: SOURCE.candidates,
      type: "line",
      visible: state.visible,
      paint: { ...HIT_PAINT, "line-width": HIT_WIDTH_PX },
      hitTargets: [ROUTE_HIT_TARGET_CANDIDATE],
    },
    {
      role: "spliceBandLine",
      tier: "route",
      source: SOURCE.spliceBands,
      type: "line",
      paint: {
        "line-color": palette.semantic.route_splice,
        "line-width": ROUTE.lineWidthsPx.splice,
        "line-opacity": ROUTE.opacities.splice,
        "line-dasharray": [...ROUTE.spliceDash],
        "line-offset": ROUTE_OFFSET_PX,
      },
      visible: state.visible && state.spliceBands.length > 0,
    },
    {
      role: "compositeCasing",
      tier: "route",
      source: SOURCE.composite,
      type: "line",
      visible: state.visible,
      layout: ROUND_CAP,
      paint: {
        "line-color": palette.semantic.route_casing,
        "line-width": ROUTE.casingWidthsPx.composite,
        "line-offset": ROUTE_OFFSET_PX,
      },
    },
    {
      role: "compositeLine",
      tier: "route",
      source: SOURCE.composite,
      type: "line",
      visible: state.visible,
      layout: ROUND_CAP,
      paint: {
        "line-color": palette.semantic.route_splice,
        "line-width": ROUTE.lineWidthsPx.composite,
        "line-offset": ROUTE_OFFSET_PX,
      },
    },
    withBandFilter({
      role: "detailCasing",
      tier: "route",
      source: SOURCE.segments,
      type: "line",
      visible: state.visible,
      paint: {
        "line-color": palette.semantic.route_casing,
        "line-width": ROUTE.casingWidthsPx.detail,
        "line-opacity": TRAVELLED_OPACITY,
        "line-offset": ROUTE_OFFSET_PX,
      },
    }),
    withBandFilter({
      role: "detailLine",
      tier: "route",
      source: SOURCE.segments,
      type: "line",
      visible: state.visible,
      paint: {
        "line-color": state.segmentColor,
        "line-width": ROUTE.lineWidthsPx.detail,
        "line-opacity": TRAVELLED_OPACITY,
        "line-offset": ROUTE_OFFSET_PX,
        ...(state.segmentNoData === undefined ? {} : { "line-dasharray": noDataDashExpression(state.segmentNoData) }),
      },
    }),
    withBandFilter({
      role: "detailHit",
      tier: "route",
      source: SOURCE.segments,
      type: "line",
      visible: state.visible,
      paint: { ...HIT_PAINT, "line-width": HIT_WIDTH_PX },
      hitTargets: [ROUTE_HIT_TARGET_SEGMENT],
    }),
    // 帯の当たり判定は区間の当たり判定より前面——区間の当たり判定はルート全体を覆うため、
    // 後ろだと帯を一度も押せない。
    {
      role: "spliceBandHit",
      tier: "route",
      source: SOURCE.spliceBands,
      type: "line",
      visible: state.visible,
      paint: { ...HIT_PAINT, "line-width": HIT_WIDTH_PX },
      hitTargets: [ROUTE_HIT_TARGET_SPLICE_BAND],
    },
    arrowLayer("arrowHalo", ROUTE.arrowHaloScale, palette.semantic.route_arrow_halo, ROUTE.opacities.arrowHalo),
    arrowLayer("arrow", 1, palette.semantic.route_arrow, 1),
  ];

  return { sources, layers, images: [ROUTE_ARROW_IMAGE] };
});
