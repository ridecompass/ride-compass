"""pytest の結果を、標準出力からでなく JUnit XML（xunit1）で受け取って読む。

標準出力の要約は `-q`・`-r` の組み合わせで形が変わり、パラメータの組の id が区切りの綴りを含みうるので読まない。
pytest に `junit_args` を渡し、書かれたファイルを `read_cases` で読む。
"""

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Case:
    """1件のテストの結果。"""

    file: str
    """rootdir からのテストのファイルのパス（`/` で区切る）。"""
    name: str
    """node id のファイルより後ろ（`クラス::関数[組]`）。集められなかったファイルは空。"""
    outcome: str
    """passed（XPASS を含む）・failed（setup・teardown の失敗と strict の XPASS を含む）・skipped・xfailed。"""

    @property
    def nodeid(self) -> str:
        return f"{self.file}::{self.name}" if self.name else self.file


def junit_args(report: Path) -> list[str]:
    """pytest に report へ結果を書かせる引数。xunit1 だけがテストのファイルのパス（`file`）を書く。"""
    return [f"--junitxml={report}", "-o", "junit_family=xunit1"]


def _outcome(case: ET.Element) -> str:
    if case.find("failure") is not None or case.find("error") is not None:
        return "failed"
    skipped = case.find("skipped")
    if skipped is None:
        return "passed"
    return "xfailed" if skipped.get("type") == "pytest.xfail" else "skipped"


def read_cases(report: Path) -> list[Case]:
    """junit_args で書かせた結果を、テストごとに読む。"""
    cases = []
    for case in ET.parse(report).getroot().iter("testcase"):
        file = case.get("file", "").replace("\\", "/")
        classname = case.get("classname", "")
        if not classname:  # 集められなかったファイル（名前はドットでつないだモジュール名）
            cases.append(Case(file, "", _outcome(case)))
            continue
        # classname は node id のファイルとクラスをドットでつないだもの（入れ子のクラスもドットでつなぐ）
        module = file.removesuffix(".py").replace("/", ".")
        classes = classname[len(module) + 1:].split(".") if classname.startswith(module + ".") else []
        cases.append(Case(file, "::".join([*classes, case.get("name", "")]), _outcome(case)))
    return cases
