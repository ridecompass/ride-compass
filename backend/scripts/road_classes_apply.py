r"""道の区分の全体を、本番の今の全体との差を見てから管理APIで入れる。

    python scripts/road_classes_apply.py <全体.json>                 # 差を出すだけ（書かない）
    python scripts/road_classes_apply.py <全体.json> --apply <指紋>  # 差を出したときの指紋を渡して書く

全体のJSONは管理APIの全体の読み（`GET /api/admin/road-classes`）と同じ形で、書くと本番の全体がこれに入れ替わる。
形の良し悪しは本番の表の制約が決め、通らなければ何も変えずに断りの文を出す。書くのは差を出したときの指紋を
`--apply`に渡したときだけで、宛先と認証情報の読み方も`scripts/_admin_apply.py`が持つ。書いた後は、管理APIの全体の読みと、
公開の軸カタログの区分の指紋の両方で反映を確かめる。
"""

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import httpx
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _admin_apply import ApplyError, check_fingerprint, diff_lines, fingerprint, production_client, request

from app.domain.road_classes import RoadClassDefinitions, road_class_generation

ADMIN_PATH = "/api/admin/road-classes"
CATALOG_PATH = "/api/axis-catalog"

Definitions = dict[str, Any]


def _canonical(fields: Any) -> Definitions:
    return RoadClassDefinitions.model_validate(fields).model_dump(mode="json")


def load_definitions(path: Path) -> Definitions:
    try:
        return _canonical(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ValidationError) as error:
        raise ApplyError(f"{path} を道の区分の全体として読めません: {error}") from error


def read_current(client: httpx.Client) -> Definitions:
    return _canonical(request(client, "GET", ADMIN_PATH).json())


def verify(client: httpx.Client, desired: Definitions) -> None:
    """管理APIの全体の読みと、公開の軸カタログ（利用者の画面が読むもの）の区分の指紋の両方で反映を確かめる。"""
    now = read_current(client)
    if now != desired:
        raise ApplyError("書いた後の全体が、書いた全体と一致しません:\n" + "\n".join(diff_lines(desired, now)))
    served = request(client, "GET", CATALOG_PATH).json()["road_classes"]["generation"]
    if served != road_class_generation(RoadClassDefinitions.model_validate(desired)):
        raise ApplyError(f"軸カタログの区分の指紋 {served} が、書いた全体の指紋と一致しません")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="道の区分の全体を、差を見てから本番の管理APIで入れる")
    parser.add_argument("file", type=Path, help="道の区分の全体のJSON")
    parser.add_argument("--apply", metavar="指紋", help="差を出したときの指紋。一致したときだけ書く")
    return parser.parse_args(argv)


def run(args: argparse.Namespace, client: httpx.Client) -> int:
    try:
        desired = load_definitions(args.file)
        current = read_current(client)
        if current == desired:
            print("差はありません。書くものはありません。")
            return 0
        print("\n".join(diff_lines(current, desired)))
        mark = fingerprint(current, desired)
        if args.apply is None:
            print(f"指紋: {mark}")
            print(f"書くには: python scripts/road_classes_apply.py {args.file} --apply {mark}")
            return 0
        check_fingerprint(args.apply, mark)
        request(client, "PUT", ADMIN_PATH, desired)
        verify(client, desired)
    except ApplyError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("書きました。管理APIと軸カタログで反映を確かめました。")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    with production_client() as client:
        return run(args, client)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
