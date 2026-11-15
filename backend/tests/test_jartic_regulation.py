"""JARTIC の交通規制情報の取込（アダプタ`jartic_regulation`）。

入口は取込（`ingest_source`。アダプタは本物で、手元の zip を読む）。配布の形の小さな見本（cp932 の CSV の zip と、取り込む
都道府県を決める ABR の市区町村の代表点の zip）を置き場に書き、生データに入った行を見る。

ここで見ないもの:
- 規制を区間へ当てる派生 → その段のテスト
- 配布元から手元へ写す取得 → `test_fetch_jartic_regulations.py`
"""

import csv
import io
import zipfile

import pytest

from app.batch.common import write_fetch_record
from app.batch.ingest import ingest_source
from app.batch.source_adapters import abr, jartic_regulation
from app.infrastructure.source_models import Source
from tests.source_ingest import profile_within

pytestmark = pytest.mark.asyncio(loop_scope="module")

#: 取込の範囲（min_lat, min_lon, max_lat, max_lon）。
BBOX = (35.40, 139.20, 35.80, 139.80)
PROFILE = profile_within(BBOX)
PEDESTRIAN = PROFILE.source(Source.JARTIC_REGULATION).rows.kinds[0]

#: 配布の CSV の見出しの一部（配布のまま）。
COLUMNS = ["拡張版標準フォーマット種別・バージョン", "共通規制種別コード", "点・線・面コード", "県別規制種別名称",
           "ユニークキー", "規制場所の経度緯度", "規制時間1_開始"]


def _coordinates(*points: tuple[float, float]) -> str:
    return ";".join(f"{lon} {lat}" for lon, lat in points)


#: 規制: (ユニークキー, 共通規制種別コード, 点・線・面コード, 規制場所の経度緯度)。
REGULATIONS = [
    ("line", PEDESTRIAN, "2", _coordinates((139.700, 35.680), (139.701, 35.681), (139.702, 35.681))),
    # 範囲の東の端（139.80）をまたぐ線。
    ("crossing", PEDESTRIAN, "2", _coordinates((139.79, 35.70), (139.81, 35.70))),
    ("outside", PEDESTRIAN, "2", _coordinates((139.90, 35.70), (139.91, 35.70))),
    # 辺が交わる（8の字の）面。閉じない並び。
    ("bowtie", PEDESTRIAN, "3", _coordinates((139.70, 35.68), (139.71, 35.69), (139.71, 35.68), (139.70, 35.69))),
    ("other_kind", "63", "1", _coordinates((139.70, 35.68))),
]


def _write_zip(path, text: str, encoding: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(f"{path.stem}/police_k_2.1.csv", text.encode(encoding))


def _csv(header: list[str], rows: list[list[str]]) -> str:
    text = io.StringIO()
    writer = csv.writer(text, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)
    return text.getvalue()


def _write_regulations(regulations) -> None:
    rows = [["k_2.1", kind, shape, "通行禁止", key, coordinates, ""] for key, kind, shape, coordinates in regulations]
    _write_zip(jartic_regulation.archive_path("13"), _csv(COLUMNS, rows), "cp932")
    write_fetch_record(jartic_regulation.DATA_DIR, versions={"13": "given"})


@pytest.fixture
def city_positions(monkeypatch, tmp_path):
    """取り込む都道府県を東京都（範囲の中に代表点を持つ新宿区）に決める ABR の市区町村の代表点。"""
    monkeypatch.setattr(abr, "DATA_DIR", tmp_path / "abr")
    monkeypatch.setattr(jartic_regulation, "DATA_DIR", tmp_path / "jartic")
    _write_zip(abr.archive_path("mt_city_pos_all"),
               _csv(["lg_code", "rep_lon", "rep_lat"], [["131041", "139.70", "35.69"]]), "utf-8")


@pytest.mark.usefixtures("city_positions")
async def test_宣言の種別で範囲の枠に掛かる規制を線か直した面で配布の列のまま入れる(derive_conn):
    """枠をまたぐ線は入り、枠の外の線と宣言に無い種別は入らない。辺の交わる面は、空間の演算が通る面に直して入る。"""
    _write_regulations(REGULATIONS)

    await ingest_source(derive_conn, PROFILE, Source.JARTIC_REGULATION)

    rows = {row["natural_key"]: row for row in await derive_conn.fetch(
        "SELECT natural_key, ST_GeometryType(geom) AS kind, ST_IsValid(geom) AS valid, ST_Area(geom) AS area,"
        " attrs->>'規制時間1_開始' AS hours, attrs->>'県別規制種別名称' AS name"
        " FROM source_features WHERE source = $1", Source.JARTIC_REGULATION)}
    assert {key: row["kind"] for key, row in rows.items()} == {
        "line": "ST_LineString", "crossing": "ST_LineString", "bowtie": "ST_MultiPolygon"}
    assert rows["bowtie"]["valid"] and rows["bowtie"]["area"] > 0
    assert (rows["line"]["name"], rows["line"]["hours"]) == ("通行禁止", "")


@pytest.mark.usefixtures("city_positions")
async def test_線でも面でもない形の規制があれば取込を失敗にする(derive_conn):
    """一部の規制だけを落として通すと、避けるはずの道が黙って抜ける。"""
    _write_regulations([("point", PEDESTRIAN, "1", _coordinates((139.70, 35.68)))])

    with pytest.raises(ValueError, match="point"):
        await ingest_source(derive_conn, PROFILE, Source.JARTIC_REGULATION)
