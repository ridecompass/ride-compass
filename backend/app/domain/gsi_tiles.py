"""国土地理院タイルの製品ごとの事実（配信元の住所・実データを持つ範囲・出典表記）。

画面が写しを持つと、上限を片側だけ広げたときに黙ってタイルが出なくなる（例外にならない）。
出典表記は利用条件の一部で、データを取りに行く側が持つ。
"""

from typing import Annotated

from pydantic import Field

#: 地理院タイルの配信元。
GSI_TILE_ORIGIN = "https://cyberjapandata.gsi.go.jp"

#: 色別標高図。画面が配信元から直に読む住所と、配信元が実データを持つ上限。
RELIEF_TILE_URL = f"{GSI_TILE_ORIGIN}/xyz/relief/{{z}}/{{x}}/{{y}}.png"
RELIEF_MAX_ZOOM = 15
RELIEF_ATTRIBUTION = (
    '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank"'
    ' rel="noreferrer">地理院タイル(色別標高図)</a>'
)

#: 標高タイル（DEM10B、10mメッシュ）。配信元が実データを持つのはz14まで。
TERRAIN_MIN_ZOOM = 2
TERRAIN_MAX_ZOOM = 14
TerrainTileZoom = Annotated[int, Field(ge=TERRAIN_MIN_ZOOM, le=TERRAIN_MAX_ZOOM)]
