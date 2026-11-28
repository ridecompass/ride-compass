"""キャッシュ鍵の組み立て（方針は .claude/rules/caching.md）。

署名はSHA-1の先頭12桁。鍵はタイルURLとディスクのディレクトリ名へ入るため、衝突耐性より
パス長を優先している（形の変化を見分けるのが目的で、暗号的な強度は要らない）。
"""

import dataclasses
import hashlib
import json
from collections.abc import Sequence
from pathlib import Path

from pydantic import BaseModel

from app.domain.landcover import LANDCOVER_CLASSES
from app.domain.model_settings import ModelSettings

# 土地被覆ラスタタイル。同じ配色のまま、元のGeoTIFFを別の年次・別の版へ差し替えたときと、
# ラスタの読み方・描き方（`landcover_raster.py`）を変えたときに上げる（画素が変わるのに
# URLもディスクキャッシュの鍵も変わらないため）。
LANDCOVER_REVISION = "2"

def _bound_values(source: object) -> list[tuple[str, str]]:
    """SQLのバインドパラメータのうち、定義時点で値が決まっているもの（名前と値）。

    実行時に値を渡すパラメータ（タイル座標等）はこの時点で値を持たない。
    """
    bindparams = getattr(source, "_bindparams", None)
    if not bindparams:
        return []
    return sorted(
        (name, repr(param.value)) for name, param in bindparams.items() if param.value is not None
    )


def _digest(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:12]


def shape_digest(*sources: object) -> str:
    """形の署名。dataclassは列名の並び、それ以外は文字列化した内容とバインド済みの値で決まる。

    dataclassを列名で署名するのは、道路網の置き場（`road_network_store.py`）が列ごとの
    ファイルを列名で読み書きするため。列を足す・消す・改名したコードが古い置き場を選ぶと、
    足した列のファイルが無いまま読みに行く。
    """
    parts = []
    for source in sources:
        if dataclasses.is_dataclass(source):
            parts.append(",".join(f.name for f in dataclasses.fields(source)))
            continue
        parts.append(str(source))
        parts.append(repr(_bound_values(source)))
    return _digest("\x1f".join(parts))


def cache_identity(revision: str, *shape_sources: object) -> str:
    """`<リビジョン>-<形の署名>`。タイルURL・ディスクパスへそのまま入れる。"""
    return f"{revision}-{shape_digest(*shape_sources)}"


#: 土地被覆ラスタタイルのURLへ入る世代（配色・クラス構成と手書きリビジョンから決まる）。
#:
#: **どのラスタを開いているかはここへ入れられない**。この値は生成物
#: （`region-tile-config.json`）を通してフロントのURLへ焼き込まれ、生成はビルド機で行う
#: ——どのラスタ（ゾーン・年）があるかは環境の置き場の中身で決まるため、入れると
#: 生成物がビルド機の置き場で決まり、本番の実際の構成とずれる。**実際に開けている**ラスタ
#: 構成への追随はサーバー側のディスクの鍵（`region_tile_cache.py: landcover_generation`）で行い、
#: ブラウザ側は`cache_policy.py`が`immutable`を付けないことで再検証できるようにしてある。
LANDCOVER_TILE_VERSION = cache_identity(LANDCOVER_REVISION, LANDCOVER_CLASSES)


def raster_set_fingerprint(raster_paths: list[str]) -> str:
    """ラスタ構成の指紋（ファイル名の集合から決まる短い文字列）。

    土地被覆の派生物は、どのラスタを開いていたかに従属する。「値なし」はその構成で
    そう確定したという意味しか持たず、ラスタを1枚足せば境界またぎ・範囲外だった場所は
    値を持ちうる。指紋を派生物の鍵へ入れておけば、構成が変わった時点で古い結果が
    使われなくなる。順序には依存させない（同じ集合をどの順で渡しても同じ指紋になる）。
    """
    joined = "\n".join(sorted(Path(path).name for path in raster_paths))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


#: 地域タイルのディスクの鍵の頭。同じ置き場に同居する地理院のタイル（配信元のパスが鍵）と分ける。
_REGION_TILE_KEY_ROOT = "region/"


def region_tile_generation_prefix(kind: str, generation: str) -> str:
    """地域タイルの1つの系統・1つの世代のディスクの鍵が共通に持つ頭。旧世代の掃除はこれで見分ける。"""
    return f"{_REGION_TILE_KEY_ROOT}{kind}/v{generation}/"


def region_tile_kind(key: str) -> str | None:
    """ディスクの鍵が地域タイルなら、その系統。地域タイルでない鍵はNone。"""
    if not key.startswith(_REGION_TILE_KEY_ROOT):
        return None
    return key[len(_REGION_TILE_KEY_ROOT):].split("/", 1)[0]


def region_tile_key(kind: str, generation: str, z: int, x: int, y: int, extension: str, variant: str) -> str:
    """地域タイル1枚のディスクの鍵。`variant`は同じ世代の中で中身が分かれる印（時刻で変わる交通規制。空なら分かれない）。"""
    suffix = f"-{variant}" if variant else ""
    return f"{region_tile_generation_prefix(kind, generation)}{z}/{x}/{y}{suffix}.{extension}"


#: 最後に署名した定義とその署名。定義は管理APIが書き換えるたびに別のオブジェクトへ差し替わる（中身を書き換えない）ので、
#: 同じオブジェクトなら署名し直さない。オブジェクトを参照で持つので、同じidが別のオブジェクトに使い回されることはない。
_definitions_digest: tuple[BaseModel, BaseModel, str] | None = None


def model_settings_signature(settings: ModelSettings) -> str:
    """較正値・道の区分・費用の軸の定義の束の署名。管理APIが書き換えると変わる。"""
    global _definitions_digest
    road_classes, cost_axes = settings.road_classes, settings.cost_axes
    cached = _definitions_digest
    if cached is None or cached[0] is not road_classes or cached[1] is not cost_axes:
        cached = road_classes, cost_axes, _digest(road_classes.model_dump_json() + cost_axes.model_dump_json())
        _definitions_digest = cached
    return f"{_digest(repr(sorted(settings.tuning.values.items())))}{cached[2]}"


def canonical_json(value: BaseModel) -> str:
    """利用者の値等の、同じ中身なら同じになる文字列（辞書の鍵の並びに依らない）。"""
    return json.dumps(value.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))


def dynamic_tile_key(kind: str, network_generation: str, settings_signature: str, item_id: str, z: int, x: int, y: int,
                     inputs: Sequence[str]) -> str:
    """要求の入力で値が変わるタイル1枚（地図のレンズ等）の、プロセスの中の持ちの鍵。道路網の世代と設定の署名を頭に持つので、
    どちらかが変われば古い鍵は読まれない。`inputs`は値を変える入力だけを並べる（同じ値になる要求どうしは同じ鍵になる）。"""
    return "/".join((kind, network_generation, settings_signature, item_id, f"{z}/{x}/{y}", *inputs))
