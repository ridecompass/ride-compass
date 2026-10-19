"""本番の管理APIへ、今の値との差を見てから書く道具（`axis_apply.py`・`road_classes_apply.py`）が共有する部品。

**書くのは、差を出したときの指紋を渡したときだけ**。指紋は今の値と書く値から作るので、差を見てから書くまでに本番が
変わっていれば一致せず、何も書かずに止まる。宛先はリポジトリの`production-origins.json`の`backend`、認証情報は
`backend/.env.oracle.local`の`ADMIN_BASIC_AUTH_USERNAME`・`ADMIN_BASIC_AUTH_PASSWORD`から読み、引数には取らず出力にも出さない。
"""

import hashlib
import json
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import httpx

_ABSENT = object()


class ApplyError(Exception):
    """書けなかった・確かめられなかった。文はそのまま利用者へ出す。"""


def request(client: httpx.Client, method: str, path: str, body: Any = None, *, allow_missing: bool = False) -> httpx.Response:
    """要求を1回送る。届かない・断られたらApplyError。`allow_missing`なら404は応答のまま返す。"""
    try:
        response = client.request(method, path, json=body)
    except httpx.HTTPError as error:
        raise ApplyError(f"{method} {path} が届きませんでした: {error}") from error
    if response.is_error and not (allow_missing and response.status_code == 404):
        try:
            detail = response.json().get("detail", response.text)
        except ValueError:
            detail = response.text
        raise ApplyError(f"{method} {path} が{response.status_code}を返しました: {detail}")
    return response


def fingerprint(current: Any, desired: Any) -> str:
    text = json.dumps([current, desired], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def check_fingerprint(given: str, mark: str) -> None:
    if given != mark:
        raise ApplyError(
            f"指紋が一致しません（渡した {given}、今の本番から作ると {mark}）。"
            "差を見てから本番が変わったか、別の差の指紋です。何も書いていません。差を出し直してください"
        )


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


@contextmanager
def production_client() -> Iterator[httpx.Client]:
    """本番のbackendへ、管理APIの認証情報を付けてつなぐ。"""
    from _prod_env import read_prod_env
    from _production_origins import production_origin

    auth = httpx.BasicAuth(read_prod_env("ADMIN_BASIC_AUTH_USERNAME"), read_prod_env("ADMIN_BASIC_AUTH_PASSWORD"))
    with httpx.Client(base_url=production_origin("backend"), auth=auth, timeout=30.0) as client:
        yield client
