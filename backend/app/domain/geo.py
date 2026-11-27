import math
from collections.abc import Sequence
from typing import Annotated, NamedTuple, Protocol

import numpy as np
from pydantic import Field

EARTH_RADIUS_KM = 6371.0
#: 応答と地図に載せる緯度・経度の小数の桁。1e-6度は約0.1mで、浮動小数の端数と0.1m未満を落とす。
COORDINATE_DECIMALS = 6

# 緯度・経度の値の範囲。モデルの欄にもHTTPのクエリにもこの型で書く。クエリでは既定値に`Query()`を
# 置かない——置くとFastAPIがこの型の範囲を読まず、範囲の外の値が黙って通る。
Latitude = Annotated[float, Field(ge=-90, le=90)]
Longitude = Annotated[float, Field(ge=-180, le=180)]
# 走行方位（度、北=0から時計回り）。方位を受ける入口（地図の配信・道の窓）はこの型で書く。範囲の検査は
# NaN・無限大も断る。
BearingDeg = Annotated[float, Field(ge=0, lt=360)]


class LatLon(Protocol):
    """緯度経度を持つ任意の型（`Coordinates`等）を受け付ける構造的型。

    型ヒントを`Coordinates`（Pydantic）固定にすると、グラフ構築や最近傍探索のような
    ホットパスで、既に手元にある生の緯度経度ペアやNodeオブジェクトから
    わざわざ`Coordinates`を構築し直す無駄が生じる。

    読み取り専用のプロパティとして宣言するのは、凍結したdataclassや
    NamedTuple（`LatLonPoint`）も満たせるようにするため。
    """

    @property
    def latitude(self) -> float: ...

    @property
    def longitude(self) -> float: ...


class LatLonPoint(NamedTuple):
    """`LatLon`を満たす最小実装。Pydanticのバリデーションコストを
    避けたい内部計算専用（`Coordinates`は入力検証が必要なAPI境界向けに残す）。
    """

    latitude: float
    longitude: float


# 緯度1度あたりの概算距離（km、地球を球とみなす近似）。空間索引のバケット分割・打ち切り
# 判定・矩形マージンの見積もりという「目安」用途にのみ使う。実際の距離計算は常に
# haversine_distance_kmで正確に行う。
KM_PER_DEGREE_LATITUDE = 111.0


def km_per_degree_longitude(latitude: float) -> float:
    """緯度`latitude`での経度1度あたりの概算距離（km、`KM_PER_DEGREE_LATITUDE`と同じ目安用途）。

    極では`cos`が0へ落ちるため下限を置く——この値で割る側（矩形のマージン・索引のセル幅）が
    ゼロ除算にならないように。
    """
    return KM_PER_DEGREE_LATITUDE * max(math.cos(math.radians(latitude)), 1e-6)


#: `degrees_covering_m`の箱が距離の判定を覆う緯度の上限（度）。これより極に近い所では箱が距離より狭くなり、
#: 前置フィルタが黙って取りこぼす。
COVERED_LATITUDE_LIMIT = 60.0


def degrees_covering_m(radius_m: float) -> float:
    """半径`radius_m`（m）の円を、緯度`COVERED_LATITUDE_LIMIT`までどこでも覆う度の幅。SQLの前置フィルタ
    （`ST_Expand`の箱）を距離の判定より必ず広くするために使う。

    経度1度は緯度1度より短いので、上限の緯度での経度1度で割れば経度・緯度のどちらの向きも覆う。
    """
    return radius_m / (km_per_degree_longitude(COVERED_LATITUDE_LIMIT) * 1000.0)


#: 地面の m で測る平面（日本の中ほどを中心にした正距方位図法）。中心から1,500km（北海道・沖縄）でも、近くの2点の間の
#: 距離の誤差は1%に満たない。経度・緯度を点ごとの緯度の cos で縮める形は、縮めが原点のまわりにかかるため、南北に
#: ずれた2点の間に原点からの遠さに比例した横のずれが乗る（関東で南北に20mの2点が約31mになる）。
_GROUND_M_PROJ = "+proj=aeqd +lat_0=36 +lon_0=138 +datum=WGS84 +units=m +no_defs"


def ground_m_sql(geom_expr: str) -> str:
    """経度・緯度の幾何（SRID 4326）を、2点の間が地面の m になる平面へ写す式。`ST_ClusterDBSCAN`等の平面の演算へ渡す。"""
    return f"ST_Transform({geom_expr}, '{_GROUND_M_PROJ}')"


def bearing_sql(start: str, end: str) -> str:
    """点`start`から点`end`を見た方位（度、0=北・時計回り）を求めるSQLの式。2点が同じならNULL。"""
    # geographyで測る。geometry(4326)のままだと経度緯度を平面として扱った角度になり、緯度35度では真の方位と数度ずれる。
    return f"degrees(ST_Azimuth({start}::geography, {end}::geography))"


def midpoint_sql(start: str, end: str) -> tuple[str, str]:
    """点`start`と点`end`の中点の緯度・経度を求めるSQLの式の組。区間の値を1点で引く所（予報の格子点等）に使う。"""
    return f"(ST_Y({start}) + ST_Y({end})) / 2", f"(ST_X({start}) + ST_X({end})) / 2"


#: 16方位の呼び名（0=北から時計回り）。8方位の呼び名はこの1つおきで、別に持たない——
#: 片方だけ直すと、同じ向きを場所によって違う名前で出す。
SIXTEEN_POINT_LABELS = [
    "北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東",
    "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西",
]
if len(set(SIXTEEN_POINT_LABELS)) != len(SIXTEEN_POINT_LABELS):
    raise ValueError("16方位の呼び名が重なると、違う向きが画面で同じ名前になる")
COMPASS_LABELS = SIXTEEN_POINT_LABELS[::2]


def compass_label(bearing_deg: float) -> str:
    """任意の角度（0=北、時計回り）を方位の呼び名に変換する。区分の幅は呼び名の数から決まる。

    画面も同じ角度を名付けるので、境界を含む入力とこの関数の答えを
    `scripts/cross_language_expectations.py: geo_expectations`が表にして配り、画面のテストが通す。
    """
    return COMPASS_LABELS[_bearing_sector(bearing_deg, len(COMPASS_LABELS))]


def _bearing_sector(bearing_deg: float, count: int) -> int:
    """任意の角度（0=北、時計回り）を、北を中心にした`count`等分の区分の番号（0〜count-1）へ丸める。
    境界は上の区分へ倒す（組み込みの`round`は偶数丸めで、境界の区分の幅が揃わない）。"""
    return math.floor((bearing_deg % 360) / (360 / count) + 0.5) % count


def compass_degrees(bearing_deg: float) -> int:
    """方位（度）を応答に載せる桁（0〜359の整数の度）へ丸める。境目は`_bearing_sector`と同じく上へ倒す。"""
    return math.floor(bearing_deg + 0.5) % 360


def bearing_between(origin: LatLon, destination: LatLon) -> float:
    """originからdestinationを見た初期方位角（0=北、時計回り、0-360）を球面三角法で求める。

    同じ地点どうしは向きが定まらず、例外にせず0（北）を返す（`atan2(0, 0)`）。"""
    return float(bearing_between_array(origin, np.asarray(destination.latitude), np.asarray(destination.longitude)))


def bearing_between_array(origin: LatLon, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """`bearing_between`を多数の点へまとめて求める。originから`(lat, lon)`の各点を見た初期方位角
    （0=北、時計回り、0-360）を配列で返す。"""
    return bearings_between(np.asarray(origin.latitude), np.asarray(origin.longitude), lat, lon)


def bearings_between(lat1: np.ndarray, lon1: np.ndarray, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    """点`(lat1, lon1)`から点`(lat2, lon2)`を見た初期方位角（0=北、時計回り、0-360）を、点の組ごとに配列で求める。
    式はここ1本で、`bearing_between`・`bearing_between_array`もこれを通す。"""
    phi1 = np.radians(lat1)
    phi2 = np.radians(lat2)
    dlon = np.radians(np.asarray(lon2) - np.asarray(lon1))

    x = np.sin(dlon) * np.cos(phi2)
    y = np.cos(phi1) * np.sin(phi2) - np.sin(phi1) * np.cos(phi2) * np.cos(dlon)

    return np.degrees(np.arctan2(x, y)) % 360


def haversine_distance_km(a: LatLon, b: LatLon) -> float:
    """2地点間の球面距離（km）。"""
    return float(haversine_distance_km_array(np.asarray(a.latitude), np.asarray(a.longitude), b))


def haversine_distance_km_array(lat: np.ndarray, lon: np.ndarray, target: LatLon) -> np.ndarray:
    """`haversine_distance_km`を多数の地点へまとめて求める。

    `lat`/`lon`は複数地点の緯度経度配列（同一形状）、`target`は単一の目的地。
    A*ヒューリスティック（`domain/route_search.py: straight_distances_m`）が、向かう先ごとにグラフ上の
    全Nodeとの距離を1回のnumpy演算で求めるために使う。
    """
    return haversine_distance_km_pairs(lat, lon, np.asarray(target.latitude), np.asarray(target.longitude))


def haversine_distance_km_pairs(lat1: np.ndarray, lon1: np.ndarray, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    """2組の地点の配列（numpy のブロードキャストで並ぶ）の、組ごとの球面距離（km）。式はここ1本で、`haversine_distance_km`・
    `haversine_distance_km_array`もこれを通す。線の点の間の長さを1回のnumpy演算で求めるのにも使う
    （`domain/route.py: concat_edge_geometries`）。"""
    phi1 = np.radians(lat1)
    phi2 = np.radians(lat2)
    dlat = phi2 - phi1
    dlon = np.radians(lon2) - np.radians(lon1)
    h = np.sin(dlat / 2) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(h))


def nearest_point_index(location: LatLon, points: Sequence[LatLon]) -> int | None:
    """1地点に球面の距離で最も近い点（`points`）の番号。点が無ければNone。

    単位球上の位置ベクトルの内積が大きいほど近い（大円の距離と順位が同じ）。内積は1の近くで浮動小数の刻みが粗く、
    約10cmより近い差は区別しない（同じ距離として先に並んだ点を選ぶ）。
    """
    if not points:
        return None
    here = _unit_vectors(np.array([location.latitude]), np.array([location.longitude]))[0]
    candidates = _unit_vectors(np.array([p.latitude for p in points]), np.array([p.longitude for p in points]))
    return int(np.argmax(candidates @ here))


def _unit_vectors(latitudes: np.ndarray, longitudes: np.ndarray) -> np.ndarray:
    phi, lam = np.radians(latitudes), np.radians(longitudes)
    return np.stack([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)], axis=-1)


def length_weighted_mean(values: np.ndarray, lengths: np.ndarray) -> float | None:
    """長さで重みを付けた平均（値がNaNの区間は除き、残りの長さで割る）。有効な区間が無いか長さの和が0ならNone。"""
    values = np.asarray(values, dtype=np.float64)
    lengths = np.asarray(lengths, dtype=np.float64)
    known = ~np.isnan(values)
    total = float(lengths[known].sum())
    return float((values[known] * lengths[known]).sum()) / total if total > 0 else None
