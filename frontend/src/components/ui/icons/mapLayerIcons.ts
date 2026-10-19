// 源泉が宣言する地図のレイヤー（生成物`mapDisplay.layers`）のアイコン。地図の「表示」の一覧と、道のりのグラフの地点の詳しくの
// チップが同じこの表を引く——別々に持つと、同じレイヤーが画面によって違う形に見える。

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
import { BicycleIcon, RaindropIcon, ShieldIcon } from "@/components/ui/icons/lucideIcons";
import { mapDisplay } from "@/types/generated/mapDisplay";

/** 源泉が宣言する、地図に載るものの名前。 */
export type StaticMapLayerId = (typeof mapDisplay.layers)[number]["id"];

/** レイヤーのアイコン。省略できない（描く側の対応表で引く形だと、書き忘れても汎用のアイコンで見分けの付かないまま出続ける）。 */
export const MAP_LAYER_ICONS: Record<StaticMapLayerId, MapIconComponent> = {
  elevation: ElevationIcon,
  hillshade: HillshadeIcon,
  landcover: LandcoverIcon,
  highway: RoadIcon,
  surface: RoadSurfaceIcon,
  tracktype: TrackGradeIcon,
  tunnel: TunnelIcon,
  oneway: OnewayIcon,
  cycleway: BicycleIcon,
  stop_poi: StopPoiIcon,
  supply_poi: SupplyPoiIcon,
  stop_place: StopPlaceIcon,
  accident_point: AccidentIcon,
  precipitationNowcast: RaindropIcon,
  disaster: ShieldIcon,
  route: RouteIcon,
};
