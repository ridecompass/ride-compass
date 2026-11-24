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

#: 標高タイルの製品（配信元の名前）と、配信元が実データを持つ最大のズーム。値を採る順に並べる——配信元が
#: 「最も計測精度の良い標高タイル」から順に参照すると定める順（DEM5A→DEM5B→DEM5C→DEM10B）。地図の陰影は画素を、道の標高の派生は点を
#: この順で埋める。出典: https://maps.gsi.go.jp/development/hyokochi.html
#: （ズームは https://maps.gsi.go.jp/development/ichiran.html の標高タイルの欄）
DEM_PRODUCT_MAX_ZOOM = {"dem5a": 15, "dem5b": 15, "dem5c": 15, "dem": 14}
PRODUCT_PRIORITY = tuple(DEM_PRODUCT_MAX_ZOOM)

#: 地図の陰影（Terrain-RGB）のズーム。上限は一番細かい製品の上限。
TERRAIN_MIN_ZOOM = 2
TERRAIN_MAX_ZOOM = max(DEM_PRODUCT_MAX_ZOOM.values())
TerrainTileZoom = Annotated[int, Field(ge=TERRAIN_MIN_ZOOM, le=TERRAIN_MAX_ZOOM)]
