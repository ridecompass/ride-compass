"""勾配の「フィーチャー→道ごとの材料」配信専用のディスクキャッシュ。
路面タイルのフィーチャー別の材料を配るレイヤーで、材料そのものの取得層とは別レイヤー。
配信する材料のうちキャッシュするのは勾配だけで、時刻に依る材料（風）はキャッシュしない
（docs/modules/backend/dynamic-way-values.md「キャッシュ」節）。

キーは`(路面タイルの世代, material_id, 材料の値の作り方の署名, z, x, y)`。要求の条件（走行方位・想定速度）は
鍵に入らない——値は条件に依らない道ごとの材料で、条件は地図と配信が式の木で当てる。
値は配信サービスが返すのと同じ`{材料の名前: {feature_key: 値}}`のdict。

材料の値の作り方の署名（`value_shape`）も呼び出し側が必須キーワードで渡す。材料単位の失効を
消去でなく鍵で表す理由は docs/modules/backend/dynamic-way-values.md「キャッシュ」節。

**キーへ路面タイルの世代（`cache_identity.py: tile_version`）を含める理由**: ここに入る鍵は路面タイルの
`feature_key`と一字一句一致して初めて意味を持つ（フロントが`setFeatureState`のidとして使う）。
鍵の中身は**形の署名だけでは決まらない**——`feature_key`は`road_edges`の中身そのもので、
バッチが作り直せば同じSQLでも別の値になる。形の署名だけを鍵にすると、世代をまたいだ
エントリがどの地物にも一致しないまま生き残り、TTLが切れるまで色が静かに消える。

路面タイルの世代は**呼び出し側が必須キーワードで渡す**（`surface_tile_version`。配信している路面タイルと
同じ文字列）。infrastructureから`services/tile_version_service.py`を読むと依存が逆向きになるため、
ここでは受け取るだけにする。省略できない形にしてあるので、新しい材料を足したときに渡し忘れると
その場で失敗する（静かに古い値を配るより良い）。
"""

import asyncio

from app.infrastructure import tile_persistent_cache

_KEY_PREFIX = "dynway"

# 勾配の入力は道路の向きと標高で決まりほぼ不変のため、鮮度の制約が無い。長く持って
# DBへの再問い合わせを抑える。正本を持たないキャッシュで、期限切れ後は再計算されるだけ。
_TTL_SECONDS = 24 * 3600

#: 材料の名前→`{フィーチャー鍵: 値}`。
TileWayMaterials = dict[str, dict[str, float]]


def _key(material_id: str, z: int, x: int, y: int, surface_tile_version: str, value_shape: str) -> tuple:
    return (_KEY_PREFIX, surface_tile_version, material_id, value_shape, z, x, y)


async def get_tile_materials(
    material_id: str, z: int, x: int, y: int, *, surface_tile_version: str, value_shape: str,
) -> TileWayMaterials | None:
    """タイルの道ごとの材料。未キャッシュ・読み出し失敗はいずれもNone。

    値の無いタイルは空のdictとして返り、Noneとは別に扱われる（呼び出し元はNoneのときだけ計算し直す）。
    """
    key = _key(material_id, z, x, y, surface_tile_version, value_shape)
    return await asyncio.to_thread(tile_persistent_cache.get_by_key, key)


async def set_tile_materials(
    material_id: str,
    z: int,
    x: int,
    y: int,
    materials: TileWayMaterials,
    *,
    surface_tile_version: str,
    value_shape: str,
) -> None:
    """新規に求めた道ごとの材料をディスクへ書き戻す。"""
    key = _key(material_id, z, x, y, surface_tile_version, value_shape)
    await asyncio.to_thread(
        tile_persistent_cache.set_by_key, key, {name: dict(values) for name, values in materials.items()},
        expire=_TTL_SECONDS)
