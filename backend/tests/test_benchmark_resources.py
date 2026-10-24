"""ベンチの資源の測り（`benchmarks/_resources.py: sample_resources`）が、測った区間の実態を出すか。

DB側の標本はテストDBから本当に取る。差し替えるのは、OSが持たない関数（Windowsに無い`resource`・`os.getloadavg`）だけ。

ここで見ないもの: 標本に現れたクエリの割合と実行計画（DBに区間中の文を確実に走らせる手が無い）。
"""

import importlib
import os
import sys
import time

import pytest

from app.batch.common import asyncpg_dsn
from tests.conftest import postgis_database_url

#: 標本を取るテストDBを用意させる。
pytestmark = [pytest.mark.usefixtures("road_graph_engine"), pytest.mark.asyncio(loop_scope="module")]

#: 区間の中で間隔ごとの標本が1つも取られない長さ。
_LONGER_THAN_THE_REGION = 60.0


async def test_without_resource_and_loadavg_it_loads_and_reports_them_as_not_measured(monkeypatch):
    monkeypatch.setitem(sys.modules, "resource", None)
    monkeypatch.delattr(os, "getloadavg")
    monkeypatch.delitem(sys.modules, "benchmarks._resources", raising=False)
    resources = importlib.import_module("benchmarks._resources")

    async with resources.sample_resources(asyncpg_dsn(postgis_database_url())) as trace:
        pass

    measured = trace.as_dict()
    assert measured["process_peak_rss_mb"] is None
    assert measured["peak_load1"] is None
    assert trace.summary().count("測れない") == 2


async def test_cpu_spent_in_a_region_shorter_than_the_interval_is_counted():
    from benchmarks._resources import sample_resources

    async with sample_resources(asyncpg_dsn(postgis_database_url()), interval=_LONGER_THAN_THE_REGION) as trace:
        started = time.process_time()
        while time.process_time() - started < 0.2:
            pass

    assert trace.app_cpu_seconds >= 0.2
