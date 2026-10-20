// 地図レイヤーのカタログ。地図のチップとその▶パネルがこの並びを列挙して描く。種別・情報源・性質・既定の表示・名前・
// 説明は源泉（backendの`domain/map_display.py`と、道の線の層は軸カタログの`road_classes.map_layers`）が宣言し、ここは
// アイコンと表示専用の凡例だけを足す。
// 地図に描く宣言（`scene/groups/`、絞り込める凡例は`scene/legends.ts`）は別に要る——書き忘れるとチップはONになり
// 凡例も出るのに、地図には何も出ない。

import weatherScales from "@/types/generated/weather-scales.json";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { MapIconComponent } from "@/components/ui/icons/icons";
import { MAP_LAYER_ICONS, roadLayerIcon, type StaticMapLayerId } from "@/components/ui/icons/mapLayerIcons";
import type { LegendEntry } from "@/lib/mapDisplay/legendFilter";
import { TILE_VERSION_GATED_SOURCES } from "@/lib/mapDisplay/tileVersionGated";
import { LANDCOVER_PAINTED_CLASSES } from "@/lib/mapDisplay/landcoverClasses";
import { PRECIPITATION_INTENSITY_LEVELS } from "./precipitationNowcast";
import { WIND_SPEED_LEGEND_LEVELS } from "./windLayer";
import type { MapAxisCatalog } from "@/features/map/mapAxisCatalog";
import { axisNamesInText, type CatalogAxis } from "@/lib/catalogAxis";
import { primaryAttributeIdsToLayerIds } from "@/features/map/layers/primaryAttributes";
import type { RoadMapLayerView } from "@/types/route";
import { DISASTER_ELEMENTS } from "@/features/map/scene/groups/weather";
import { DIFFICULTY_LENS_LABEL } from "@/lib/mapDisplay/routeStyleModes";

/** 地図に載るものの名前。静的な一覧は源泉が持ち、道の線の層（鍵は層のデータが決める）と軸スタジオ由来のものは実行時に決まる。 */
export type MapLayerId = StaticMapLayerId | DedicatedWayValueMapLayerId | string;

// 選んだルートに付くデータ（選び直すたびに描き直す）か、地域に固定のデータ（表示の切り替えだけ）か。値が時間で
// 変わるかは別の`dataNature`が表す（降水ナウキャストは地域に固定で、値が時間で変わる）。
type MapLayerKind = (typeof mapDisplay.layerKinds)[number];

// 地域に固定のレイヤーの中分類（▶パネルの見出し）。ルートは持たない。
export type MapLayerCategory = (typeof mapDisplay.layerCategories)[number]["key"];

export const MAP_LAYER_CATEGORY_ORDER: readonly MapLayerCategory[] = mapDisplay.layerCategories.map(
  (category) => category.key,
);

/** 生データか、複数の要因から計算した推定指標（合成）か、時刻で中身が変わるデータか。 */
type MapLayerDataNature = (typeof mapDisplay.layerDataNatures)[number];

/** 絞り込めない表示専用の凡例の1ブロック（配信元が色を焼き込んだラスタ等）。絞り込める凡例は`scene/legends.ts`が出す。 */
interface ReadOnlyLegendBlock {
  /** ブロックの見出し。単一ブロックのレイヤーは空文字列。 */
  label: string;
  legend: readonly LegendEntry[];
}

/** 名前付きソースの宣言（同じソースを名乗る要素は名前・説明を共有するので、先頭の要素で引く）。 */
function weatherSourceOf(source: string) {
  const element = mapDisplay.weatherElements.find((candidate) => candidate.source === source);
  if (!element?.description) throw new Error(`${source}は説明を宣言していない`);
  return { label: element.label, description: element.description };
}

const LINEAR_RAINBAND = weatherSourceOf("linearRainband");
const LINEAR_RAINBAND_AREA = weatherSourceOf("linearRainbandArea");

type WeatherElementDeclaration = (typeof mapDisplay.weatherElements)[number];

/** 名前の並び。同じ名前を名乗る要素（描き方違いの同じ名前付きソース）は1つにする。 */
function labelList(elements: readonly WeatherElementDeclaration[]): string {
  return [...new Set(elements.map((element) => element.label))].join("・");
}

/** 災害の凡例。同じ段で塗る要素の名前を見出しにして、段を並べる（並びは要素が最初に現れた順）。 */
function disasterLegendBlocks(): ReadOnlyLegendBlock[] {
  const scales = [...new Set(DISASTER_ELEMENTS.flatMap((element) => element.levelScale ?? []))];
  return scales.map((scale) => ({
    label: labelList(DISASTER_ELEMENTS.filter((element) => element.levelScale === scale)),
    legend: weatherScales[scale],
  }));
}

const READ_ONLY_LEGENDS: Partial<Record<StaticMapLayerId, readonly ReadOnlyLegendBlock[]>> = {
  landcover: [
    {
      label: "",
      legend: LANDCOVER_PAINTED_CLASSES.map((cls) => ({
        key: cls.percentField,
        label: cls.label,
        description: cls.description,
        color: cls.color,
      })),
    },
  ],
  // 1つのチップのまま、時刻の段ごとに配信元を切り替える（段は源泉が宣言する）。
  precipitationNowcast: [
    {
      label: "",
      legend: PRECIPITATION_INTENSITY_LEVELS,
    },
    {
      label: LINEAR_RAINBAND.label,
      // 色は配信元の塗り色そのもの。
      legend: [
        {
          key: "linearRainband",
          label: LINEAR_RAINBAND.description,
          color: weatherScales.linear_rainband_color,
        },
      ],
    },
    {
      label: LINEAR_RAINBAND_AREA.label,
      legend: [
        {
          key: "linearRainbandArea",
          label: LINEAR_RAINBAND_AREA.description,
          color: weatherScales.linear_rainband_outline_color,
        },
      ],
    },
  ],
  // 道路の色分け（向かい風・追い風）と別の配色なので、凡例は「矢印[風速]」と明示する。
  windVector: [
    {
      label: "矢印[風速]",
      legend: WIND_SPEED_LEGEND_LEVELS,
    },
  ],
  // 配信元が色を焼き込んだ画像なので絞り込めない。
  disaster: disasterLegendBlocks(),
};

/** そのレイヤーの絵がどこから来るか。取得状態はここから導く（同じタイルを読むレイヤーは同時に空・失敗になる）。
 * `ownFetch`はMapLibreのソースを経由せず自前で取るもので、取得状態はそのフェッチ自身が出す。 */
export type MapLayerDataSource = (typeof mapDisplay.layerDataSources)[number]["key"];

/** 地図のチップの最上位のグループ（何についての情報か。例: 道路・環境・スポット）。評価軸はどれにも属さない。 */
export type MapOverlayGroup = (typeof mapDisplay.overlayGroups)[number]["key"];

export const MAP_OVERLAY_GROUP_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  mapDisplay.overlayGroups.map((group) => [group.key, group.label]),
);
/** チップの表示順。**源泉の並びがそのまま並び順**（画面は並べ替えない）。 */
export const MAP_OVERLAY_GROUP_ORDER: readonly MapOverlayGroup[] = mapDisplay.overlayGroups.map((group) => group.key);

/** 種別が属するグループ。種別を1つ足すときは源泉の側で所属も決まる。 */
const GROUP_BY_CATEGORY: Readonly<Record<string, MapOverlayGroup>> = Object.fromEntries(
  mapDisplay.layerCategories.map((category) => [category.key, category.group]),
);

/** 軸スタジオ由来のレイヤー（評価軸で道を塗るもの）か。地図のチップに出さない。idの集合でなく記述子の印で決める。 */
export function isAxisStudioLayer(layer: MapLayerDescriptor): layer is AxisStudioLayerDescriptor {
  return layer.axisStudioLayer === true;
}

/** チップが属するグループ。中分類だけで決めるので、軸スタジオ由来のレイヤーは渡さない——チップの一覧
 * （`features/map/view/overlayChips.ts: overlayChips`）が先に除く。 */
export function mapOverlayGroupFor(layer: { category?: MapLayerCategory }): MapOverlayGroup | undefined {
  if (layer.category === undefined) return undefined;
  return GROUP_BY_CATEGORY[layer.category];
}

/** チップに出るレイヤー。 */
export interface ChipLayerDescriptor {
  id: MapLayerId;
  label: string;
  kind: MapLayerKind;
  icon: MapIconComponent;
  /** 省略できない（書き忘れたレイヤーは取得状態を持たず、チップの状態の印が出ない）。 */
  dataSource: MapLayerDataSource;
  /** ▶を開いたときの表示専用の凡例。無いレイヤーは絞り込める凡例か、画面の状態から組む凡例を持つ。 */
  readOnlyLegend?: readonly ReadOnlyLegendBlock[];
  axisStudioLayer?: never;
  /** 中分類（グループの判定・グループ内の並び・小見出し）。ルートは持たない。 */
  category?: MapLayerCategory;
  dataNature?: MapLayerDataNature;
  /** ONにすると何が出るかの短い説明（チップのtitle）。 */
  description: string;
  /** 表示の設定パネルで項目の(i)が出す、descriptionより詳しい説明。 */
  panelHint?: string;
  defaultOn?: boolean;
  /** このズーム未満では配信元のタイルが要求されない（ONにしても何も出ない。チップに案内を出す）。 */
  tileMinZoom?: number;
}

type LayerDeclaration = Pick<
  ChipLayerDescriptor,
  "dataSource" | "kind" | "category" | "dataNature" | "defaultOn" | "tileMinZoom"
>;

/** 軸スタジオ由来のレイヤー。チップに出ない（表示はレンズだけが決める）ので、名前・アイコン・説明を持たず、
 * 地図の組み立てが情報源を引くためのidと源泉の宣言だけを持つ。 */
export interface AxisStudioLayerDescriptor extends LayerDeclaration {
  id: MapLayerId;
  axisStudioLayer: true;
}

export type MapLayerDescriptor = ChipLayerDescriptor | AxisStudioLayerDescriptor;

/** 源泉が宣言する、描き方以外のもの（種別・情報源・性質・既定表示）。最小ズームは情報源が持つ。 */
function declaredLayer(spec: {
  dataSource: MapLayerDataSource;
  category: MapLayerCategory | null;
  kind: MapLayerKind;
  dataNature: MapLayerDataNature;
  defaultOn: boolean;
}): LayerDeclaration {
  const minZoom = mapDisplay.layerDataSources.find((source) => source.key === spec.dataSource)!.minZoom;
  return {
    dataSource: spec.dataSource,
    kind: spec.kind,
    category: spec.category ?? undefined,
    dataNature: spec.dataNature,
    defaultOn: spec.defaultOn,
    tileMinZoom: minZoom ?? undefined,
  };
}

/** 源泉の説明の文の差し込み口。 */
type LayerTextSlot =
  | Extract<NonNullable<(typeof mapDisplay.layers)[number]["description" | "panelHint"]>[number], { name: string }>
  | Extract<RoadMapLayerView["panel_hint"][number], { name: string }>;

type LayerTextPart = string | LayerTextSlot;

/** 説明の文の差し込み口の名前（源泉が宣言する）。 */
type LayerTextSlotName = LayerTextSlot["name"];

/** 源泉の説明の文の差し込み口を埋める。値が空の口は、前後の文ごと出さない。 */
function fillLayerText(text: readonly LayerTextPart[], values: Readonly<Record<LayerTextSlotName, string>>): string {
  return text
    .map((part) => {
      if (typeof part === "string") return part;
      const value = values[part.name];
      return value ? `${part.before}${value}${part.after}` : "";
    })
    .join("");
}

/** 収録年の言い方（連続なら範囲、飛んでいれば並べる）。年は取込の宣言が正本で、軸カタログが運ぶ。 */
function coverageYearsLabel(years: readonly number[]): string {
  if (years.length === 0) return "";
  const sorted = [...years].sort((a, b) => a - b);
  if (sorted.length === 1) return `${sorted[0]}年`;
  const continuous = sorted.every((year, index) => index === 0 || year === sorted[index - 1] + 1);
  return continuous ? `${sorted[0]}〜${sorted[sorted.length - 1]}年` : `${sorted.join("・")}年`;
}

/** レイヤーの一覧を組むのに要る軸カタログの項目。 */
type LayerCatalog = Pick<MapAxisCatalog, "axes" | "dedicatedAxes" | "accidentYears" | "roadLayers">;

export const NO_AXES: LayerCatalog = { axes: [], dedicatedAxes: [], accidentYears: [], roadLayers: [] };

/** 軸が材料として読む元データを見せるレイヤー（一次属性の層と、区分を決める材料を読む道の線の層）。 */
export function axisMapLayerIds(axis: CatalogAxis): readonly MapLayerId[] {
  return [...primaryAttributeIdsToLayerIds(axis.primaryAttributeIds), ...axis.roadLayerIds];
}

/** そのレイヤーが見せる元データを材料に持つ公開中の評価の名前（「A」「B」）。無ければ空文字で、呼ぶ側は評価に触れる一文を出さない。 */
function axisNamesReading(axes: readonly CatalogAxis[], layerId: MapLayerId): string {
  return axisNamesInText(axes.filter((axis) => axisMapLayerIds(axis).includes(layerId)));
}

const CATEGORY_KEYS: ReadonlySet<string> = new Set(MAP_LAYER_CATEGORY_ORDER);

/** 層のデータが指す中分類。知らない鍵は中分類なし（どのグループにも入らず、チップに出ない）。 */
function knownCategory(key: string): MapLayerCategory | null {
  return CATEGORY_KEYS.has(key) ? (key as MapLayerCategory) : null;
}

export function buildMapLayers({
  axes,
  dedicatedAxes,
  accidentYears,
  roadLayers,
}: LayerCatalog): readonly MapLayerDescriptor[] {
  // 取れていないときは年に触れない（既定の年を出すと、それが正しいように見える）。
  const accidentCoverage = coverageYearsLabel(accidentYears);
  // 並びはレンズの選択肢と同じ（公開中の評価と総合難易度）。
  const routeLenses = [...axes.map((axis) => axis.label), DIFFICULTY_LENS_LABEL].join("・");
  const staticLayers = mapDisplay.layers.map((layer): ChipLayerDescriptor => {
    const slots = { axes: axisNamesReading(axes, layer.id), accidentYears: accidentCoverage, routeLenses };
    return {
      id: layer.id,
      label: layer.label,
      ...declaredLayer(layer),
      icon: MAP_LAYER_ICONS[layer.id],
      readOnlyLegend: READ_ONLY_LEGENDS[layer.id],
      description: fillLayerText(layer.description, slots),
      panelHint: layer.panelHint ? fillLayerText(layer.panelHint, slots) : undefined,
    };
  });
  const roadLayerChips = roadLayers.map((layer): ChipLayerDescriptor => {
    const slots = { axes: axisNamesReading(axes, layer.id), accidentYears: "", routeLenses: "" };
    return {
      id: layer.id,
      label: layer.label,
      ...declaredLayer({ ...mapDisplay.axisLayers.road, category: knownCategory(layer.category) }),
      icon: roadLayerIcon(layer.icon),
      description: fillLayerText(layer.description, slots),
      panelHint: layer.panel_hint.length > 0 ? fillLayerText(layer.panel_hint, slots) : undefined,
    };
  });
  return [
    ...staticLayers,
    ...roadLayerChips,
    // 評価軸は軸カタログから作る（軸を公開すればここを変えずに現れる）。チップには出ないが、地図の組み立てが情報源をここから引く（無いと描く時点で落ちる）。
    ...dedicatedAxes.map((axis): AxisStudioLayerDescriptor => ({
      id: dedicatedWayValueMapLayerId(axis.axisId),
      ...declaredLayer(mapDisplay.axisLayers.dedicated),
      axisStudioLayer: true,
    })),
  ];
}

export type MapLayerVisibility = Record<MapLayerId, boolean>;

/** チップ下に出す、ズーム不足の案内。 */
export const TILE_ZOOM_TOO_WIDE_NOTICE = "ズームインすると表示されます";

/** チップ下に出す、タイルの世代が届いていないときの案内（届くまでソースを作らないので何も描けない）。 */
export const TILE_VERSIONS_MISSING_NOTICE = "配信情報を取得できず表示できません";

/** タイルの世代が届くまで何も描けないレイヤー。軸のレイヤーはチップが無く案内の出し先が無いので含めない。 */
export function tileVersionGatedLayerIds(layers: readonly MapLayerDescriptor[]): readonly MapLayerId[] {
  return layers
    .filter((layer) => !isAxisStudioLayer(layer) && TILE_VERSION_GATED_SOURCES.has(layer.dataSource))
    .map((layer) => layer.id);
}

/** そのズームではタイルが要求されず、ONにしても何も出ないレイヤー。軸のレイヤーはチップが無く案内の出し先が無いので含めない。 */
export function tileZoomTooWideLayerIds(layers: readonly MapLayerDescriptor[], zoom: number): readonly MapLayerId[] {
  return layers
    .filter((layer) => !isAxisStudioLayer(layer) && layer.tileMinZoom !== undefined && zoom < layer.tileMinZoom)
    .map((layer) => layer.id);
}

/** チップからON/OFFできるレイヤーの既定の表示。軸のレイヤーはレンズだけが決めるので持たない。 */
export function buildDefaultLayerVisibility(layers: readonly MapLayerDescriptor[]): MapLayerVisibility {
  return Object.fromEntries(
    layers.filter((layer) => !isAxisStudioLayer(layer)).map((layer) => [layer.id, layer.defaultOn === true]),
  );
}

// レイヤーごとの取得の状態。正常なときはキー自体を持たない。
export type LayerDataStatus = "loading" | "empty" | "error";
export type LayerDataStatusByLayer = Partial<Record<MapLayerId, LayerDataStatus>>;

export const LAYER_DATA_STATUS_LABELS: Record<LayerDataStatus, string> = {
  loading: "読み込み中です",
  empty: "この範囲に表示できるデータがありません",
  error: "データの取得に失敗しました。しばらくしてから再読み込みしてください",
};

/** 開いたパネルへ文として出す状態。待ちは絞り込み・ON/OFFの取り直しのたびに一瞬出ては消え、パネルの中身を
 * 揺らすため文にせず、ドットだけで示す。 */
export function layerDataStatusNotice(status: LayerDataStatus | undefined): string | null {
  return status && status !== "loading" ? LAYER_DATA_STATUS_LABELS[status] : null;
}

/** 自前で取るレイヤーの取得の状態（失敗 > 読み込み中 > 取れたが値なし）。まだ一度も取れていない間を「値なし」に
 * しない（有効にした直後や、取得がそもそも走っていない状態が「データが無い」と読めてしまう）。 */
export function deriveFetchLayerStatus(
  loading: boolean,
  error: string | null,
  hasPayload: boolean,
  hasFetched: boolean,
): LayerDataStatus | undefined {
  if (error) return "error";
  if (loading) return "loading";
  if (!hasFetched) return undefined;
  if (!hasPayload) return "empty";
  return undefined;
}

type DedicatedWayValueMapLayerId = `${string}Axis`;

function dedicatedWayValueMapLayerId(axisId: string): DedicatedWayValueMapLayerId {
  return `${axisId}Axis`;
}
