"""気象庁MSM（メソ数値予報モデル）格子の幾何と補間。

外部I/Oを持たない純関数のみを置く。実データの同期・読み出しと、配信元のメタ情報（格子の範囲の
表記等）の解釈は`infrastructure/msm_client.py`が担う。

MSMは緯度・経度方向で間隔の異なる等間隔格子（緯度0.05度・経度0.0625度）。値の読み方は2つある:
画面と公開の口へ出す値は格子点の値をそのまま使い（`MsmBlock`・`MsmGridPoints`）、画面に出さない計算に使う
任意地点の値は周囲4格子点からの双一次補間で求める（`MsmWindow`）。補間した値を地点の値として出すと、気象業務法の
予報業務許可が要る（docs/architecture/data-sources.md「気象業務法の予報業務許可」節）。
"""

import math
from dataclasses import dataclass

import numpy as np


def _index_rounded(value: float) -> float:
    """格子の番号の実数値。割り算の丸めで格子点ちょうどの値が1つ下へ落ちないよう、丸めてから切り捨て・切り上げる。"""
    return round(value, 9)

@dataclass(frozen=True)
class MsmGrid:
    """MSM格子の幾何。

    原点・間隔は配信元メタ情報のbboxと実データ配列の形状から導出する。定数として
    書き写すと、配信元が格子を変更したときにここだけ古い値が残り、全地点の値が
    エラーにならないまま静かにずれる。
    """

    lat_min: float
    lon_min: float
    d_lat: float
    d_lon: float
    n_lat: int
    n_lon: int

    @classmethod
    def from_bbox_and_shape(cls, bbox: tuple[float, float, float, float], n_lat: int, n_lon: int) -> "MsmGrid":
        south, west, north, east = bbox
        if n_lat < 2 or n_lon < 2:
            raise ValueError("格子の形状が不正です")
        return cls(
            lat_min=south,
            lon_min=west,
            d_lat=(north - south) / (n_lat - 1),
            d_lon=(east - west) / (n_lon - 1),
            n_lat=n_lat,
            n_lon=n_lon,
        )

    def _contains(self, latitudes: np.ndarray, longitudes: np.ndarray) -> bool:
        lat_max = self.lat_min + self.d_lat * (self.n_lat - 1)
        lon_max = self.lon_min + self.d_lon * (self.n_lon - 1)
        return bool(
            np.all(latitudes >= self.lat_min)
            and np.all(latitudes <= lat_max)
            and np.all(longitudes >= self.lon_min)
            and np.all(longitudes <= lon_max)
        )

    def latitude_of(self, rows: np.ndarray) -> np.ndarray:
        return self.lat_min + np.asarray(rows) * self.d_lat

    def longitude_of(self, cols: np.ndarray) -> np.ndarray:
        return self.lon_min + np.asarray(cols) * self.d_lon

    def block_covering(self, south: float, west: float, north: float, east: float) -> "MsmBlock":
        """矩形を覆う格子点の並び。南端・西端は手前の格子点から、北端・東端も格子の内側に入るよう1つ先の格子点まで取る。
        格子点は格子の原点から数えるので、同じ地点はどの矩形から引いても同じ格子点に当たる。"""
        if not self._contains(np.array([south, north]), np.array([west, east])):
            raise ValueError("MSM格子の範囲外の地点が含まれています")
        row0 = math.floor(_index_rounded((south - self.lat_min) / self.d_lat))
        col0 = math.floor(_index_rounded((west - self.lon_min) / self.d_lon))
        row1 = min(math.ceil(_index_rounded((north - self.lat_min) / self.d_lat)), self.n_lat - 1)
        col1 = min(math.ceil(_index_rounded((east - self.lon_min) / self.d_lon)), self.n_lon - 1)
        return MsmBlock(grid=self, row0=row0, col0=col0, rows=row1 - row0 + 1, cols=col1 - col0 + 1)

    def nearest_points(self, latitudes: np.ndarray, longitudes: np.ndarray) -> "MsmGridPoints":
        """地点ごとの最寄りの格子点。"""
        if not self._contains(latitudes, longitudes):
            raise ValueError("MSM格子の範囲外の地点が含まれています")
        rows = np.rint((np.asarray(latitudes, dtype=float) - self.lat_min) / self.d_lat).astype(np.int64)
        cols = np.rint((np.asarray(longitudes, dtype=float) - self.lon_min) / self.d_lon).astype(np.int64)
        row0, col0 = int(rows.min()), int(cols.min())
        block = MsmBlock(
            grid=self, row0=row0, col0=col0, rows=int(rows.max()) - row0 + 1, cols=int(cols.max()) - col0 + 1,
        )
        return MsmGridPoints(block=block, points=(rows - row0) * block.cols + (cols - col0))

    def window(self, latitudes: np.ndarray, longitudes: np.ndarray) -> "MsmWindow":
        """与えた地点群を補間するのに必要な部分ブロックの窓を返す。

        双一次補間は各地点の右上側の格子点も参照するため、上端側へ1つ余分に取る。
        """
        if not self._contains(latitudes, longitudes):
            raise ValueError("MSM格子の範囲外の地点が含まれています")
        return MsmWindow(
            grid=self,
            i0=int(np.floor((latitudes.min() - self.lat_min) / self.d_lat)),
            i1=min(int(np.floor((latitudes.max() - self.lat_min) / self.d_lat)) + 2, self.n_lat),
            j0=int(np.floor((longitudes.min() - self.lon_min) / self.d_lon)),
            j1=min(int(np.floor((longitudes.max() - self.lon_min) / self.d_lon)) + 2, self.n_lon),
            latitudes=latitudes,
            longitudes=longitudes,
        )


@dataclass(frozen=True)
class MsmWindow:
    """全体格子から切り出す範囲と、その範囲を決めた地点群。

    切り出し索引・地点・格子は、揃っていて初めて補間が正しい。呼び出し側がこの3つを
    別々の引数として組み立てられるようにすると、取り違えても下の`np.clip`が黙って端へ
    寄せ、全地点の値が例外にならないままずれる。窓を作った側がそのまま補間まで持つ。
    """

    grid: MsmGrid
    i0: int
    i1: int
    j0: int
    j1: int
    latitudes: np.ndarray
    longitudes: np.ndarray

    @property
    def lat_slice(self) -> slice:
        return slice(self.i0, self.i1)

    @property
    def lon_slice(self) -> slice:
        return slice(self.j0, self.j1)

    def interpolate(self, block: np.ndarray) -> np.ndarray:
        """部分ブロック（形状[緯度, 経度, 時刻]、`lat_slice`/`lon_slice`で切り出したもの）
        から地点ごとの時系列を双一次補間で取り出す。戻り値の形状は[地点数, 時刻数]。
        """
        fi = (self.latitudes - self.grid.lat_min) / self.grid.d_lat - self.i0
        fj = (self.longitudes - self.grid.lon_min) / self.grid.d_lon - self.j0
        # 全体格子の上端・右端ちょうどの地点では余分の1つが取れず、左下側の格子点が
        # ブロックの最後の組になる。
        ai = np.clip(np.floor(fi).astype(int), 0, block.shape[0] - 2)
        aj = np.clip(np.floor(fj).astype(int), 0, block.shape[1] - 2)
        wi = (fi - ai)[:, None]
        wj = (fj - aj)[:, None]
        return (
            block[ai, aj] * (1.0 - wi) * (1.0 - wj)
            + block[ai + 1, aj] * wi * (1.0 - wj)
            + block[ai, aj + 1] * (1.0 - wi) * wj
            + block[ai + 1, aj + 1] * wi * wj
        )


@dataclass(frozen=True)
class MsmBlock:
    """MSM格子の中の矩形に並ぶ格子点。点の番号は南の行から、各行の中は西から（行×列）。

    道・区間の風は、その中ほどに最寄りの格子点の値を引く（`points_of`）。
    """

    grid: MsmGrid
    #: 南西の格子点の、格子の中の番号。
    row0: int
    col0: int
    rows: int
    cols: int

    @property
    def size(self) -> int:
        return self.rows * self.cols

    @property
    def lat_slice(self) -> slice:
        return slice(self.row0, self.row0 + self.rows)

    @property
    def lon_slice(self) -> slice:
        return slice(self.col0, self.col0 + self.cols)

    def all_points(self) -> "MsmGridPoints":
        return MsmGridPoints(block=self, points=np.arange(self.size))

    def coordinates(self) -> tuple[np.ndarray, np.ndarray]:
        """全格子点の（緯度, 経度）配列（点の番号の順）。"""
        return self.all_points().coordinates()

    def _nearest_rows_cols(self, latitudes: np.ndarray, longitudes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        i = np.rint((np.asarray(latitudes, dtype=float) - self.grid.latitude_of(self.row0)) / self.grid.d_lat)
        j = np.rint((np.asarray(longitudes, dtype=float) - self.grid.longitude_of(self.col0)) / self.grid.d_lon)
        return i, j

    def points_of(self, latitudes: np.ndarray, longitudes: np.ndarray) -> np.ndarray:
        """各地点に最も近い格子点の番号。並びの外の地点は端の格子点へ寄せる（`holds_nearest`が偽になる）。"""
        i, j = self._nearest_rows_cols(latitudes, longitudes)
        i = np.clip(i, 0, self.rows - 1).astype(np.int64)
        j = np.clip(j, 0, self.cols - 1).astype(np.int64)
        return i * self.cols + j

    def holds_nearest(self, latitudes: np.ndarray, longitudes: np.ndarray) -> np.ndarray:
        """各地点の最寄りの格子点が、この並びの中にあるか（`points_of`が端へ寄せずに引けるか）。"""
        i, j = self._nearest_rows_cols(latitudes, longitudes)
        return (i >= 0) & (i < self.rows) & (j >= 0) & (j < self.cols)


@dataclass(frozen=True)
class MsmGridPoints:
    """格子点の並び`block`の中から選んだ格子点（`points`は`block`の中の番号）。"""

    block: MsmBlock
    points: np.ndarray

    @property
    def lat_slice(self) -> slice:
        return self.block.lat_slice

    @property
    def lon_slice(self) -> slice:
        return self.block.lon_slice

    @property
    def rows(self) -> np.ndarray:
        """格子の中の行の番号（南から）。"""
        return self.block.row0 + self.points // self.block.cols

    @property
    def cols(self) -> np.ndarray:
        """格子の中の列の番号（西から）。"""
        return self.block.col0 + self.points % self.block.cols

    def coordinates(self) -> tuple[np.ndarray, np.ndarray]:
        """格子点の（緯度, 経度）配列。"""
        return self.block.grid.latitude_of(self.rows), self.block.grid.longitude_of(self.cols)

    def values(self, block: np.ndarray) -> np.ndarray:
        """部分ブロック（形状[緯度, 経度, 時刻]、`lat_slice`/`lon_slice`で切り出したもの）から、選んだ格子点ごとの
        時系列を格子点の値のまま取り出す。戻り値の形状は[点の数, 時刻数]。"""
        return block.reshape(self.block.size, block.shape[2])[self.points]


def wind_speed_and_direction(u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """東西成分・南北成分[m/s]から風速[m/s]と風向[度]を求める。

    風向は「風が吹いてくる方位」（北=0、東=90）で返す。気象分野の慣行であり、
    ルート評価・地図表示ともにこの定義を前提にしている。
    """
    speed = np.hypot(u, v)
    direction = (np.degrees(np.arctan2(u, v)) + 180.0) % 360.0
    return speed, direction
