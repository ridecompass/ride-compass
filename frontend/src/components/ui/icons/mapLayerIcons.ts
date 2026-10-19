// 地図のレイヤーのアイコン。地図の「表示」の一覧と、道のりのグラフの地点の詳しくのチップが同じこの表を引く——別々に持つと、
// 同じレイヤーが画面によって違う形に見える。

import { RouteIcon, type MapIconComponent } from "@/components/ui/icons/icons";
import {
  AccidentIcon,
  ElevationIcon,
  HillshadeIcon,
  LandcoverIcon,
  OnewayIcon,
  RoadIcon,
  RoadSurfaceIcon,
  StopPlaceIcon,
  StopPoiIcon,
  SupplyPoiIcon,
  TrackGradeIcon,
  TunnelIcon,
} from "@/components/ui/icons/layerIcons";
import { BicycleIcon, RaindropIcon, ShieldIcon, WindIcon } from "@/components/ui/icons/lucideIcons";
import { mapDisplay } from "@/types/generated/mapDisplay";

/** 源泉が宣言する、地図に載るものの名前。 */
export type StaticMapLayerId = (typeof mapDisplay.layers)[number]["id"];

/** レイヤーのアイコン。省略できない（描く側の対応表で引く形だと、書き忘れても汎用のアイコンで見分けの付かないまま出続ける）。 */
export const MAP_LAYER_ICONS: Record<StaticMapLayerId, MapIconComponent> = {
  elevation: ElevationIcon,
  hillshade: HillshadeIcon,
  landcover: LandcoverIcon,
  stop_poi: StopPoiIcon,
  supply_poi: SupplyPoiIcon,
  stop_place: StopPlaceIcon,
  accident_point: AccidentIcon,
  precipitationNowcast: RaindropIcon,
  windVector: WindIcon,
  disaster: ShieldIcon,
  route: RouteIcon,
};

/** 道の線の層のアイコンの絵。鍵は層のデータ（軸カタログの`road_classes.map_layers`の`icon`）が指す。 */
const ROAD_LAYER_ICONS: ReadonlyMap<string, MapIconComponent> = new Map([
  ["highway", RoadIcon],
  ["surface", RoadSurfaceIcon],
  ["tracktype", TrackGradeIcon],
  ["tunnel", TunnelIcon],
  ["oneway", OnewayIcon],
  ["cycleway", BicycleIcon],
]);

/** 道の線の層のアイコン。知らない鍵には道路の絵を出す（層はデータだけで足せるので、絵より先に鍵が届きうる）。 */
export function roadLayerIcon(iconKey: string): MapIconComponent {
  return ROAD_LAYER_ICONS.get(iconKey) ?? RoadIcon;
}
