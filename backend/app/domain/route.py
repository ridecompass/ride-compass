from collections import defaultdict

from typing import Annotated, Any, Callable, Iterable, Literal, Sequence

import numpy as np
from pydantic import ConfigDict, WithJsonSchema, computed_field

from app.domain.attributes import ElevationAttribute
from app.domain.lens_total import lens_values_with_total
from app.domain.geo import Latitude, Longitude, length_weighted_mean
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


class PenaltyBreakdown(StrictModel):
    """代償の秒の内訳（費目の帳簿の式、`domain/ledger_costs.py`）。所要時間・軸ごとの代償・避け方の倍率が増減した秒の和が費用になる。

    区間（ルートの線の一片）の内訳は通った道の分で、地図のレンズと同じ量。候補の内訳はルート全体の損で、区間の和に、通る道筋で
    決まる曲がる所の漕ぎ出しを、その費目（慣性）を持つ軸の秒として足したもの。軸の名前と帳簿は`GET /api/cost-axes`が持つ。
    """

    # 軸id→代償の秒（つまみ×倍率を掛けたもの）。数える軸だけを持ち（無効の軸は無い）、秒が0の軸も0として持つ。
    axis_seconds: dict[str, float]
    # 避け方の倍率（道の区分ごとの段）が、その道の所要時間と代償から「好む」で下げた秒（0以下）と、「なるべく避ける」で
    # 上乗せした秒（0以上）。
    preferred_seconds: float
    avoided_seconds: float

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_seconds(self) -> float:
        """代償の秒の和（軸ごとの秒と避け方の秒）。所要時間に足すと、候補を並べた費用になる。好む道を通ると負になりうる。"""
        return round(sum(self.axis_seconds.values(), self.preferred_seconds + self.avoided_seconds), COST_SECONDS_DECIMALS)


def penalty_seconds_per_km(cost: np.ndarray | float, seconds: np.ndarray | float, length_m: np.ndarray | float) -> np.ndarray:
    """費用から所要時間を引いた代償の秒を、1kmあたりにしたもの（数を渡すと0次元の配列）。求まらない要素（長さ0・到達不能）は0。
    周回の候補を並べる値で、候補の帯もこれで塗る。"""
    with np.errstate(invalid="ignore", divide="ignore"):
        per_km = (np.asarray(cost, dtype=float) - np.asarray(seconds, dtype=float)) / (np.asarray(length_m, dtype=float) / 1000.0)
    return np.where(np.isfinite(per_km), per_km, 0.0)


def lens_seconds_per_km(penalty: PenaltyBreakdown, distance_km: float) -> dict[str, float] | None:
    """区間の、地図のレンズと同じ量（レンズid→1kmあたりの代償の秒。総合`TOTAL_LENS_ID`は軸の和）。避け方の秒は軸の値ではないので
    入れない（ルートの線と周りの道を同じ量で塗る）。長さが0ならNone。"""
    if not distance_km > 0:
        return None
    per_km = lens_values_with_total({axis_id: seconds / distance_km for axis_id, seconds in penalty.axis_seconds.items()}, 0.0)
    return {lens_id: round(value, COST_SECONDS_DECIMALS) for lens_id, value in per_km.items()}


def merge_penalty_breakdowns(parts: Iterable[PenaltyBreakdown]) -> PenaltyBreakdown:
    """内訳を足し合わせる（秒は足せる）。"""
    present = list(parts)
    totals: dict[str, float] = defaultdict(float)
    for part in present:
        for axis_id, seconds in part.axis_seconds.items():
            totals[axis_id] += seconds
    return PenaltyBreakdown.model_construct(
        axis_seconds={axis_id: round(seconds, COST_SECONDS_DECIMALS) for axis_id, seconds in totals.items()},
        preferred_seconds=round(sum(part.preferred_seconds for part in present), COST_SECONDS_DECIMALS),
        avoided_seconds=round(sum(part.avoided_seconds for part in present), COST_SECONDS_DECIMALS),
    )


class AxisFact(StrictModel):
    """費用の軸1つの秒の元になった事実（`domain/leg_costs.py: axis_facts`）。名前と単位は求める側が付け、画面は軸idで出し分けずに
    そのまま出す。"""

    label: str
    # 区分の事実（路面の区分等）はNoneで、`label`が区分の名前。
    value: float | None
    unit: str


class RouteFacts(StrictModel):
    """ルートの事実（費用の式にも利用者の倍率にも依らない）。"""

    # 費用の軸id→その軸の事実。数える軸のうち、事実を求められたものだけ。
    axes: dict[str, AxisFact]


class RouteSegmentDetail(StrictModel):
    """ルートの1区間（Edge、応答では`SEGMENT_BIN_DISTANCE_KM`ごとのビン）の詳細。地図のルートの線の塗りと区間の小窓が読む。

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
    # 区間の平均勾配（%、走る向きの符号つき）。道の平均勾配（区間の標高の表）を、ビンへは`merge_average_gradients`で
    # 値のある道の距離で重みづけて畳む。値が無ければNone。
    average_gradient_percent: float | None = None
    estimated_arrival_time: str | None = None
    # 区間の代償の秒の内訳。
    penalty: PenaltyBreakdown

    @computed_field  # type: ignore[prop-decorator]
    @property
    def lens_seconds_per_km(self) -> dict[str, float] | None:
        """区間の、地図のレンズと同じ量（`lens_seconds_per_km`）。ルートの線は地図のレンズと同じ段でこれを塗る。"""
        return lens_seconds_per_km(self.penalty, self.distance_km)

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
    # 並べ方の値（秒）。探索が最小にした費用そのもの（区間の費用＋曲がる所の費用）。所要時間と内訳（`penalty`）の和に、
    # 丸めの差を除いて等しい。
    cost_seconds: float
    # 候補全体の代償の秒の内訳。
    penalty: PenaltyBreakdown

    def penalty_per_km(self) -> float | None:
        """候補全体の1kmあたりの代償の秒（曲がる所と避け方の秒を含むルート全体の損。`penalty_seconds_per_km`）。周回はこの値で
        並べ（`domain/route_search.py: candidate_order`）、候補の帯は応答の`penalty_seconds_per_km`で塗る。所要時間か長さが
        無ければNone。"""
        if self.estimated_duration_seconds is None or not self.distance_km > 0:
            return None
        return float(penalty_seconds_per_km(self.cost_seconds, self.estimated_duration_seconds, self.distance_km * 1000.0))

    @computed_field  # type: ignore[prop-decorator]
    @property
    def penalty_seconds_per_km(self) -> float | None:
        """`penalty_per_km`を応答の秒の桁へ丸めたもの。候補の帯はこれで塗る。"""
        per_km = self.penalty_per_km()
        return None if per_km is None else round(per_km, COST_SECONDS_DECIMALS)

    facts: RouteFacts
    # 所要時間の見積もりで、勾配か停止要因の件数の値が無く、取込の範囲全体の平均で数えた区間の距離の割合（0〜1）。
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

    値の性質ごとに畳み方が違う（`BIN_FIELD_MERGERS`）: 平均勾配は距離加重平均（値がNoneの区間は除外し、残りの距離で
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



def _summed_km(distances: Iterable[float]) -> float:
    """区間の距離（km）の和を、区間の`distance_km`と同じ桁へ丸めた値。ビンの距離はこれ1本で作る。"""
    return round(sum(distances), DISTANCE_KM_DECIMALS)


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


def merge_average_gradients(segments: Sequence[RouteSegmentDetail]) -> float | None:
    """区間の平均勾配をビンへ畳む。値のある区間の平均勾配を、その区間の距離で重みづけた平均（-0にしない）。
    値のある区間が無ければNone。"""
    mean = length_weighted_mean(
        np.array([np.nan if s.average_gradient_percent is None else s.average_gradient_percent for s in segments]),
        np.array([s.distance_km for s in segments]))
    return None if mean is None else round(mean, GRADIENT_VALUE_DECIMALS) + 0.0


#: ビンのフィールドと、ビンに入る区間の並びからその値を作る畳み方。`_merge_segment_bin`はこの表だけからビンを組み立てる。
BIN_FIELD_MERGERS: dict[str, Callable[[list[RouteSegmentDetail]], object]] = {
    "geometry": _concat_segment_geometries,
    "start_latitude": lambda segments: segments[0].start_latitude,
    "start_longitude": lambda segments: segments[0].start_longitude,
    "end_latitude": lambda segments: segments[-1].end_latitude,
    "end_longitude": lambda segments: segments[-1].end_longitude,
    "cumulative_distance_km": lambda segments: segments[0].cumulative_distance_km,
    "distance_km": lambda segments: _summed_km(segment.distance_km for segment in segments),
    "edge_start": lambda segments: segments[0].edge_start,
    "edge_end": lambda segments: segments[-1].edge_end,
    "elevations": lambda segments: [stretch for segment in segments for stretch in segment.elevations],
    "sustained_gradient_percent": merge_sustained_gradients,
    "average_gradient_percent": merge_average_gradients,
    "estimated_arrival_time": lambda segments: segments[0].estimated_arrival_time,
    "road_classes": merge_road_classes,
    "penalty": lambda segments: merge_penalty_breakdowns(segment.penalty for segment in segments),
}



def _undeclared_fields() -> list[str]:
    """`RouteSegmentDetail`のフィールドのうち、ビンへの畳み方が宣言されていないもの。"""
    return sorted(set(RouteSegmentDetail.model_fields) - set(BIN_FIELD_MERGERS))


if undeclared := _undeclared_fields():
    # 宣言し忘れたフィールドはビンで既定値になるだけで、型でも例外でも現れない
    # （道の窓から値が消える）。読み込みの時点で止める。
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


def elevation_gain(gains: np.ndarray) -> float | None:
    """区間ごとの登り（m、NaNは標高が無い）の和（`ELEVATION_M_DECIMALS`の桁）。値が1つも無ければNone（0mと「標高が取れなかった」
    を分ける）。経路の獲得標高と、道の窓の押した区間の登りが読む。"""
    known = gains[~np.isnan(gains)]
    return round(float(known.sum()), ELEVATION_M_DECIMALS) if len(known) else None
