"""`scripts/pytest_report.py`のテスト。本物の pytest に一時のテストを回させ、書かれた結果を読む。

結果を読んで何を出すか（落ちたテストの並べ方・実行したテストの数え方）は、読む道具のテスト（`test_break_tests.py`）が持つ。
"""

import subprocess
import sys

from script_module import load_script

pr = load_script("pytest_report")

_TESTS = '''import pytest


def test_pass():
    pass


@pytest.mark.parametrize("x", ["a.b", "c - d"])
def test_param(x):
    pass


class TestOuter:
    class TestInner:
        def test_nested(self):
            pass


@pytest.mark.skip
def test_skip():
    pass


@pytest.mark.xfail
def test_xfail():
    assert False


@pytest.mark.xfail
def test_xpass():
    pass


@pytest.mark.xfail(strict=True)
def test_strict_xpass():
    pass


@pytest.fixture
def broken():
    raise RuntimeError


def test_setup_error(broken):
    pass
'''


def _run(tmp_path, files):
    for name, text in files.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(text, encoding="utf-8")
    report = tmp_path / "report.xml"
    subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests", *pr.junit_args(report)],
                   cwd=tmp_path, capture_output=True, check=False)
    return {case.nodeid: case.outcome for case in pr.read_cases(report)}


def test_cases_carry_the_pytest_node_id_and_outcome(tmp_path):
    f = "tests/test_s.py"

    assert _run(tmp_path, {f: _TESTS}) == {
        f"{f}::test_pass": "passed",
        f"{f}::test_param[a.b]": "passed",
        f"{f}::test_param[c - d]": "passed",
        f"{f}::TestOuter::TestInner::test_nested": "passed",
        f"{f}::test_skip": "skipped",
        f"{f}::test_xfail": "xfailed",
        f"{f}::test_xpass": "passed",
        f"{f}::test_strict_xpass": "failed",
        f"{f}::test_setup_error": "failed",
    }


def test_a_file_that_cannot_be_collected_is_a_failed_case_without_a_name(tmp_path):
    assert _run(tmp_path, {"tests/test_broken.py": "import missing_module\n"}) == {"tests/test_broken.py": "failed"}
