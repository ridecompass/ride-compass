// 意味の決まった汎用の形（lucide-react）を、自前の形と同じ呼び方と線の太さへ包んで書き出す。
import {
  ArrowUp,
  Bike,
  CircleQuestionMark,
  Clock,
  Cloud,
  CloudOff,
  Copy,
  CornerUpLeft,
  CornerUpRight,
  Download,
  Droplet,
  EllipsisVertical,
  Gauge,
  GitCommitHorizontal,
  History,
  Import,
  Info,
  Layers,
  ListChecks,
  Lock,
  Map as MapShape,
  MapPin,
  MapPinX,
  Minus,
  Moon,
  Navigation,
  Paintbrush,
  Play,
  Plus,
  RotateCw,
  Ruler,
  Save,
  Search,
  Shield,
  SlidersHorizontal,
  Snowflake,
  Star,
  Sun,
  Target,
  Thermometer,
  Trash,
  TriangleAlert,
  Wind,
  Zap,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { LUCIDE_STROKE_WIDTH, type IconProps, type MapIconComponent } from "./icons";

/** lucideの形を、自前のアイコンと同じ呼び方（`size`だけを受け、既定16px）と
 * 同じ線の太さ（表示の大きさに対する比）にそろえる。 */
function fromLucide(Icon: LucideIcon, defaultSize = 16): MapIconComponent {
  return function LucideMapIcon({ size = defaultSize }: IconProps) {
    return <Icon size={size} strokeWidth={LUCIDE_STROKE_WIDTH} />;
  };
}

export const WarningTriangleIcon = fromLucide(TriangleAlert);
export const WindIcon = fromLucide(Wind);
export const BicycleIcon = fromLucide(Bike);
/** 呼び出し側が風向のぶん回転させて使うため、上向きのまっすぐな矢印にしてある。 */
export const WindDirectionArrowIcon = fromLucide(ArrowUp);
export const ThermometerIcon = fromLucide(Thermometer);
/** 走行モード（現在地を追い続けて地図を動かす）。 */
export const RideModeIcon = fromLucide(Navigation);
export const RaindropIcon = fromLucide(Droplet);
export const SunIcon = fromLucide(Sun);
export const MoonIcon = fromLucide(Moon);
export const CloudIcon = fromLucide(Cloud);
export const SnowflakeIcon = fromLucide(Snowflake);
export const GenerateRoutesIcon = fromLucide(Play);
/** 生成した候補を捨てる。バツ印にしない——パネルを閉じる✕の隣に並び、同じ形だと見分けられない。 */
export const ClearRoutesIcon = fromLucide(Trash);
/** 保存した設定を消す。 */
export const DeleteSavedIcon = fromLucide(Trash);
/** 保存した設定を各タブへ呼び出す（取り込む）。 */
export const RecallSavedIcon = fromLucide(Import);
/** いまの設定を名前を付けて保存する。 */
export const SaveConditionsIcon = fromLucide(Save);
/** 地点を保存する（まだ保存していない地点）。 */
export const SavePlaceIcon = fromLucide(Star);
/** 保存した地点（塗った星。保存していない地点の`SavePlaceIcon`と対で、保存したかを形で見分ける）。 */
export function SavedPlaceIcon({ size = 16 }: IconProps) {
  return <Star size={size} strokeWidth={LUCIDE_STROKE_WIDTH} fill="currentColor" />;
}
export const InfoIcon = fromLucide(Info, 14);
export const ZoomInIcon = fromLucide(Plus);
export const ZoomOutIcon = fromLucide(Minus);
export const CopyIcon = fromLucide(Copy);
export const RedrawMapIcon = fromLucide(RotateCw);
/** 群の中で一覧に並べる項目を選ぶ。 */
export const ChooseItemsIcon = fromLucide(ListChecks);
/** 評価軸の点数で道を塗る（「評価で塗る」の入口）。 */
export const EvaluationPaintIcon = fromLucide(Paintbrush);
export const RouteSettingsIcon = fromLucide(SlidersHorizontal);
export const ShieldIcon = fromLucide(Shield);
export const TargetIcon = fromLucide(Target);
export const ClockIcon = fromLucide(Clock);
/** 最も早く着くルート。 */
export const FastestRouteIcon = fromLucide(Zap);
export const LayersStackIcon = fromLucide(Layers);
export const MenuIcon = fromLucide(EllipsisVertical);
export const DownloadIcon = fromLucide(Download);
export const SpeedGaugeIcon = fromLucide(Gauge);
export const HelpIcon = fromLucide(CircleQuestionMark);
/** 動いている版（コミット）。 */
export const VersionIcon = fromLucide(GitCommitHorizontal);
/** 地図で選んでいる区間の地点。 */
export const SelectedSpotIcon = fromLucide(MapPin);
/** 置いた経由地と目的地を一度に消す。ClearAllLayersIconと同じく、消す対象の形（地点のピン）にバツを添える。 */
export const ClearPointsIcon = fromLucide(MapPinX);
/** ルートの全長の目標を決める（押している間は全長が目標に合うルートを作る）。 */
export const DistanceTargetIcon = fromLucide(Ruler);
/** 置いた地点を1つ消す。保存したものを消す`DeleteSavedIcon`と同じく、消す操作はごみ箱の形にそろえる。 */
export const RemovePointIcon = fromLucide(Trash);
/** 利用者が変えられない選び方（いつも決まった値の行）。 */
export const LockedIcon = fromLucide(Lock);
/** 取れなかったものを取り直す。 */
export const RetryIcon = fromLucide(RotateCw);
/** 取れていない情報がある印。警報の色と取り違えないよう、三角の形を使わない。 */
export const NotFetchedIcon = fromLucide(CloudOff);
/** 時刻を送った重ねを、いまの時刻に戻す。 */
export const BackToNowIcon = fromLucide(History);
/** 地図で選んだ道の評価を調べる。 */
export const InspectRoadIcon = fromLucide(Search);
/** 選んだ区間へ地図を寄せる。 */
export const ShowSectionOnMapIcon = fromLucide(ZoomIn);
/** 編集で作ったルートの元にしたルートを見る。 */
export const ShowOriginIcon = fromLucide(CornerUpLeft);
/** 走行中の曲がる所の案内: 左折。 */
export const TurnLeftIcon = fromLucide(CornerUpLeft);
/** 走行中の曲がる所の案内: 右折。 */
export const TurnRightIcon = fromLucide(CornerUpRight);
/** 畳んだ俯瞰図を開く。 */
export const OverviewMapIcon = fromLucide(MapShape);
