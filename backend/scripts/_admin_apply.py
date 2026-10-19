"""本番の管理APIへ定義を入れる道具（`axis_apply.py`・`road_classes_apply.py`）が共に使う、要求・差・指紋。

指紋は今の定義と書く定義から作るので、差を見てから書くまでに本番が変われば一致しない。
"""

import hashlib
import json
from typing import Any

import httpx

_ABSENT = object()


class ApplyError(Exception):
    """書けなかった・確かめられなかった。文はそのまま利用者へ出す。"""


def request_admin(client: httpx.Client, method: str, path: str, body: Any = None) -> httpx.Response:
    """管理APIへの要求。GETの404は無いものとして応答を返し、ほかの失敗は断りの文を添えて止まる。"""
    try:
        response = client.request(method, path, json=body)
    except httpx.HTTPError as error:
        raise ApplyError(f"{method} {path} が届きませんでした: {error}") from error
    if response.is_error and not (method == "GET" and response.status_code == 404):
        try:
            detail = response.json().get("detail", response.text)
        except ValueError:
            detail = response.text
        raise ApplyError(f"{method} {path} が{response.status_code}を返しました: {detail}")
    return response


def fingerprint(current: Any, desired: Any) -> str:
    text = json.dumps([current, desired], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    if isinstance(value, dict) and value:
        flat: dict[str, Any] = {}
        for key, child in value.items():
            flat.update(_flatten(child, f"{prefix}.{key}" if prefix else str(key)))
        return flat
    return {prefix: value}


def _show(value: Any) -> str:
    return "（なし）" if value is _ABSENT else json.dumps(value, ensure_ascii=False)


def diff_lines(before: dict[str, Any] | None, after: dict[str, Any] | None) -> list[str]:
    """項目ごとの「前 → 後」。入れ子は葉の項目まで分け、消える葉を同じ項目の中で足される葉より先に並べる。"""
    old = _flatten(before) if before else {}
    new = _flatten(after) if after else {}
    keys = list(old) + [key for key in new if key not in old]
    top_level = list(dict.fromkeys(key.split(".")[0] for key in keys))
    keys.sort(key=lambda key: top_level.index(key.split(".")[0]))
    return [
        f"  {key}: {_show(old.get(key, _ABSENT))} → {_show(new.get(key, _ABSENT))}"
        for key in keys
        if old.get(key, _ABSENT) != new.get(key, _ABSENT)
    ]
