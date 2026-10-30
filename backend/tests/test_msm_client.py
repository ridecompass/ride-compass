"""`infrastructure/msm_client.py`——気象庁MSMの予報を配信元と同期し、ローカルの`.om`ファイルから読む。

確かめるのは公開の入口（`refresh`・`read_series`・`read_grid_points`・`read_grid_block`・`read_weather_grid`・
`freshness`/`freshness_from_meta`/`warn_if_stale`）から
見える振る舞いだけ。差し替えるのはプロセス境界だけで、網は本物の`httpx.AsyncClient`へ配信元の代役
（respxの経路）を付け、ディスクは一時ディレクトリ、時計は固定する。何時間先まで同期し・読むかは
定数（`domain/weather_elements.py: MSM_FORECAST_HOURS`）をテストごとに差し替える。
`.om`ファイルは本物のライブラリ（omfiles）で書く。

ここで見ないもの:
- 範囲と形状から導いた格子の幾何と、双一次補間・最寄りの格子点の選び方そのもの・格子の外の地点を断ること → `test_msm.py`
- 予報を風へ組み立てる側 → `test_weather_service.py`

予報の値は「格子点(i, j)・チャンク内の時刻tで 100i + 10j + t（チャンクごとに1000ずつ足す）」にしてある。
補間した値の期待値が足し算で書け、格子点の値はどの格子点を読んだかが値に出る。チャンクの番号は配信元の決まり（1970年からの経過時間÷チャンクの長さ）。
"""

import logging
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import numpy as np
import pytest
import respx
from omfiles import OmFileWriter

from app.domain.time_zone import JST
from app.infrastructure import msm_client
from tests.fake_http import client_for

CHUNK_HOURS = 6
#: 2026-09-22 05:30 JST。6時間のチャンクは03:00 JSTに始まるので、先頭から2時間30分に当たる。
NOW = int(datetime(2026, 9, 22, 5, 30, tzinfo=JST).timestamp())
NOW_CHUNK = (NOW // 3600) // CHUNK_HOURS
CHUNK_START = NOW_CHUNK * CHUNK_HOURS * 3600
#: 格子は南緯35.0・西経139.0から0.05度おきに3×3。
BBOX_WKT = 'GEOGCRS["x", BBOX[35.0, 139.0, 35.1, 139.1]]'
SOUTH_WEST = (35.0, 139.0)
#: 南西の格子点と北隣の格子点のちょうど中間（i=0.5, j=0）。
HALF_NORTH = (35.025, 139.0)


def _meta(**overrides):
    meta = {
        "chunk_time_length": CHUNK_HOURS,
        "crs_wkt": BBOX_WKT,
        "data_end_time": CHUNK_START + 3 * CHUNK_HOURS * 3600,
        "last_run_initialisation_time": NOW - 3 * 3600,
        "last_run_availability_time": NOW - 1 * 3600,
        "update_interval_seconds": 3 * 3600,
    }
    meta.update(overrides)
    return meta


def _chunk_values(chunk_number: int, run: int) -> np.ndarray:
    i, j, t = np.meshgrid(np.arange(3), np.arange(3), np.arange(CHUNK_HOURS), indexing="ij")
    return (100 * i + 10 * j + t + 1000 * (chunk_number - NOW_CHUNK) + 10000 * run).astype(np.float32)


def _om_bytes(tmp_path, chunk_number: int, run: int) -> bytes:
    path = tmp_path / f"source_{chunk_number}_{run}.om"
    writer = OmFileWriter.at_path(str(path))
    writer.close(writer.write_array(_chunk_values(chunk_number, run), chunks=[3, 3, CHUNK_HOURS]))
    return path.read_bytes()


@pytest.fixture
def msm_dir(tmp_path, monkeypatch, clock):
    """同期先のディスクを一時ディレクトリへ、時計を`NOW`へ。"""
    directory = tmp_path / "msm"
    monkeypatch.setattr(msm_client, "MSM_DIR", directory)
    clock.move_to(datetime.fromtimestamp(NOW, UTC))

    def forecast_hours(hours: int) -> None:
        monkeypatch.setattr(msm_client, "MSM_FORECAST_HOURS", hours)

    return SimpleNamespace(path=directory, clock=clock, forecast_hours=forecast_hours)


class Source:
    """配信元の代役。チャンクはETagを付けて返し、`If-None-Match`が一致すれば304を返す。

    `run`は配信しているrunの番号で、値に10000ずつ足して出す。`failing`に挙げた変数のチャンクは500を返す。
    """

    def __init__(self, tmp_path, meta=None, *, run=0, failing=()):
        self.tmp_path = tmp_path
        self.run = run
        self.failing = failing
        self.router = respx.Router()
        self.router.get(path__regex=r"/static/meta\.json$").respond(json=_meta() if meta is None else meta)
        self.chunks = self.router.get(path__regex=r"/(?P<variable>[^/]+)/chunk_(?P<number>\d+)\.om$").mock(
            side_effect=self._chunk
        )

    def _chunk(self, request: httpx.Request, variable: str, number: str) -> httpx.Response:
        if variable in self.failing:
            return httpx.Response(500)
        etag = f'"{variable}-{number}-{self.run}"'
        if request.headers.get("If-None-Match") == etag:
            return httpx.Response(304)
        return httpx.Response(200, content=_om_bytes(self.tmp_path, int(number), self.run), headers={"ETag": etag})

    def client(self) -> httpx.AsyncClient:
        return client_for(self.router)

    def chunk_requests(self):
        return [call.request for call in self.chunks.calls]


async def _synced(tmp_path, msm_dir, meta=None, horizon_hours=CHUNK_HOURS):
    source = Source(tmp_path, meta)
    msm_dir.forecast_hours(horizon_hours)
    async with source.client() as client:
        await msm_client.refresh(client)
    return source


async def _read(msm_dir, points, hours):
    msm_dir.forecast_hours(hours)
    return await msm_client.read_series(*points)


def _points(*points):
    return np.array([p[0] for p in points]), np.array([p[1] for p in points])


# --- 同期（refresh） ---


class TestSyncing:
    async def test_every_variable_is_fetched_for_the_chunks_covering_the_horizon(self, tmp_path, msm_dir):
        """今のチャンクと、`horizon_hours`先を含むチャンク。3時間先は今のチャンクの中、6時間先は次のチャンク。

        配信元のチャンク（実際は114時間）は予報窓より長いため、取るのは多くて2つ。
        """
        source = Source(tmp_path)
        async with source.client() as client:
            msm_dir.forecast_hours(3)
            within = await msm_client.refresh(client)
            msm_dir.forecast_hours(6)
            beyond = await msm_client.refresh(client)

        variables = len(msm_client.FORECAST_VARIABLES)
        assert within == variables
        assert beyond == variables  # 今のチャンクは変わっていないので、取るのは次のチャンクだけ
        fetched = {r.url.path.rsplit("/", 1)[-1] for r in source.chunk_requests()}
        assert fetched == {f"chunk_{NOW_CHUNK}.om", f"chunk_{NOW_CHUNK + 1}.om"}

    async def test_a_chunk_whose_file_was_lost_is_fetched_again_even_with_a_known_etag(self, tmp_path, msm_dir):
        """「変更なし」を信じて、無いファイルを読みに行かない。"""
        source = Source(tmp_path)
        async with source.client() as client:
            msm_dir.forecast_hours(3)
            await msm_client.refresh(client)
            variable = next(iter(msm_client.FORECAST_VARIABLES))
            (msm_dir.path / variable / f"chunk_{NOW_CHUNK}.om").unlink()
            msm_dir.forecast_hours(3)
            again = await msm_client.refresh(client)

        assert again == 1

    async def test_chunks_no_longer_covered_are_removed(self, tmp_path, msm_dir):
        """1ファイル十数MBあるため、予報に使わなくなった過去のチャンクを残さない。"""
        source = Source(tmp_path)
        async with source.client() as client:
            msm_dir.forecast_hours(3)
            await msm_client.refresh(client)
            msm_dir.clock.tick(CHUNK_HOURS * 3600)
            msm_dir.forecast_hours(3)
            await msm_client.refresh(client)

        for variable in msm_client.FORECAST_VARIABLES:
            names = {p.name for p in (msm_dir.path / variable).glob("chunk_*.om")}
            assert names == {f"chunk_{NOW_CHUNK + 1}.om"}

    async def test_a_sync_that_fails_partway_keeps_every_variable_from_the_previous_run(self, tmp_path, msm_dir):
        """東西の成分だけ新しいrunへ入れ替わると、風が東西と南北で別のrunから組まれ、実在しない風になる。"""
        await _synced(tmp_path, msm_dir, horizon_hours=3)
        newer = Source(tmp_path, run=1, failing=("wind_v_component_10m",))
        async with newer.client() as client:
            with pytest.raises(httpx.HTTPStatusError):
                await msm_client.refresh(client)

        series = await _read(msm_dir, _points(SOUTH_WEST), 1)

        assert (series.wind_u_ms.tolist(), series.wind_v_ms.tolist()) == ([[2.0]], [[2.0]])

    async def test_after_syncing_the_schedule_of_the_source_is_readable(self, tmp_path, msm_dir):
        assert msm_client.freshness() is None

        await _synced(tmp_path, msm_dir, _meta(update_interval_seconds=7200))

        # 2時間ごとの公開を2回続けて落としたら止まったと見る
        assert msm_client.freshness().stale_threshold_hours == pytest.approx(4.0)

    async def test_syncing_a_source_that_stopped_publishing_warns(self, tmp_path, msm_dir, caplog):
        """ETagで304が続くと件数からは止まったことが分からない。公開の経過で気づく。"""
        stale = _meta(last_run_availability_time=NOW - 7 * 3600)
        with caplog.at_level(logging.WARNING, logger="ridecompass.msm_client"):
            await _synced(tmp_path, msm_dir, stale, horizon_hours=3)

        assert any("公開されていません" in r.getMessage() for r in caplog.records)


# --- 読み出し（read_series） ---


class TestReading:
    async def test_each_point_is_interpolated_between_the_grid_points_around_it(self, tmp_path, msm_dir):
        """南西の格子点はそのまま、北隣との中間は2点の平均（100i + 10j + t で i=0.5）。"""
        await _synced(tmp_path, msm_dir)

        series = await _read(msm_dir, _points(SOUTH_WEST, HALF_NORTH), 2)

        # 05:00はチャンクの先頭から2時間目（t=2）。
        assert series.wind_u_ms == pytest.approx(np.array([[2.0, 3.0], [52.0, 53.0]]))

    async def test_a_series_crossing_into_the_next_chunk_continues_from_it(self, tmp_path, msm_dir):
        await _synced(tmp_path, msm_dir)

        series = await _read(msm_dir, _points(SOUTH_WEST), 6)

        assert series.times[3:] == [datetime(2026, 9, 22, 8, 0), datetime(2026, 9, 22, 9, 0), datetime(2026, 9, 22, 10, 0)]
        assert series.wind_u_ms[0].tolist() == [2.0, 3.0, 4.0, 5.0, 1000.0, 1001.0]

    async def test_a_forecast_ending_between_hours_is_read_up_to_its_last_hour(self, tmp_path, msm_dir):
        await _synced(tmp_path, msm_dir, _meta(data_end_time=CHUNK_START + 3 * 3600 + 1800))

        series = await _read(msm_dir, _points(SOUTH_WEST), 6)

        assert series.times == [datetime(2026, 9, 22, 5, 0)]

    async def test_each_point_reads_its_nearest_grid_point_unchanged(self, tmp_path, msm_dir):
        """中間を少し越えた地点は、補間せずに近い方の格子点の値そのもの（i=1で100）を読む。"""
        await _synced(tmp_path, msm_dir)
        msm_dir.forecast_hours(2)

        series = await msm_client.read_grid_points(*_points(SOUTH_WEST, (HALF_NORTH[0] + 0.001, HALF_NORTH[1])))

        for values in (series.wind_u_ms, series.wind_v_ms, series.precipitation_mm, series.temperature_c):
            assert values.tolist() == [[2.0, 3.0], [102.0, 103.0]]
        latitudes, longitudes = series.points.coordinates()
        assert latitudes.tolist() == pytest.approx([35.0, 35.05])
        assert longitudes.tolist() == pytest.approx([139.0, 139.0])

    async def test_a_rectangle_reads_the_grid_points_of_the_source_wherever_its_grid_starts(self, tmp_path, msm_dir):
        """配信元の格子の原点が0.05度の倍数でなくても、読む格子点は配信元の格子点そのもの（地図とルートが同じ点を引く）。"""
        await _synced(tmp_path, msm_dir, _meta(crs_wkt='GEOGCRS["x", BBOX[35.01, 139.01, 35.11, 139.11]]'))
        msm_dir.forecast_hours(1)

        series = await msm_client.read_grid_block(35.02, 139.02, 35.04, 139.04)

        latitudes, longitudes = series.points.coordinates()
        assert latitudes.tolist() == pytest.approx([35.01, 35.01, 35.06, 35.06])
        assert longitudes.tolist() == pytest.approx([139.01, 139.06, 139.01, 139.06])
        assert series.wind_u_ms[:, 0].tolist() == [2.0, 12.0, 102.0, 112.0]

    async def test_the_map_grid_reads_wind_and_rain_at_every_other_grid_point_counted_from_the_origin(self, tmp_path, msm_dir):
        """3×3の格子を4点までに間引くと、原点から2つおきの四隅が残る。格子の外へ出た範囲は捨てて読む。値は格子点の値のまま。"""
        await _synced(tmp_path, msm_dir)
        msm_dir.forecast_hours(1)

        series = await msm_client.read_weather_grid(35.04, 138.9, 35.2, 139.06, 4)

        latitudes, longitudes = series.points.coordinates()
        assert latitudes.tolist() == pytest.approx([35.0, 35.0, 35.1, 35.1])
        assert longitudes.tolist() == pytest.approx([139.0, 139.1, 139.0, 139.1])
        assert series.points.step_deg == pytest.approx((0.1, 0.1))
        for values in (series.wind_u_ms, series.wind_v_ms, series.precipitation_mm):
            assert values.tolist() == [[2.0], [22.0], [202.0], [222.0]]


# --- 鮮度 ---


def _freshness(**overrides):
    return msm_client.freshness_from_meta(_meta(**overrides), now=datetime.fromtimestamp(NOW, JST))


class TestFreshness:
    def test_ages_and_remaining_hours_are_measured_from_now(self):
        value = _freshness()

        assert value.run_age_hours == pytest.approx(3.0)
        assert value.publish_age_hours == pytest.approx(1.0)
        assert value.remaining_hours == pytest.approx(15.5)
        assert value.stale_threshold_hours == pytest.approx(6.0)  # 3時間ごとの公開を2回続けて落とした

    def test_a_source_without_a_publication_time_is_judged_by_the_run_time(self):
        """公開遅れのぶん早く「止まった」と言う側に倒れる。"""
        value = _freshness(last_run_availability_time=None)

        assert value.publish_age_hours == pytest.approx(3.0)

    @pytest.mark.parametrize("interval", [0, None])
    def test_an_unusable_update_interval_falls_back_to_three_hours(self, interval):
        assert _freshness(update_interval_seconds=interval).stale_threshold_hours == pytest.approx(6.0)
