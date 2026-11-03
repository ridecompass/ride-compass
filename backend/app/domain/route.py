import math
from collections import defaultdict

from typing import Annotated, Any, Callable, Iterable, Literal, Mapping, Sequence

from pydantic import WithJsonSchema

from app.domain.difficulty import weighted_mean_by_distance
from app.domain.attributes import ElevationAttribute
from app.domain.geo import Latitude, Longitude
from app.domain.gradient import GRADIENT_VALUE_DECIMALS
from app.domain.graph import LeanEdge
from app.domain.strict_model import StrictModel

#: 応答の距離（km）の桁。区間・ビン・候補の距離をこの桁へ丸める。
DISTANCE_KM_DECIMALS = 2
#: 応答の標高（m。獲得標高・区間の端の標高）の桁。
ELEVATION_M_DECIMALS = 1
#: 応答の秒（費用・代償の内訳）の桁。
COST_SECONDS_DECIMALS = 1
#: 応答の止まる回数の見込みの桁。
STOP_COUNT_DECIMALS = 1
#: 応答の風の速さ（m/s）の桁。
WIND_MS_DECIMALS = 1


# GeoJSONのLineString（座標は[経度, 緯度]）。契約には形を載せるが、検証はしない——数千点の座標を
# 組み立てのたびにたどることになる。形は組み立てる側（`_concat_segment_geometries`・
# `concat_edge_geometries`）が決める。
LineStringGeometry = Annotated[
    dict[str, Any],
    WithJsonSchema(
        {
            "type": "object",
            "properties": {
                "type": {"const": "LineString", "type": "string"},
                "coordinates": {"type": "array", "items": {"type": "array", "items": {"type": "number"}}},
            },
            "required": ["type", "coordinates"],
        }
    ),
]


class Coordinates(StrictModel):
    latitude: Latitude
    longitude: Longitude


class RoadClassStretch(StrictModel):
    """区間の中で、道の区分が同じまま続く部分。区間では検証せずに組み（`model_construct`）、ビンでは`merge_road_classes`が
    検証して作り直す。"""

    distance_km: float
    # 区分の鍵（`domain/route_road_classes.py: SegmentClassReader.values_at`）。どの区分にも入らない道はNone。
    value: str | None


class ElevationStretch(StrictModel):
    """区間の中の道（Edge）1本の、走る向きの始まりと終わりの標高（m）。その道に標高が無ければどちらもNone。"""

    # 区間では検証せずに組み（`model_construct`）、入れたビンを検証するときに検証する（`_merge_segment_bin`）。
    model_config = ConfigDict(revalidate_instances="always")

    distance_km: float
    start_elevation_m: float | None
    end_elevation_m: float | None


class CostBreakdown(StrictModel):
    """代償の秒の内訳（費目の帳簿の式、`domain/ledger_costs.py`）。所要時間・軸ごとの代償・回避指定の和が費用になる。

    軸の名前と帳簿は`GET /api/cost-axes`が持ち、回避指定の行の名前は同じ応答の`avoidance_label`が持つ。
    """

    # 軸id→代償の秒（つまみ×倍率を掛けたもの）。どの軸も0以上で、倍率0の軸も0として持つ。曲がる所の漕ぎ出しは、曲がった
    # 先の区間の慣性の費目の軸に入る。
    axis_seconds: dict[str, float]
    # 避け方の倍率（道の区分ごとの「なるべく避ける」）が、その道の所要時間と代償に上乗せした秒。
    avoidance_seconds: float


def merge_cost_breakdowns(parts: Iterable[CostBreakdown | None]) -> CostBreakdown | None:
    """内訳を足し合わせる（秒は足せる）。どれも無ければNone。"""
    present = [part for part in parts if part is not None]
    if not present:
        return None
    totals: dict[str, float] = defaultdict(float)
    for part in present:
        for axis_id, seconds in part.axis_seconds.items():
            totals[axis_id] += seconds
    return CostBreakdown.model_construct(
        axis_seconds={axis_id: round(seconds, COST_SECONDS_DECIMALS) for axis_id, seconds in totals.items()},
        avoidance_seconds=round(sum(part.avoidance_seconds for part in present), COST_SECONDS_DECIMALS),
    )


class RouteFacts(StrictModel):
    """ルートの事実の量（費用の式にも利用者の倍率にも依らない）。獲得標高は`EvaluatedRoute.elevation_gain_m`。"""

    # 標高の無い道の長さ（km）。獲得標高に数えず、所要時間は道路網全体の坂の割合で走った長さ。
    elevation_unknown_km: float
    # 止まる回数の見込み。止まる出来事と曲がる所を、止まってから漕ぎ出す回数に換えて足したもの（減速だけの出来事は、
    # 落とした速さから戻す分だけ1回より少なく数える）。所要時間の待ちと停止の軸の体力と同じ回数。
    stop_count: float
    # 基準の路面より転がり抵抗の大きい道の長さ（km）。
    rough_km: float
    # 進行方向への向かい風成分の距離平均（m/s、負は追い風）。風を使えなければNone。
    headwind_mean_ms: float | None
    # 道の負担の軸id→その軸の重さが0より大きい道の長さ（km）。費用の軸の定義が無ければ空。
    burden_km: dict[str, float]


class RouteSegmentDetail(StrictModel):
    """ルートの1区間（Edge、応答では`SEGMENT_BIN_DISTANCE_KM`ごとのビン）の詳細。地図のルートの線の塗りと区間の小窓が読む。

    符号付き材料（`material_values`に入る`gradient_percent`等）は**符号付き・進行方向
    基準**（登り=正、下り=負）。フロントの勾配色分けはこの符号を前提に「下り」カテゴリを
    持つため、絶対値で返してはならない。

    geometryはこの区間が実際に通る道なり形状（GeoJSON LineString、ルート全体geometryの
    部分列）。フロントはこれがnullの場合のみ始点・終点の直線で代替描画する。
    """

    geometry: LineStringGeometry | None = None
    start_latitude: float
    start_longitude: float
    end_latitude: float
    end_longitude: float
    cumulative_distance_km: float
    distance_km: float
    # 区間が候補の`edge_ids`のどこにあたるか（`edge_ids[edge_start:edge_end]`が区間の道）。区間の近くの点を引く口へ渡す鍵の範囲。
    edge_start: int
    edge_end: int
    # 区間の中の道ごとの両端の標高を、通る順に。道の距離の和は区間の距離と丸めの分だけずれうる。
    elevations: list[ElevationStretch]
    # 区間の続く坂の斜度（%、走る向きの符号つき）。道の一番急な登りと下りから`steepest_signed_percent`が作り、ビンへは
    # `merge_sustained_gradients`で畳む。値が無ければNone。
    sustained_gradient_percent: float | None = None
    estimated_arrival_time: str | None = None
    # 区間の代償の秒の内訳。費目の帳簿の式で組んでいなければNone。
    penalty: CostBreakdown | None = None
    # 材料id→値（値の無い材料はキーを持たない）。載せる材料は`domain/evaluation.py: displayed_material_ids`が選ぶ。
    material_values: dict[str, float]
    # 分け方（地図の道の線の層のid）と「緑と水」の層のid→区間の始まりから並べた、区分が同じまま続く部分。部分の距離の和は区間の距離と丸めの分だけずれうる。
    road_classes: dict[str, list[RoadClassStretch]]


#: 候補の種類。周回（出発地へ戻る経路。経由地の有無を問わない）・目的地（目的地で終わる経路。経由地の有無を問わない）・
#: 合成（区間を乗り換えて組み立てた経路）。
RouteKind = Literal["loop", "destination", "spliced"]


class RouteTurn(StrictModel):
    """経路が分かれ道で曲がる所。画面が走行中の曲がる所の案内に使う。

    `distance_km`は始点からその点までの道のりで、区間の`distance_km`を始点から足した値と同じ物差し（`along_route_km`）。
    """

    distance_km: float
    direction: Literal["left", "right", "uturn"]
    latitude: float
    longitude: float


class EvaluatedRoute(StrictModel):
    """エンジンが評価した1本の経路。並べ終えたあと、id・種類・最速の印を付けて`RouteCandidate`になる。"""

    # エンジンは周回の方位だけを付け、方位を持たない経路は空のまま。`RouteCandidate`になるときに付け直せる。
    direction_label: str
    distance_km: float
    geometry: LineStringGeometry
    elevation_gain_m: float | None
    segments: list[RouteSegmentDetail]
    # 所要時間の見積もり（秒）。区間の走行時間（`domain/cycling_speed.py`の走行モデルが巡航速度と区間の条件から求めた
    # 速度）＋停止の待ち＋ターンの待ち。経路の選び方には使っておらず、表示のためだけに持つ。
    estimated_duration_seconds: float | None
    # 並べ方の値（秒）。探索が最小にした費用そのもの（区間の費用＋曲がる所の費用）。費目の帳簿の式なら、所要時間と
    # 内訳（`penalty`）の和に、丸めの差を除いて等しい。
    cost_seconds: float
    # 候補全体の代償の秒の内訳。費目の帳簿の式で組んでいなければNone。
    penalty: CostBreakdown | None
    facts: RouteFacts
    # 所要時間の見積もりで風を使えなかった（風の予報が読めず、無風として計算した）。画面が利用者へ知らせる。
    wind_unavailable: bool
    # 所要時間の見積もりで、勾配か停止要因の件数の値が無く、既定（平地・待ち無し）で数えた区間の距離の割合（0〜1）。
    # 数えるのはビンへ畳む前のEdge単位。画面が「データの無い区間が◯%」と知らせる。区間が無ければNone。
    missing_travel_data_share: float | None
    # 経路を構成するEdge idの列（起点から順）。フロントは候補どうしの共通部分を集合演算で
    # 求め、別の道を通る区間を出すのに使う（区間の乗り換え）。
    # backendはステートレスのため、乗り換え後の経路もこのidの列で受け取って評価し直す。
    # エンジンが経路をEdgeの列として持たない場合は空のまま。
    edge_ids: list[str]
    # `geometry.coordinates`におけるEdgeの境界点の位置（`edge_ids`より1件多い）。
    # 隣接Edgeの境界点は重複させずに連結するため、座標列だけからはEdgeの境目を復元
    # できない。Edge単位で決めた区間を地図へ帯として描くのに使う
    # （`coordinates[offsets[i]:offsets[j] + 1]`がEdge i〜j-1の形状）。
    edge_point_offsets: list[int]
    # 経路が通るNode idの列（起点から順。`edge_ids`より1件多く、`node_ids[i]`が
    # `edge_ids[i]`の始点、末尾が終点）。フロントは「候補どうしが同じ地点を通るか」を
    # これで判定する——座標の完全一致でも実質は一致するが、乗り換えを鎖で伸ばすほど
    # 「同じ地点」の判定が結果を左右するため、グラフが持つ同一性をそのまま渡す。
    # `edge_ids`が空の候補では空のまま。
    node_ids: list[str]
    # 経路が分かれ道で曲がる所（左折・右折・Uターン）を経路の順に。分かれ道の無い点の曲がりと、浅い分岐で
    # いちばんまっすぐに近い道へ進む所は入れない（`domain/turn_structure.py: turns_along`）。`edge_ids`が空の候補では空のまま。
    turns: list[RouteTurn]
    # 置いた経由地を通る所の始点からの道のり（km）を、置いた順に。区間の始まりの道のりと同じ物差し（`along_route_km`）。
    # 区間の乗り換えで組んだ経路が置いた経由地を1つでも通らなければ空のまま（何番目が何番目の経由地かを崩さないため、一部だけ抜かない）。
    waypoint_distances_km: list[float]


class RouteCandidate(EvaluatedRoute):
    """応答の1本のルート候補。

    生成の応答は、目的地で終わる候補を費用（`cost_seconds`）、出発地へ戻る候補を1kmあたりの代償の秒の小さい順に並べる
    （`domain/route_search.py: candidate_order`）。
    """

    # 応答の中で一意のid・種類・最速の印は、並べ終えた最後に`services/route_generator.py: _label`だけが付ける。
    # エンジンが組み立てる時点（`EvaluatedRoute`）では並びも種類も決まっていない。どの候補も区間の乗り換えの元にできる
    # （合成の要求は終点を目的地、無ければ出発地として確かめる）。
    id: str
    # 終点が出発地なら`loop`、ほかの所なら`destination`、区間を乗り換えて作った経路は`spliced`。
    kind: RouteKind
    # 所要時間だけで探した1本（基準線）。距離を決めずに出発地と違う所で終わる生成で、比べる相手があるときだけ1本に付く。
    # 画面はこの1本を一覧の「最速」に置き、時間の列の基準にする。
    is_fastest: bool


def along_route_km(distances_km: Iterable[float]) -> list[float]:
    """始点から、並んだ区間それぞれの始まりまでの道のり（km）と、末尾に終わりまでの道のり。区間の距離を応答の桁へ丸めてから
    積むので、区間の`distance_km`を始点から足した値と同じ物差しになる（区間の始まりの道のりと曲がる所の道のりがこれを読む）。"""
    along = [0.0]
    for distance_km in distances_km:
        along.append(round(along[-1] + round(distance_km, DISTANCE_KM_DECIMALS), DISTANCE_KM_DECIMALS))
    return along


# エンジンが返すsegmentsはEdge単位（交差点間）でAPIペイロード・フロント描画コストが
# 嵩むため、この距離単位へ集約してから返す。
SEGMENT_BIN_DISTANCE_KM = 0.5


def route_bin_slices(distances_km: Sequence[float]) -> list[slice]:
    """連続する区間（距離km）を、累積距離が`SEGMENT_BIN_DISTANCE_KM`に達するごとに切ったビンの添字の範囲。最後のビンは
    `SEGMENT_BIN_DISTANCE_KM`未満でも単独で残す（切り捨てると経路全体の距離が合わなくなる）。"""
    slices: list[slice] = []
    start = 0
    current_bin_distance = 0.0
    for index, distance_km in enumerate(distances_km):
        current_bin_distance += distance_km
        if current_bin_distance >= SEGMENT_BIN_DISTANCE_KM:
            slices.append(slice(start, index + 1))
            start = index + 1
            current_bin_distance = 0.0
    if start < len(distances_km):
        slices.append(slice(start, len(distances_km)))
    return slices


def aggregate_segments_into_bins(segments: list[RouteSegmentDetail], slices: Sequence[slice]) -> list[RouteSegmentDetail]:
    """連続するEdge単位の`RouteSegmentDetail`を、ビン（`route_bin_slices`）ごとに1件の`RouteSegmentDetail`へ集約する。

    値の性質ごとに畳み方が違う（`BIN_FIELD_MERGERS`）: 材料値は距離加重平均（値がNoneの区間は除外し、残りの距離で
    再正規化）、代償の秒は和、位置はビンの始点・終点、距離は合計、geometryは隣接区間の境界点を重複させずに連結する。
    """
    return [_merge_segment_bin(segments[chunk]) for chunk in slices]


def _append_continuing(coordinates: list[list[float]], points: list[list[float]]) -> None:
    """`points`を`coordinates`へ継ぐ。先頭の点が前の終点と同じなら重ねない。"""
    if coordinates and points and coordinates[-1] == points[0]:
        points = points[1:]
    coordinates.extend(points)


def _concat_segment_geometries(segments: list[RouteSegmentDetail]) -> dict | None:
    coordinates: list[list[float]] = []
    for segment in segments:
        if segment.geometry is not None:
            _append_continuing(coordinates, segment.geometry["coordinates"])
    if len(coordinates) < 2:
        return None
    return {"type": "LineString", "coordinates": coordinates}


_SIGNIFICANT_DIGITS = 4


def _round_significant(value: float) -> float:
    """有効数字`_SIGNIFICANT_DIGITS`桁へ丸める（値のスケールに依存しない丸め）。

    材料値はスケールが材料ごとに違う
    （事故密度は`件/(km・年)`で有効域0〜0.5、勾配は`%`で0〜15程度）。
    固定の小数桁で丸めると、桁の小さい軸で値がまるごと潰れる。
    """
    if value == 0.0:
        return value
    return round(value, -int(math.floor(math.log10(abs(value)))) + (_SIGNIFICANT_DIGITS - 1))


def _merge_weighted_dicts(
    items: list[tuple[float, Mapping[str, float]]], round_value: Callable[[float], float]
) -> dict[str, float]:
    """（距離km, キー→値）の並びを、キーごとに距離加重平均へ畳む。キーの無い項目はそのキーの平均に入れない。"""
    keys = {key for _, values in items for key in values}
    merged: dict[str, float] = {}
    for key in keys:
        value = weighted_mean_by_distance([(values.get(key), distance) for distance, values in items])
        if value is not None:
            merged[key] = round_value(value)
    return merged


def _summed_km(distances: Iterable[float]) -> float:
    """区間の距離（km）の和を、区間の`distance_km`と同じ桁へ丸めた値。ビンの距離はこれ1本で作る。"""
    return round(sum(distances), DISTANCE_KM_DECIMALS)


def merge_material_values(segments: Sequence[RouteSegmentDetail]) -> dict[str, float]:
    """`RouteSegmentDetail.material_values`を材料idごとに距離加重平均へ集約する。どの区間にも無い材料は結果にも含めない。"""
    return _merge_weighted_dicts([(s.distance_km, s.material_values) for s in segments], _round_significant)


def merge_road_classes(segments: list[RouteSegmentDetail]) -> dict[str, list[RoadClassStretch]]:
    """区間の並びの道の区分を、レイヤごとにつなぐ。距離0の部分を落とし、隣どうしで値が同じ部分は1つにまとめる。"""
    merged: dict[str, list[RoadClassStretch]] = {}
    for layer in segments[0].road_classes:
        runs: list[tuple[str | None, list[float]]] = []
        for stretch in (s for segment in segments for s in segment.road_classes[layer] if s.distance_km > 0):
            if runs and runs[-1][0] == stretch.value:
                runs[-1][1].append(stretch.distance_km)
            else:
                runs.append((stretch.value, [stretch.distance_km]))
        merged[layer] = [RoadClassStretch(distance_km=_summed_km(distances), value=value) for value, distances in runs]
    return merged


def steepest_signed_percent(elevation: ElevationAttribute | None) -> float | None:
    """道1本の続く坂の斜度（%、走る向きの符号つき）。一番急な登りがあればその値、無ければ一番急な下りを負の値で、
    どちらも無ければ0（-0にしない）。ならす幅は道の断面の刻みで、区間の中で計算し直さず道の値（区間の標高の表）から出す。
    値が無ければNone。"""
    if elevation is None or elevation.steepest_gain_percent is None or elevation.steepest_loss_percent is None:
        return None
    if elevation.steepest_gain_percent > 0:
        return round(elevation.steepest_gain_percent, GRADIENT_VALUE_DECIMALS)
    if elevation.steepest_loss_percent > 0:
        return round(-elevation.steepest_loss_percent, GRADIENT_VALUE_DECIMALS)
    return 0.0


def merge_sustained_gradients(segments: Sequence[RouteSegmentDetail]) -> float | None:
    """区間の続く坂の斜度をビンへ畳む。登りの区間があれば登りの最大、無ければ一番急な下り（最も負の値）。
    区間の値は「登りがあれば登り」で作ってあるので、区間の値だけから道全体で同じ決まりの値になる。値が無ければNone。"""
    values = [segment.sustained_gradient_percent for segment in segments if segment.sustained_gradient_percent is not None]
    if not values:
        return None
    steepest_climb = max(values)
    return steepest_climb if steepest_climb > 0 else min(values)


#: ビンのフィールドと、ビンに入る区間の並びからその値を作る畳み方。`_merge_segment_bin`はこの表だけからビンを組み立てる。
BIN_FIELD_MERGERS: dict[str, Callable[[list[RouteSegmentDetail]], object]] = {
    "geometry": _concat_segment_geometries,
    "start_latitude": lambda segments: segments[0].start_latitude,
    "start_longitude": lambda segments: segments[0].start_longitude,
    "end_latitude": lambda segments: segments[-1].end_latitude,
    "end_longitude": lambda segments: segments[-1].end_longitude,
    "cumulative_distance_km": lambda segments: segments[0].cumulative_distance_km,
    "edge_start": lambda segments: segments[0].edge_start,
    "edge_end": lambda segments: segments[-1].edge_end,
    "elevations": lambda segments: [stretch for segment in segments for stretch in segment.elevations],
    "sustained_gradient_percent": merge_sustained_gradients,
    "estimated_arrival_time": lambda segments: segments[0].estimated_arrival_time,
    "road_classes": merge_road_classes,
    "material_values": merge_material_values,
    "penalty": lambda segments: merge_cost_breakdowns(segment.penalty for segment in segments),
}



def _undeclared_fields() -> list[str]:
    """`RouteSegmentDetail`のフィールドのうち、ビンへの畳み方が宣言されていないもの。"""
    return sorted(set(RouteSegmentDetail.model_fields) - set(BIN_FIELD_MERGERS))


if undeclared := _undeclared_fields():
    # 宣言し忘れたフィールドはビンで既定値になるだけで、型でも例外でも現れない
    # （区間インスペクタから値が消える）。読み込みの時点で止める。
    raise RuntimeError(
        f"RouteSegmentDetail のフィールド {undeclared} は、BIN_FIELD_MERGERS（ビンへの畳み方）で宣言すること"
    )


def _merge_segment_bin(segments: list[RouteSegmentDetail]) -> RouteSegmentDetail:
    """ビンを組み立てる。区間は検証せずに組んだ値（`RouteSegmentDetail.model_construct`）でよく、検証はビンでだけ行う
    （中の標高・区分の部分も、ビンを検証するときに検証し直す）。"""
    return RouteSegmentDetail.model_validate({name: merge(segments) for name, merge in BIN_FIELD_MERGERS.items()})


def concat_edge_geometries(edges: list[LeanEdge]) -> tuple[dict, list[int]]:
    """経路上のEdge群を、ひとつながりのGeoJSON LineStringとEdgeの境界点の位置へ変換する。

    隣接するEdgeの境界点（前Edgeの終端＝次Edgeの始端）は重複させないため、**座標列だけ
    からはどこがEdgeの境目か復元できない**。Edge単位で決めた区間を地図へ帯として描く
    ために境界の位置を併せて返す。

    2つ目の戻り値は`len(edges) + 1`件で、`coordinates[offsets[i]:offsets[j] + 1]`が
    Edge i〜j-1のひとつながりの形状になる。**同じ関数が両方を作る**——別々に組み立てると
    ずれても型でも例外でも現れず、地図上で帯だけが1点ずれる。
    """
    coordinates: list[list[float]] = []
    offsets: list[int] = []
    for edge in edges:
        offsets.append(max(len(coordinates) - 1, 0))
        _append_continuing(coordinates, [[lon, lat] for lat, lon in edge.geometry])
    offsets.append(max(len(coordinates) - 1, 0))
    return {"type": "LineString", "coordinates": coordinates}, offsets


def reverse_elevation_by_edge(
    edges_in_path: list[LeanEdge],
    reverse_edges: list[LeanEdge],
    elevation_by_edge: dict[str, ElevationAttribute],
) -> dict[str, ElevationAttribute]:
    """逆方向Edge列ぶんの`ElevationAttribute`を、順方向の値から代数的に導出する。

    順方向で標高が取れなかったEdgeは逆方向側にもキーを持たせない（欠損をそのまま伝える）。
    """
    result: dict[str, ElevationAttribute] = {}
    for forward_edge, reverse_edge in zip(reversed(edges_in_path), reverse_edges):
        forward_attribute = elevation_by_edge.get(forward_edge.edge_id)
        if forward_attribute is not None:
            result[reverse_edge.edge_id] = forward_attribute.reversed_as(reverse_edge.edge_id)
    return result


def route_elevation_gain(edges: list[LeanEdge], elevation_by_edge: dict) -> float | None:
    """経路の獲得標高（m、`ELEVATION_M_DECIMALS`の桁）。値が1つも無ければNone（0mと「標高が取れなかった」を分ける）。"""
    gains = [
        attribute.elevation_gain_m
        for edge in edges
        if (attribute := elevation_by_edge.get(edge.edge_id)) is not None
    ]
    return round(sum(gains), ELEVATION_M_DECIMALS) if gains else None
