// 地図レイヤーのカタログ。地図のチップとその▶パネルがこの並びを列挙して描く。種別・情報源・性質・既定の表示・名前・
// 説明は源泉（backendの`domain/map_display.py`と、道の線の層は軸カタログの`road_classes.map_layers`）が宣言し、ここは
// アイコンと表示専用の凡例（`layers/readOnlyLegends.ts`）だけを足す。
// 地図に描く宣言（`scene/groups/`、絞り込める凡例は`scene/legends.ts`）は別に要る——書き忘れるとチップはONになり
// 凡例も出るのに、地図には何も出ない。

import { mapDisplay } from "@/types/generated/mapDisplay";
import type { MapIconComponent } from "@/components/ui/icons/icons";
import { MAP_LAYER_ICONS, roadLayerIcon, type StaticMapLayerId } from "@/components/ui/icons/mapLayerIcons";
import { TILE_VERSION_GATED_SOURCES } from "@/lib/mapDisplay/tileVersionGated";
import type { MapAxisCatalog } from "@/features/map/mapAxisCatalog";
import { CLIENT_TUNING_IDS, clientTuningValue } from "@/lib/axisCatalog";
import { axisNamesInText, type CatalogAxis } from "@/lib/catalogAxis";
import { primaryAttributeIdsToLayerIds } from "@/features/map/layers/primaryAttributes";
import { DIFFICULTY_LENS_LABEL } from "@/lib/mapDisplay/routeStyleModes";
import { READ_ONLY_LEGENDS, type ReadOnlyLegendBlock } from "./readOnlyLegends";
import { coverageYearsLabel, fillLayerText } from "./layerText";

/** 地図に載るものの名前。静的な一覧は源泉が持ち、道の線の層（鍵は層のデータが決める）と軸スタジオ由来のものは実行時に決まる。 */
export type MapLayerId = StaticMapLayerId | string;

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
  /** このズーム未満では、配信元がタイルを配らないか、層が描かない（ONにしても何も出ない。チップに案内を出す）。 */
  minZoom?: number;
}

type LayerDeclaration = Pick<
  ChipLayerDescriptor,
  "dataSource" | "kind" | "category" | "dataNature" | "defaultOn" | "minZoom"
>;

/** 軸スタジオ由来のレイヤー。チップに出ない（表示はレンズだけが決める）ので、名前・アイコン・説明を持たず、
 * 地図の組み立てが情報源を引くためのidと源泉の宣言だけを持つ。 */
interface AxisStudioLayerDescriptor extends LayerDeclaration {
  id: MapLayerId;
  axisStudioLayer: true;
}

export type MapLayerDescriptor = ChipLayerDescriptor | AxisStudioLayerDescriptor;

/** 源泉が宣言する、描き方以外のもの（種別・情報源・性質・既定表示）。最小ズームは、情報源が配る縮尺と層が描き始める縮尺の寄った方。 */
function declaredLayer(spec: {
  dataSource: MapLayerDataSource;
  category: MapLayerCategory | null;
  kind: MapLayerKind;
  dataNature: MapLayerDataNature;
  defaultOn: boolean;
  drawMinZoom: number | null;
}): LayerDeclaration {
  const sourceMinZoom = mapDisplay.layerDataSources.find((source) => source.key === spec.dataSource)!.minZoom;
  const minZooms = [sourceMinZoom, spec.drawMinZoom].filter((zoom): zoom is number => zoom !== null);
  return {
    dataSource: spec.dataSource,
    kind: spec.kind,
    category: spec.category ?? undefined,
    dataNature: spec.dataNature,
    defaultOn: spec.defaultOn,
    minZoom: minZooms.length === 0 ? undefined : Math.max(...minZooms),
  };
}

/** レイヤーの一覧を組むのに要る軸カタログの項目。 */
type LayerCatalog = Pick<MapAxisCatalog, "axes" | "dedicatedAxes" | "accidentYears" | "clientTuning" | "roadLayers">;

export const NO_AXES: LayerCatalog = {
  axes: [],
  dedicatedAxes: [],
  accidentYears: [],
  clientTuning: {},
  roadLayers: [],
};

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
  clientTuning,
  roadLayers,
}: LayerCatalog): readonly MapLayerDescriptor[] {
  // 取れていないときは年に触れない（既定の年を出すと、それが正しいように見える）。
  const accidentCoverage = coverageYearsLabel(accidentYears);
  // 並びはレンズの選択肢と同じ（公開中の評価と総合難易度）。
  const routeLenses = [...axes.map((axis) => axis.label), DIFFICULTY_LENS_LABEL].join("・");
  // 取れていないときは帯の幅に触れない（既定の幅を出すと、作り直しに使った幅と食い違いうる）。
  const landcoverRingOuterM = String(clientTuningValue({ clientTuning }, CLIENT_TUNING_IDS.landcoverRingOuterM) ?? "");
  const staticLayers = mapDisplay.layers.map((layer): ChipLayerDescriptor => {
    const slots = {
      axes: axisNamesReading(axes, layer.id),
      accidentYears: accidentCoverage,
      routeLenses,
      landcoverRingOuterM,
    };
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
    const slots = {
      axes: axisNamesReading(axes, layer.id),
      accidentYears: "",
      routeLenses: "",
      landcoverRingOuterM: "",
    };
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

/** そのズームでは描かれず、ONにしても何も出ないレイヤー。軸のレイヤーはチップが無く案内の出し先が無いので含めない。 */
export function tileZoomTooWideLayerIds(layers: readonly MapLayerDescriptor[], zoom: number): readonly MapLayerId[] {
  return layers
    .filter((layer) => !isAxisStudioLayer(layer) && layer.minZoom !== undefined && zoom < layer.minZoom)
    .map((layer) => layer.id);
}

/** チップからON/OFFできるレイヤーの既定の表示。軸のレイヤーはレンズだけが決めるので持たない。 */
export function buildDefaultLayerVisibility(layers: readonly MapLayerDescriptor[]): MapLayerVisibility {
  return Object.fromEntries(
    layers.filter((layer) => !isAxisStudioLayer(layer)).map((layer) => [layer.id, layer.defaultOn === true]),
  );
}

// レイヤーごとの取得の状態。正常なときはキー自体を持たない。
export type LayerDataStatus = "loading" | "empty" | "error" | "partial";
export type LayerDataStatusByLayer = Partial<Record<MapLayerId, LayerDataStatus>>;

export const LAYER_DATA_STATUS_LABELS: Record<LayerDataStatus, string> = {
  loading: "読み込み中です",
  empty: "この範囲に表示できるデータがありません",
  error: "データの取得に失敗しました。しばらくしてから再読み込みしてください",
  partial: "画面の端の道は、拡大すると色が付きます",
};

/** 開いたパネルへ文として出す状態。待ちは絞り込み・ON/OFFの取り直しのたびに一瞬出ては消え、パネルの中身を
 * 揺らすため文にせず、ドットだけで示す。 */
export function layerDataStatusNotice(status: LayerDataStatus | undefined): string | null {
  return status && status !== "loading" ? LAYER_DATA_STATUS_LABELS[status] : null;
}

/** 自前で取るレイヤーの取得の状態（失敗 > 読み込み中 > 画面の一部だけ取った > 取れたが値なし）。まだ一度も取れていない間を
 * 「値なし」にしない（有効にした直後や、取得がそもそも走っていない状態が「データが無い」と読めてしまう）。一部だけ取った間も
 * 「値なし」にしない（取らなかった所に値があるかは分からない）。 */
export function deriveFetchLayerStatus(
  loading: boolean,
  error: string | null,
  hasPayload: boolean,
  hasFetched: boolean,
  truncated = false,
): LayerDataStatus | undefined {
  if (error) return "error";
  if (loading) return "loading";
  if (!hasFetched) return undefined;
  if (truncated) return "partial";
  if (!hasPayload) return "empty";
  return undefined;
}

function dedicatedWayValueMapLayerId(axisId: string): MapLayerId {
  return `${axisId}Axis`;
}
