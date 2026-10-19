"use client";

// 下書きの点数の地図。保存前の下書きで求めた道の点数を、下書きの段で塗る（管理画面の較正の画面が置く）。地図へ載せるものは一般の地図と同じ場面の組み立て
// （`scene/applyToMap.ts: sceneInputsFrom`→`buildMapScene`→`applyScene`）を通し、道の線の塗りと凡例も一般の地図のものを使う。
// 点数の取得の鍵は軸・下書き・範囲だけで、段の境界を含めない——境界だけを動かしたときは、手元の点数のまま塗り直す。
// 点数は backend が下書きと走る条件で求め終えた値なので、道ごとの材料1つとして載せ、それをそのまま道の値にする木で塗る
// （公開中の軸の木は公開中の材料を読むので、下書きの点数には使えない）。

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";

import { createBaseMap } from "@/features/map/baseMap";
import { mergeTileValues, tilesCoveringViewport, type TileXY } from "@/features/map/layers/dynamicWayValues";
import type { MapLayerVisibility } from "@/features/map/layers/mapLayers";
import type { RoadMapLayerView } from "@/types/route";
import type { MapViewport } from "@/features/map/view/mapLook";
import LegendCheckboxList from "@/features/map/LegendCheckboxList/LegendCheckboxList";
import { LEGEND_SWATCH_CLASS } from "@/features/map/LensControl/LensControl";
import { ORIGIN_ZOOM } from "@/features/map/MapView/useMapMarkers";
import { ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM } from "@/features/map/regionApi";
import { applyScene, sceneInputsFrom, type HiddenLegendKeys } from "@/features/map/scene/applyToMap";
import { buildMapScene } from "@/features/map/scene/buildScene";
import type { WayMaterials } from "@/features/map/scene/groups/axisLines";
import { featureValueFormula } from "@/features/map/scene/wayValueFormula";
import { useMapAxisCatalog } from "@/features/map/useMapAxisCatalog";
import { hiddenKeysOf, toggleHiddenKey } from "@/features/map/view/legendFilters";
import { lensLegend } from "@/features/map/view/lens";
import { DEFAULT_LOCATION } from "@/hooks/useLocation";
import { MAP_FETCH_DEBOUNCE_MS, useDebouncedValue } from "@/hooks/useDebouncedValue";
import { errorMessage } from "@/lib/apiError";
import type { DedicatedWayValueAxis } from "@/lib/mapDisplay/axisLayers";
import { LENS_DIFFICULTY_ID } from "@/lib/mapDisplay/routeStyleModes";
import type { MapPaintDeclaration } from "@/lib/mapDisplay/valueScale";
import { getQueryClient } from "@/lib/queryClient";
import { textVariants } from "@/components/ui/Text/Text";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 下書きの点数の地図は道の点数だけを見せるため、チップで出し入れするレイヤーはどれも出さない（どの層も真偽が無いと出ない）。
const NO_LAYERS: MapLayerVisibility = {};

/** 道の線の層を描かない。 */
const NO_ROAD_LAYERS: readonly RoadMapLayerView[] = [];
const NO_ROAD_CLASSES = new Map<string, Record<string, string>>();

const EMPTY_MATERIALS: WayMaterials = new Map();

/** 木が条件を読まないので、地図に走る条件を置かない。 */
const NO_CONDITIONS = {};

/** 下書きの点数を載せる材料の名前。 */
const DRAFT_VALUE = "draft_value";

/** 軸の行のうち、下書きの点数で塗るために差し替える欄。点数は走る条件を入れて求め終えているので、向きで決まらない道は無い。 */
const DRAFT_PAINTING = {
  wayValueFormula: featureValueFormula(DRAFT_VALUE),
  paintsSurroundingRoads: true,
  undeterminedByBearing: false,
  wayMaterialConditions: [],
} satisfies Partial<DedicatedWayValueAxis>;

/** タイルごとの点数を、道ごとの材料へ移す。値の無い道は材料を載せない（木が値の無い道として塗る）。 */
function draftMaterialsOf(responses: readonly Record<string, number | null>[]): WayMaterials {
  const materials = new Map<string, Readonly<Record<string, number>>>();
  for (const [featureKey, value] of mergeTileValues(responses)) {
    materials.set(featureKey, value === null ? {} : { [DRAFT_VALUE]: value });
  }
  return materials;
}

/** 1枚のタイルの道の点数を求めるときに、地図が決める欄（タイルと走る条件）。値が条件で変わらない軸へ送っても、backendは読まずに捨てる。 */
interface DraftTileRequest extends TileXY {
  readonly bearing_deg: number;
  readonly at: string;
  readonly speed_kmh: number;
}

/** 下書きで1枚のタイルの道の点数（feature_key→点数）を求める。 */
export type FetchDraftTile<Draft> = (draft: Draft, tile: DraftTileRequest) => Promise<Record<string, number | null>>;

/** 見ている範囲の道の、下書きでの点数。入力が落ち着いてから取り、取り直す間は前の点数を残す。 */
function useDraftWayValues<Draft>(
  axisId: string,
  draft: Draft | null,
  fetchTile: FetchDraftTile<Draft>,
  viewport: MapViewport | null,
) {
  // 時刻で値の変わる軸は、画面を開いた時刻で塗る（範囲を動かすたびに時刻が進むと、点数を取り直し続ける）。
  const [condition] = useState(() => ({
    at: new Date().toISOString(),
    bearing_deg: 0,
    speed_kmh: routeGenerateConfig.default_assumed_speed_kmh,
  }));
  const tiles = useMemo(
    () => (viewport ? tilesCoveringViewport(viewport, ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM) : []),
    [viewport],
  );
  const key = draft === null || tiles.length === 0 ? "" : JSON.stringify({ axisId, draft, tiles });
  const debouncedKey = useDebouncedValue(key, MAP_FETCH_DEBOUNCE_MS);
  const { data, isFetching, error } = useQuery(
    {
      queryKey: ["draft-way-values", debouncedKey],
      queryFn: async () => {
        const request = JSON.parse(debouncedKey) as { draft: Draft; tiles: TileXY[] };
        const responses = await Promise.all(
          request.tiles.map((tile) => fetchTile(request.draft, { ...tile, ...condition })),
        );
        return draftMaterialsOf(responses);
      },
      enabled: debouncedKey !== "",
      placeholderData: keepPreviousData,
    },
    getQueryClient(),
  );
  return {
    materials: data ?? EMPTY_MATERIALS,
    loading: isFetching || key !== debouncedKey,
    error: error === null ? null : errorMessage(error),
  };
}

/** 軸カタログに無い軸（公開していない下書き）を塗るための行。塗りに要らない欄は空にする。 */
function unpublishedAxis(axisId: string, label: string, paint: MapPaintDeclaration): DedicatedWayValueAxis {
  return {
    axisId,
    label,
    description: "",
    mapValueKind: paint.kind,
    mapValueUnit: paint.legend.unit ?? "",
    rawValueUnit: null,
    rawValueTotalUnit: null,
    materialBreakdown: [],
    primaryAttributeIds: [],
    roadLayerIds: [],
    wayValueConditions: [],
    timeScope: "always",
    display: paint,
    ...DRAFT_PAINTING,
  };
}

export default function DraftWayValuesMap<Draft>({
  axisId,
  label,
  draft,
  fetchTile,
  paint,
}: {
  axisId: string;
  label: string;
  /** 点数を求める下書き（取得の鍵へ入れるので、JSONにできる値）。求められない間はnullで、前の点数のまま塗る。 */
  draft: Draft | null;
  fetchTile: FetchDraftTile<Draft>;
  /** 下書きの段（境界は画面で動かしている値）。 */
  paint: MapPaintDeclaration;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [hiddenLegendKeys, setHiddenLegendKeys] = useState<HiddenLegendKeys>({});
  const mapCatalog = useMapAxisCatalog();
  const { materials, loading, error } = useDraftWayValues(axisId, draft, fetchTile, viewport);

  const published = mapCatalog.dedicatedAxes.find((axis) => axis.axisId === axisId);
  const axis = useMemo(
    () => (published ? { ...published, ...DRAFT_PAINTING, display: paint } : unpublishedAxis(axisId, label, paint)),
    [published, axisId, label, paint],
  );
  const legend = lensLegend(axisId, false, { routeStyleModes: [], dedicatedAxes: [axis] });
  const scene = useMemo(
    () =>
      buildMapScene(
        sceneInputsFrom({
          look: {
            layerVisibility: NO_LAYERS,
            dynamicWeather: {},
            lens: LENS_DIFFICULTY_ID,
            paintedAxisId: axisId,
            roadClasses: NO_ROAD_CLASSES,
            wayMaterials: new Map([[axisId, { materials, loading }]]),
            wayConditions: NO_CONDITIONS,
            hiddenLegendKeys,
          },
          catalog: { dedicatedAxes: [axis], routeStyleModes: mapCatalog.routeStyleModes, roadLayers: NO_ROAD_LAYERS },
          routes: [],
          selectedRouteId: null,
          spliceStretches: [],
          splicedRoute: null,
          tileVersions: mapCatalog.tileVersions,
          inspectedWayId: null,
          travelledKm: null,
          selectedRouteSegment: null,
        }),
      ),
    [axisId, axis, materials, loading, hiddenLegendKeys, mapCatalog.routeStyleModes, mapCatalog.tileVersions],
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const map = createBaseMap({
      container: containerRef.current,
      center: [DEFAULT_LOCATION.longitude, DEFAULT_LOCATION.latitude],
      zoom: ORIGIN_ZOOM,
    });
    mapRef.current = map;
    function reportViewport() {
      const bounds = map.getBounds();
      if (!bounds) return;
      setViewport({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
      });
    }
    map.on("load", reportViewport);
    map.on("moveend", reportViewport);
    map.on("resize", reportViewport);
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (mapRef.current) applyScene(mapRef.current, scene);
  }, [scene]);

  return (
    <section aria-label="下書きの点数の地図" className="flex flex-col gap-1">
      <p className={textVariants({ variant: "heading" })}>下書きの点数の地図</p>
      <p className={textVariants({ variant: "hint" })}>
        見ている範囲の道を、下書きの点のつけ方で求めた点数と、下書きの段で塗ります。向きで変わる軸は北へ走る向き、時刻で変わる軸は画面を開いた時刻、速さで変わる軸は既定の速さで求めます。
      </p>
      <div className="grid gap-2 lg:grid-cols-[1fr_12rem]">
        <div ref={containerRef} className="h-[28rem] w-full overflow-hidden rounded-sm" />
        <LegendCheckboxList
          legend={legend}
          hiddenKeys={hiddenKeysOf(hiddenLegendKeys, axisId)}
          onToggle={(key) => setHiddenLegendKeys((store) => toggleHiddenKey(store, axisId, key))}
          listClassName="m-0 flex list-none flex-col gap-0.5 p-0"
          rowClassName="flex items-center gap-1.5 text-[length:var(--font-size-sm)]"
          swatchClassName={LEGEND_SWATCH_CLASS}
        />
      </div>
      {error && <p className={textVariants({ variant: "error" })}>{error}</p>}
    </section>
  );
}
