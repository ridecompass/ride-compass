"""`backend/scripts/mutation/_shared.py`の、変異の結果の判断と mutmut の名前の読み書きのテスト。

全部の測りの表（`report.py`）と Pull Request の知らせ（`report_pr.py`）は、どちらもこの判断で生き残りを数える。外れると、
基準でも落ちるテストしか落ちなかった変異を気づいたに数え、テストの穴を知らせない。

ここで見ないもの: 記録のファイルの置き場と並べ方（台本ごとの読み方）、mutmut 自身が付ける名前（測りの記録で見る）。
"""

import pytest

from scripts.mutation import _shared as shared

_FN = "app.domain.x.x_f"
_TBF = {_FN: ["tests/test_a.py::test_1", "tests/test_a.py::test_2", "tests/test_b.py::test_3"]}


@pytest.mark.parametrize(
    ("status", "failed", "baseline_failed", "rechecked", "expected"),
    [
        ("exit 2", set(), set(), "survived", ("Killed", "集める時点で落ちた")),
        ("killed", {"t1", "t2"}, {"t1"}, "survived", ("Killed", None)),
        ("killed", set(), set(), "survived", ("Killed", "落ちたテストの記録が無い")),
        ("killed", {"t1"}, {"t1"}, "survived", ("Survived", "落ちたのは、その関数の基準でも落ちるテストだけ")),
        ("killed", {"t1"}, {"t1"}, "killed", ("Killed", "テスト全体の当て直しで落ちた")),
        ("survived", set(), set(), "survived", ("Survived", None)),
        ("timeout", set(), set(), "survived", ("Timeout", None)),
        ("exit 5", set(), set(), "survived", ("RuntimeError", "exit 5")),
    ],
)
def test_judge(status, failed, baseline_failed, rechecked, expected):
    assert shared.judge({"status": status}, failed, baseline_failed, rechecked)[:2] == expected


def test_only_tests_that_did_not_fail_in_the_baseline_are_credited():
    assert shared.judge({"status": "killed"}, {"t1", "t2"}, {"t1"})[2] == {"t2"}


def test_baseline_failures_spread_file_records_and_include_a_function_with_only_one_finished_run():
    other = "app.domain.x.x_g"
    results = {name: {} for name in shared.baselines([_FN]) + shared.baselines([other])[:1]}
    kills = {shared.baselines([_FN])[1]: {"tests/test_a.py"}, shared.baselines([other])[0]: {"tests/test_c.py::t"}}

    assert shared.baseline_failures(results, kills, _TBF) == {
        _FN: {"tests/test_a.py::test_1", "tests/test_a.py::test_2"},
        other: {"tests/test_c.py::t"},
    }


@pytest.mark.parametrize(("module", "cls", "function"), [("app.domain.x", None, "f_g"), ("app.services.y", "Cls", "run")])
def test_a_mangled_name_reads_back_with_or_without_the_mutant_suffix(module, cls, function):
    name = shared.mangled_name(module, function, cls)

    assert shared.split_name(name) == shared.split_name(f"{name}__mutmut_12") == (module, cls, function)
