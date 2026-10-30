"""`/api/admin/debug`（debug_modeの切替・直近ログの取得）と、ログを持つリングバッファ（`debug_control.py`）。

ここで見ないもの: 認可 → `test_admin_route_authorization.py`、ログ1行の書式 → `test_request_log.py`
"""

import logging
import uuid

import pytest
from fastapi.testclient import TestClient

from app.infrastructure.debug_control import RING_BUFFER_MAX_SIZE, get_recent_logs
from app.main import app
from tests.admin_auth import AUTH_HEADERS

client = TestClient(app)


pytestmark = pytest.mark.usefixtures("restore_debug_mode")


# --- debug_modeのランタイム切替（再起動不要） ---


@pytest.mark.parametrize("enabled", [True, False])
def test_the_mode_switches_without_restart_and_reads_back(admin_credentials, enabled):
    update_response = client.post("/api/admin/debug/mode", json={"enabled": enabled}, headers=AUTH_HEADERS)
    read_response = client.get("/api/admin/debug/mode", headers=AUTH_HEADERS)

    assert (update_response.status_code, read_response.status_code) == (200, 200)
    assert update_response.json() == read_response.json() == {"debug_mode": enabled}


# --- ログ取得（リングバッファ、containsで絞り込み） ---


def test_read_logs_filters_by_contains(admin_credentials):
    client.post("/api/admin/debug/mode", json={"enabled": True}, headers=AUTH_HEADERS)
    marker = uuid.uuid4().hex
    logger = logging.getLogger("test.t377")
    logger.debug("distance filter rejected bearing=0 marker=%s", marker)
    logger.debug("distance filter rejected bearing=1 marker=%s", marker)

    response = client.get("/api/admin/debug/logs", params={"contains": f"distance filter rejected bearing=1 marker={marker}"}, headers=AUTH_HEADERS)

    assert response.status_code == 200
    lines = response.json()
    assert len(lines) == 1
    assert f"bearing=1 marker={marker}" in lines[0]


def test_read_logs_filters_by_min_level(admin_credentials):
    """`min_level`を渡すと、そのレベル以上だけが返る（境の両側のINFOとWARNINGで見る）。"""
    client.post("/api/admin/debug/mode", json={"enabled": True}, headers=AUTH_HEADERS)
    marker = uuid.uuid4().hex
    logger = logging.getLogger("test.t517")
    logger.info("info line marker=%s", marker)
    logger.warning("warning line marker=%s", marker)

    response = client.get(
        "/api/admin/debug/logs", params={"contains": marker, "min_level": "WARNING"}, headers=AUTH_HEADERS
    )

    assert response.status_code == 200
    lines = response.json()
    assert len(lines) == 1
    assert "[WARNING]" in lines[0]




# --- リングバッファの上限件数（debug_control.py単体） ---


def test_ring_buffer_keeps_only_most_recent_entries():
    marker = uuid.uuid4().hex
    logger = logging.getLogger("test.t377.ringbuffer")
    logger.setLevel(logging.DEBUG)
    for i in range(RING_BUFFER_MAX_SIZE + 1):
        logger.debug("entry %d marker=%s", i, marker)

    lines = get_recent_logs(limit=None, contains=marker, min_level=None)

    assert len(lines) == RING_BUFFER_MAX_SIZE
    assert "entry 1 " in lines[0]
    assert f"entry {RING_BUFFER_MAX_SIZE} " in lines[-1]
