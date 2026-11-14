"""`batch/fetch_cli.py`——取得の入口。

入口は`fetch_sources`と`main`。見るのは、アダプタの登録に取得を足したソースを入口が書き換えなしに宣言の並び順で取り、
取得を持たないソースを飛ばすことと、上流から取り直してから今回置かなかった前のものを消すことと、取れなければ落ちずに失敗の終了コードを返すこと。
取り直しは本物のアダプタ（警察庁の本票CSV）で、配布元の応答（`respx_mock`）と置き場だけを差し替えて見る。

ここで見ないもの:
- ソースごとの取り方 → 各取得のテスト（`test_fetch_osm_pbf.py`・`test_fetch_jartic_regulations.py`・`test_fetch_dem_tiles.py`）
- 本票の列の読み方 → `test_npa_honhyo.py`
"""

import os
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml

from app.batch.common import FETCH_RECORD_NAME, FetchError
from app.batch.fetch_cli import fetch_sources, main
from app.batch.ingest import ADAPTERS, AdapterInputs, Fetcher, RegisteredAdapter, SourceRecord
from app.batch.source_adapters import npa_honhyo
from app.batch.source_profile import NoFields, SourceProfile, SourceSpec, Target, load_source_profile


def _no_inputs(spec: SourceSpec, profile: SourceProfile) -> AdapterInputs:
    return AdapterInputs(files=())


async def _no_records(spec: SourceSpec, profile: SourceProfile, inputs: AdapterInputs,
                      origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    return
    yield


def _register(monkeypatch, name: str, fetcher: Fetcher | None) -> None:
    monkeypatch.setitem(ADAPTERS, name, RegisteredAdapter(
        read=_no_records, rows=NoFields, grid=NoFields, inputs=_no_inputs, fetcher=fetcher))


def _spec(name: str, adapter: str) -> SourceSpec:
    return SourceSpec(name=name, adapter=adapter, rows=NoFields(), grid=NoFields())


def _profile(*specs: SourceSpec) -> SourceProfile:
    return SourceProfile(target=Target(bbox=(35.0, 139.0, 36.0, 140.0)), sources=specs, profile_hash="given")


def test_a_source_whose_adapter_registers_a_fetch_is_fetched_in_declared_order(tmp_path: Path, monkeypatch):
    """取得を足したアダプタのソースは、入口を書き換えずに取られる。並び順を守らないと、ほかのソースが置いたもの
    （範囲の都道府県を決める住所の代表点等）を読む取得が、読む元より先に走る。同じ置き場を分け合うソースの片方を取った
    あとで前のものを消すと、取ったものが消える。"""
    store = tmp_path / "given"
    store.mkdir()
    (store / "previous").write_text("previous")
    fetched: list[str] = []

    def fetch(spec: SourceSpec, profile: SourceProfile) -> None:
        (store / spec.name).write_text(spec.name)
        fetched.append(spec.name)

    _register(monkeypatch, "given_fetched", Fetcher(fetch, lambda: (store,)))
    _register(monkeypatch, "given_unfetched", None)
    profile = _profile(_spec("first", "given_fetched"), _spec("unfetched", "given_unfetched"),
                       _spec("second", "given_fetched"))

    fetch_sources(profile, ["second", "unfetched", "first"])

    assert fetched == ["first", "second"]
    assert sorted(p.name for p in store.iterdir()) == ["first", "second"]


def test_a_store_keeps_the_previous_files_while_fetching_and_drops_those_not_placed_again(tmp_path: Path, monkeypatch):
    """取っている間、置き場は前のもので埋まったままで（配信中のbackendが読む土地被覆の置き場が空にも半分にもならない）、
    取ったものの記録だけは先に消える（途中で落ちた置き場を取り込ませない）。取り終えたら、置き換えたもの・書き直したものを残し、
    置き換わらなかった前のもの（前の年の版等）を消す。置き場のディレクトリは残す（つないだ所そのものの置き場は消せない）。
    前のものの更新時刻は先週へ戻す（同じ時刻の刻みの中で書き直すと、書き直したことが時刻に出ない）。"""
    store = tmp_path / "given"
    (store / "nested").mkdir(parents=True)
    for name in ("replaced", "rewritten", "stale", "nested/stale", FETCH_RECORD_NAME):
        (store / name).write_text("previous")
        os.utime(store / name, (0, 0))
    seen: list[str] = []

    def fetch(spec: SourceSpec, profile: SourceProfile) -> None:
        seen.extend(sorted(str(p.relative_to(store).as_posix()) for p in store.rglob("*")))
        (store / "replaced.part").write_text("latest")
        os.utime(store / "replaced.part", (0, 0))  # 配信元の更新時刻を写す取得（標高のタイル）は、置き換えても時刻が前と同じになる
        (store / "replaced.part").replace(store / "replaced")
        (store / "rewritten").write_text("latest")
        (store / "added").write_text("latest")

    _register(monkeypatch, "given_fetched", Fetcher(fetch, lambda: (store,)))

    fetch_sources(_profile(_spec("given", "given_fetched")), ["given"])

    assert seen == ["nested", "nested/stale", "replaced", "rewritten", "stale"]
    assert sorted(str(p.relative_to(store).as_posix()) for p in store.rglob("*")) == [
        "added", "nested", "replaced", "rewritten"]


def test_refetches_from_the_upstream_even_when_a_previous_file_is_in_the_store(tmp_path: Path, monkeypatch, respx_mock):
    """手元に前のファイルがあっても上流から取り直す。大きなファイルは配布元から何度にも分けて届くので、つないで置く。"""
    monkeypatch.setattr(npa_honhyo, "DATA_DIR", tmp_path)
    previous = npa_honhyo.honhyo_path(2024)
    previous.write_bytes(b"previous")
    (tmp_path / "honhyo_2019.csv").write_bytes(b"unlisted")
    respx_mock.get(npa_honhyo.LISTING_URL).respond(
        text='<a href="/publications/statistics/koutsuu/opendata/2024/opendata_2024.html">2024</a>')
    whole = "資料区分,都道府県コード,本票番号\n1,25,0001\n".encode(npa_honhyo.ENCODING)
    respx_mock.get(npa_honhyo.HONHYO_URL_TEMPLATE.format(year=2024)).respond(content=iter([whole[:10], whole[10:]]))

    fetch_sources(load_source_profile(None), ["accident"])

    assert previous.read_bytes() == whole
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted([previous.name, FETCH_RECORD_NAME])


@pytest.mark.parametrize("failure", [
    pytest.param(FetchError("given refusal"), id="取得が断った"),
    pytest.param(httpx.ConnectError("given failure"), id="通信に失敗した"),
])
def test_fails_without_raising_when_a_fetch_fails(tmp_path: Path, monkeypatch, failure: Exception):
    def fetch(spec: SourceSpec, profile: SourceProfile) -> None:
        raise failure

    _register(monkeypatch, "given_failing", Fetcher(fetch, lambda: (tmp_path / "given",)))
    path = tmp_path / "profile.yaml"
    path.write_text(yaml.safe_dump({
        "target": {"bbox": [35.0, 139.0, 36.0, 140.0]},
        "sources": [{"name": "given-source", "adapter": "given_failing"}],
    }), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["fetch_cli", "--all", "--profile", str(path)])

    assert main() == 1
