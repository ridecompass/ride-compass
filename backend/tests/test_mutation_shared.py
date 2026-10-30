"""`backend/scripts/mutation/_shared.py`の、変異の結果の判断と mutmut の名前の読み書きのテスト。

全部の測りの表（`report.py`）は、この判断で生き残りを数える。外れると、
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


def _kills(directory, *records):
    """runner.py が kills/ に書く形（変異・テスト・落ちた段）の記録を置き、読み直す。"""
    (directory / "kills").mkdir()
    (directory / "kills" / "1.tsv").write_text("".join(f"{m}\t{t}\t{when}\n" for m, t, when in records), encoding="utf-8")
    return shared.read_kills(directory)


def test_baseline_failures_spread_file_records_and_include_a_function_with_only_one_finished_run(tmp_path):
    other = "app.domain.x.x_g"
    results = {name: {} for name in shared.baselines([_FN]) + shared.baselines([other])[:1]}
    kills = _kills(tmp_path, (shared.baselines([_FN])[1], "tests/test_a.py", "collect"),
                   (shared.baselines([other])[0], "tests/test_c.py::t", "call"))

    assert shared.baseline_failures(results, kills, _TBF) == {
        _FN: {"tests/test_a.py::test_1", "tests/test_a.py::test_2"},
        other: {"tests/test_c.py::t"},
    }


def test_a_class_that_failed_to_collect_is_spread_to_its_tests(tmp_path):
    """クラスの中のパラメータの組を変異が壊すと、集める時点の失敗はクラスの名前で記録される。テストの名前へ
    そろえないと、表のテストの一覧に無い名前が残り、表を書けない。"""
    tbf = {_FN: ["tests/test_a.py::TestX::test_1", "tests/test_a.py::test_2", "tests/test_b.py::test_3"]}
    kills = _kills(tmp_path, ("m", "tests/test_a.py::TestX", "collect"), ("m", "tests/test_b.py::test_3", "call"))

    assert shared.expand(kills["m"], _FN, tbf) == {"tests/test_a.py::TestX::test_1", "tests/test_b.py::test_3"}


@pytest.mark.parametrize(
    ("name", "expected"),
    [("app.domain.x.x_f_g", ("app.domain.x", None, "f_g")), ("app.services.y.xǁClsǁrun", ("app.services.y", "Cls", "run"))],
    ids=["モジュールの直下の関数", "クラスのメソッド"],
)
def test_a_mutmut_name_is_read_with_or_without_the_mutant_suffix(name, expected):
    """mutmut が付ける関数の名前（`app.x.x_f`・`app.x.xǁClsǁmethod`）を、変異の番号が付いても同じに読む。"""
    assert shared.split_name(name) == shared.split_name(f"{name}__mutmut_12") == expected


def _report(*mutants):
    """report.py の形の表。テストは1つのファイルの test_1（パラメータの組2つ）と test_2。"""
    tests = [{"id": "1", "name": "test_1[a]"}, {"id": "2", "name": "test_1[b]"}, {"id": "3", "name": "test_2"}]
    return {"testFiles": {"tests/test_a.py": {"tests": tests}},
            "files": {"app/x.py": {"mutants": [{"status": s, "killedBy": k} for s, k in mutants]}}}


@pytest.mark.parametrize(
    ("status", "killed_by", "expected"),
    [
        ("Killed", ["1", "2"], (0, 1)),
        ("Killed", ["1", "3"], (1, 1)),
        ("Killed", [], (1, 1)),
        ("Killed", ["1", "9"], (1, 1)),
        ("Timeout", [], (1, 1)),
        ("Survived", [], (0, 1)),
        ("NoCoverage", [], (0, 0)),
        ("Pending", [], (0, 0)),
    ],
    ids=["消すテストだけが見つける", "残すテストも見つける", "当て直しで落ちた", "一覧に無い名前も落とした", "時間切れ", "生き残り",
         "どのテストも通らない", "回し終えていない"],
)
def test_the_score_after_removing_tests_loses_only_mutants_that_no_kept_test_finds(status, killed_by, expected):
    """消したテストの抜けを、消したあとの検知率として見せる。数え損なうと、消して見つけられなくなった壊れ方を知らせない。"""
    assert shared.score(_report((status, killed_by)), {"tests/test_a.py::test_1"}) == expected
