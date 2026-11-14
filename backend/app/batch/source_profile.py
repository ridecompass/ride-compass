"""外部ソースの取込プロファイル（YAML）の読み込み。

**取り込む母集団の宣言はプロファイルだけが持つ**。実装には範囲を書かない——範囲を
広げるときに直す場所が1つになり、適用した内容をそのまま`source_runs.profile`へ
記録できる。

対象範囲（`target`）はソース共通で、全ソースがそれを使う。範囲は緯度経度の枠
（`target.bbox`）だけで決まる。

ソースごとの`rows`/`grid`の欄は、アダプタが`register_adapter`で宣言した型（dataclass）のフィールドで、
欄を足すときはそのフィールドを1つ足す。
"""

import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from app.domain.region import BoundingBox

_PROFILE_PATH = Path(__file__).resolve().parent / "source_profile.yaml"


class SourceProfileError(ValueError):
    """プロファイルの宣言の不正（アダプタが断る欄の値・無いソースの名指し）。"""


@dataclass(frozen=True)
class NoFields:
    """欄を1つも持たない`rows`/`grid`。アダプタが型を宣言しなかった側に当たる。"""


@dataclass(frozen=True)
class Target:
    """全ソース共通の対象範囲。"""

    #: (min_lat, min_lon, max_lat, max_lon)。
    bbox: tuple[float, float, float, float]

    def contains(self, lat: float, lon: float) -> bool:
        """点が範囲に入るか（境界を含む）。"""
        min_lat, min_lon, max_lat, max_lon = self.bbox
        return min_lat <= lat <= max_lat and min_lon <= lon <= max_lon

    def prefectures(self, points: Iterable[tuple[str, float, float]]) -> list[str]:
        """範囲に掛かる都道府県のコード。`points`は都道府県の中の点の (都道府県コード, 緯度, 経度) で、範囲の中に
        点を1つも持たない都道府県は、範囲が端に掛かっていても入らない。"""
        return sorted({prefecture for prefecture, lat, lon in points if self.contains(lat, lon)})

    def bounding_box(self) -> BoundingBox:
        min_lat, min_lon, max_lat, max_lon = self.bbox
        return BoundingBox(min_latitude=min_lat, min_longitude=min_lon, max_latitude=max_lat, max_longitude=max_lon)


@dataclass(frozen=True)
class SourceSpec:
    """1ソースぶんの宣言。

    `adapter`が外部の形を読む実装を指す。run記録とパーティションの選択は取込の
    共通経路が持つ。
    """

    name: str
    adapter: str
    #: 行の絞り込み。型はアダプタが宣言する（`register_adapter`の`rows`）。
    rows: Any
    #: ラスタ・タイル系の格子の指定。型はアダプタが宣言する（`register_adapter`の`grid`）。
    grid: Any


@dataclass(frozen=True)
class SourceProfile:
    target: Target
    sources: tuple[SourceSpec, ...]
    #: ファイル全体のSHA-256。`source_runs`へ記録し、どの宣言で取り込んだ行かを追える。
    profile_hash: str

    def source(self, name: str) -> SourceSpec:
        for spec in self.sources:
            if spec.name == name:
                return spec
        raise SourceProfileError(f"プロファイルに '{name}' がありません")


def _parse_source(raw: dict[str, Any], adapters: dict[str, Any]) -> SourceSpec:
    entry = adapters[raw["adapter"]]
    return SourceSpec(name=raw["name"], adapter=raw["adapter"],
                      rows=entry.rows(**raw.get("rows", {})), grid=entry.grid(**raw.get("grid", {})))


def _registered_adapters() -> dict[str, Any]:
    """登録済みのアダプタ。アダプタはimportされたときに自分を登録する。

    取込の共通経路（`ingest.py`）とアダプタがこのモジュールをimportするため、関数の中でimportする。
    """
    from app.batch import source_adapters  # noqa: F401
    from app.batch.ingest import ADAPTERS

    return ADAPTERS


def load_source_profile(path: Path | None) -> SourceProfile:
    """プロファイルを読む。"""
    text = (path or _PROFILE_PATH).read_text(encoding="utf-8")
    raw = yaml.safe_load(text)
    adapters = _registered_adapters()
    return SourceProfile(
        target=Target(bbox=tuple(float(v) for v in raw["target"]["bbox"])),  # type: ignore[arg-type]
        sources=tuple(_parse_source(s, adapters) for s in raw["sources"]),
        profile_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
    )
