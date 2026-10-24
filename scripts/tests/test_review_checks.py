"""`scripts/review_checks.py`の差分の報告（`change`）と総量（`metrics`）と流れの摩擦と保守の候補の拾い方（`friction`）と番の一覧の組み方（`turns`）と、文書の整合（`docs`）の実在の母集団のテスト。

履歴は一時的なgitリポジトリで作る。

ここで見ないもの: `docs`の検知そのものはCI（`ci.yml`の`docs-consistency`）が本物のリポジトリへ毎回流す。ここでは、まだ`git add`していない
ファイルを実在に数えることだけを通す（名指しの検査と食い違うと、同じファイルを片方だけが無いと言う）。`trigger`の中身と、`size`の表・発火は
周期レビューで人が読む出力で、ここでは通さない。`trigger`が発火したときだけ出す形は、誰も読まないセッションの始まりの
フックが使うので通す。`size`の「閾値の見直し」と、種類ごとの上限に当たるファイルへ置いた
ファイルごとの閾値を無視することは、緩んだ閾値に誰も気づかなくなるので通す。`friction`・`turns`の gh で置き場を読む部分は
本物の置き場でしか通らないので、ここではコメントから行を拾う判断と、前のコメントを読みに行くかの判断と、読んだ issue から一覧の行を組む判断だけを通す。
"""

import argparse
import sys
from pathlib import Path

import pytest
from git_repo import git
from script_module import load_script

rc = load_script("review_checks")


def _commit(repo: Path, files: dict[str, str | None]) -> str:
    for name, text in files.items():
        path = repo / name
        if text is None:
            git(repo, "rm", "-q", name)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        git(repo, "add", name)
    git(repo, "commit", "-q", "-m", "c")
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path, monkeypatch):
    git(tmp_path, "init", "-q", "-b", "master")
    monkeypatch.setattr(rc, "REPO_ROOT", tmp_path)
    return tmp_path


def _run(monkeypatch, capsys, *argv: str) -> str:
    monkeypatch.setattr(sys, "argv", ["review_checks.py", *argv])
    assert rc.main() == 0
    return capsys.readouterr().out


def test_change_splits_lines_by_kind_and_labels_the_size(repo, monkeypatch, capsys):
    base = _commit(repo, {"app/old.py": "a\nb\nc\n", "README.md": "x\n"})
    _commit(
        repo,
        {
            "app/old.py": "a\n",
            "app/moved_from.py": "m\n" * 10,
            "backend/tests/test_x.py": "t\n" * 4,
            "docs/a.md": "d\n" * 3,
            ".github/workflows/ci.yml": "w\n" * 5,
            "backend/app/batch/source_profile.yaml": "y\n" * 3,
            "frontend/src/types/generated/api.d.ts": "g\n" * 7,
            "frontend/package-lock.json": "{}\n",
        },
    )
    head = _commit(repo, {"app/moved_from.py": None, "app/moved_to.py": "m\n" * 10 + "n\n"})

    out = _run(monkeypatch, capsys, "change", "--base", base, "--head", head)

    # 移したファイルは移す前と後の差だけを数える（+1）。ワークフローは総量と同じく実装、コードでないファイルは設定。
    assert "増減: 実装 +16/−2・テスト +4/−0・文書 +3/−0・設定 +3/−0・生成物 +8/−0" in out
    assert "規模: S（実装＋テスト 22行。" in out


@pytest.mark.parametrize(("lines", "label"), [(200, "S"), (201, "M"), (1000, "M"), (1001, "L")])
def test_change_counts_the_working_tree_with_untracked_files(repo, monkeypatch, capsys, lines, label):
    base = _commit(repo, {"README.md": "x\n"})
    git(repo, "checkout", "-q", "-b", "work")
    (repo / "経路.py").write_text("a\n" * lines, encoding="utf-8")  # git が既定で引用符と8進で包む名前でも数える

    out = _run(monkeypatch, capsys, "change", "--base", base)

    assert f"増減: 実装 +{lines:,}/−0・テスト +0/−0・文書 +0/−0" in out
    assert f"規模: {label}（" in out


def test_metrics_counts_everything_outside_the_product_places_as_tooling(repo, capsys):
    _commit(repo, {"backend/app/経路.py": "a\n", "frontend/src/b.ts": "b\n"})  # git が既定で引用符と8進で包む名前でも数える
    git(repo, "tag", "-a", "periodic-review/001", "-m", "r")
    (repo / "stop-dev.bat").write_bytes("rem 止める\r\n".encode("cp932") * 2)
    git(repo, "add", "stop-dev.bat")
    _commit(
        repo,
        {
            "tools/flow-gate/src/gate.js": "g\n" * 3,
            "tools/flow-gate/test/fake-github.js": "f\n" * 4,
            ".github/workflows/claude-task.yml": "c\n" * 5,
            ".github/workflows/ci.yml": "w\n" * 6,
            ".github/dependabot.yml": "d\n" * 7,
            "frontend/scripts/capture.mjs": "s\n" * 8,
            "frontend/src/testing/maplibre.ts": "m\n" * 9,
        },
    )

    assert rc.cmd_metrics(argparse.Namespace()) == 0
    out = capsys.readouterr().out

    assert "| 実装 | 26 | 2 | +24 |" in out
    assert "| うち製品 | 2 | 2 | +0 |" in out
    assert "| うちタスク管理 | 8 | 0 | +8 |" in out
    assert "| うち道具 | 16 | 0 | +16 |" in out
    assert "| テスト | 13 | 0 | +13 |" in out


def test_docs_reads_and_counts_as_existing_the_files_not_yet_added(repo, monkeypatch, capsys):
    _commit(repo, {"README.md": "[新しい文書](docs/new.md)\n"})
    (repo / "docs").mkdir()
    (repo / "docs" / "new.md").write_text("[消えた文書](gone.md)\n", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["review_checks.py", "docs"])

    assert rc.main() == 1
    out = capsys.readouterr().out

    assert "docs/new.md:1: gone.md が存在しない" in out
    assert "README.md" not in out


_DECLARED_PREFIXES = sorted(
    {prefix for name, value in vars(rc).items() if name.endswith("_PREFIXES") for prefix in value}
)


@pytest.mark.parametrize("prefix", _DECLARED_PREFIXES)
def test_each_declared_place_holds_a_tracked_file(prefix):
    """置き場を改名・撤去すると、その置き場で分けていたファイルが黙って別の種別へ落ちる。"""
    assert any(f.startswith(prefix) for f in rc.tracked_files()), f"{prefix} に当たる追跡ファイルが無い"


def test_size_lists_thresholds_looser_than_the_growth_from_the_current_lines(repo, monkeypatch, capsys):
    # 縮んだファイルの閾値が、今の行数から増える側の発火（+15%）で付け直す値より緩ければ見直しに出す。
    _commit(repo, {"app/shrunk.py": "a\n" * 400, "app/kept.py": "b\n" * 400})
    thresholds = repo / "size_thresholds.json"
    thresholds.write_text('{"thresholds": {"app/shrunk.py": 800, "app/kept.py": 500}}', encoding="utf-8")
    monkeypatch.setattr(rc, "SIZE_THRESHOLDS", thresholds)

    assert rc.cmd_size(argparse.Namespace(top=5)) == 0
    out = capsys.readouterr().out

    assert "閾値の見直し（今の行数+15%を100行に切り上げた値より緩い・削除済み） 1件: app/shrunk.py（800→500）" in out


def test_size_holds_instruction_docs_to_the_kind_limit_and_ignores_per_file_thresholds(repo, monkeypatch, capsys):
    # 指示の文書は種類ごとの上限だけで発火し、ファイルごとに置いた緩い閾値は効かずに名指しされる。
    _commit(repo, {".claude/rules/long.md": "a\n" * 250, ".claude/commands/review.md": "b\n" * 300})
    thresholds = repo / "size_thresholds.json"
    thresholds.write_text('{"instruction_limits": {".claude/rules/*.md": 200, ".claude/commands/*.md": 500},'
                          ' "thresholds": {".claude/rules/long.md": 400}}', encoding="utf-8")
    monkeypatch.setattr(rc, "SIZE_THRESHOLDS", thresholds)

    assert rc.cmd_size(argparse.Namespace(top=5)) == 0
    out = capsys.readouterr().out

    assert "| .claude/rules/long.md | 250 | - | 新規 | 200 | 125% | 閾値200超過 |" in out
    assert "| .claude/commands/review.md | 300 | - | 新規 | 500 | 60% |  |" in out
    assert "種類ごとの上限に当たるファイルごとの閾値（無視した。上限は instruction_limits・code_limits だけ） 1件: .claude/rules/long.md" in out
    assert "閾値の見直し（今の行数+15%を100行に切り上げた値より緩い・削除済み） 0件" in out


def test_size_holds_code_to_the_kind_limit_beyond_the_external_maximum(repo, monkeypatch, capsys):
    # コードは外の道具と同じく最大の行数を超えたら発火し、ファイルごとに置いた緩い閾値は効かずに名指しされる。
    # 生成物は書き手が分けられないので、種類の上限に当てずファイルごとの閾値で見る。
    _commit(repo, {"app/at.ts": "a\n" * 300, "app/over.ts": "b\n" * 301,
                   "frontend/src/types/generated/api.d.ts": "g\n" * 400})
    thresholds = repo / "size_thresholds.json"
    thresholds.write_text('{"code_limits": {"*.ts": 300},'
                          ' "thresholds": {"app/over.ts": 400, "frontend/src/types/generated/api.d.ts": 500}}',
                          encoding="utf-8")
    monkeypatch.setattr(rc, "SIZE_THRESHOLDS", thresholds)

    assert rc.cmd_size(argparse.Namespace(top=5)) == 0
    out = capsys.readouterr().out

    assert "| app/at.ts | 300 | - | 新規 | 300 | 100% |  |" in out
    assert "| app/over.ts | 301 | - | 新規 | 300 | 100% | 閾値300超過 |" in out
    assert "| frontend/src/types/generated/api.d.ts | 400 | - | 新規 | 500 | 80% |  |" in out
    assert "種類ごとの上限に当たるファイルごとの閾値（無視した。上限は instruction_limits・code_limits だけ） 1件: app/over.ts" in out


def test_code_churn_stops_when_the_change_since_the_review_cannot_be_measured(repo):
    # 測れない差分（タグの版が手元の履歴に無い等）を0行と読むと、周期レビューの変更行数の発火を黙って逃す。
    _commit(repo, {"backend/a.py": "a\n"})

    with pytest.raises(RuntimeError):
        rc.code_churn("0" * 40)


@pytest.mark.parametrize("changed_lines, fired", [(rc.TRIGGER_IMPL_LINES - 1, False), (rc.TRIGGER_IMPL_LINES, True)])
def test_trigger_for_the_session_start_says_nothing_until_it_fires(repo, capsys, changed_lines, fired):
    # セッションの始まりのフックは発火したときだけ文脈へ出す。発火を出し損ねると、周期レビューに誰も気づかない。
    _commit(repo, {"backend/a.py": "a\n"})
    git(repo, "tag", f"{rc.REVIEW_TAG_PREFIX}001")
    _commit(repo, {"backend/a.py": "a\n" + "b\n" * changed_lines})

    assert rc.cmd_trigger(argparse.Namespace(only_fired=True)) == 0
    out = capsys.readouterr().out

    assert ("判定: **該当（変更行数）**" in out) if fired else out == ""


def test_friction_picks_the_friction_and_maintenance_lines_written_after_the_review_including_quoted_and_listed_ones():
    since = rc.dt.datetime(2026, 10, 7, 3, 39, 2, tzinfo=rc.dt.timezone.utc)
    comments = [
        {"createdAt": "2026-10-07T03:39:01Z", "body": "流れの摩擦: 前のレビューより前"},
        {"createdAt": "2026-10-07T03:39:02Z", "body": (
            "流れの摩擦: 地の文\n"
            "> 流れの摩擦: 引用\n"
            "> - 流れの摩擦: 引用の箇条書き\n"
            "- 流れの摩擦: 箇条書き\n"
            "保守の候補: 地の文\n"
            "> - 保守の候補: 引用の箇条書き\n"
            "本文の中の 流れの摩擦: は拾わない\n"
            "  - 流れの摩擦: 字下げは拾わない"
        )},
    ]
    assert rc.reported_lines(805, comments, since) == [
        "#805 流れの摩擦: 地の文",
        "#805 > 流れの摩擦: 引用",
        "#805 > - 流れの摩擦: 引用の箇条書き",
        "#805 - 流れの摩擦: 箇条書き",
        "#805 保守の候補: 地の文",
        "#805 > - 保守の候補: 引用の箇条書き",
    ]


def _page(stamps: list[str], cursor: str | None) -> dict:
    return {"pageInfo": {"hasPreviousPage": cursor is not None, "startCursor": cursor},
            "nodes": [{"createdAt": s, "body": s} for s in stamps]}


@pytest.mark.parametrize(
    ("first", "earlier", "want", "reads"),
    [
        # 前のページが無い。
        (_page(["2026-10-08T00:00:00Z"], None), {}, ["2026-10-08T00:00:00Z"], 0),
        # 前のページはあるが、読んだ中で一番古いものがレビューより前なので、前は読まない。
        (_page(["2026-10-06T00:00:00Z", "2026-10-08T00:00:00Z"], "c1"), {}, ["2026-10-06T00:00:00Z", "2026-10-08T00:00:00Z"], 0),
        # 一番古いものがレビューより後なので、前へ送り、古いページがレビューより前に届いたら止まる。
        (
            _page(["2026-10-08T00:00:00Z"], "c1"),
            {"c1": _page(["2026-10-07T12:00:00Z"], "c2"), "c2": _page(["2026-10-01T00:00:00Z"], "c3")},
            ["2026-10-01T00:00:00Z", "2026-10-07T12:00:00Z", "2026-10-08T00:00:00Z"],
            2,
        ),
    ],
)
def test_friction_reads_earlier_comments_only_while_they_can_be_after_the_review(first, earlier, want, reads):
    """前のコメントを読む1回ずつが置き場への要求になる（GitHub の要求の上限に効く）ので、要るときだけ読む。"""
    since = rc.dt.datetime(2026, 10, 7, tzinfo=rc.dt.timezone.utc)
    asked = []

    def read_earlier(cursor):
        asked.append(cursor)
        return earlier[cursor]

    assert [c["createdAt"] for c in rc.comments_since(first, since, read_earlier)] == want
    assert len(asked) == reads


def _issue(number: int, status: str, kind: str, labels: tuple[str, ...] = (), last: tuple[str, str] | None = None) -> dict:
    """検索（`TURNS_SEARCH`）が返す issue の形。last は最後のコメントの（書いた名義, 本文）。"""
    field = rc.FLOW_CONFIG["fields"]["status"]["name"]
    return {"number": number, "title": f"題{number}", "issueType": {"name": kind}, "labels": {"nodes": [{"name": n} for n in labels]},
            "issueFieldValues": {"nodes": [{"name": status, "field": {"name": field}}, {}]},
            "comments": {"nodes": [{"author": {"login": last[0]}, "body": last[1]}] if last else []}}


def test_turns_groups_the_users_turn_by_status_and_type_and_shows_questions_and_the_gates_last_notice():
    """開発機のセッションの始まりに、聞かなくても誰の番で何を待っているかが分かる一覧。答えるもの（回答・保留）と開発機で進める対話作業が
    混ざると、止まった対話作業が判断の問いの中に埋もれる。"""
    gate = rc.FLOW_CONFIG["gateBot"].removesuffix("[bot]")
    dialog = rc.FLOW_CONFIG["dialogType"]
    lines = rc.turn_lines(
        [_issue(12, "回答", "要望", ("問い: 確かめ",), (gate, "## 問い（確かめ）\n本文")),
         _issue(3, "実装", dialog, last=(gate, "本文の「やること」の 1 が行き先を名指していないので、完成で閉じず\n続き")),
         _issue(5, "実装", dialog, last=(rc.FLOW_CONFIG["claude"], "計測した")),
         _issue(4, "回答", "要望", ("問い: 判断",))],
        [_issue(9, "実装", "不具合")])
    assert lines == [
        f"ユーザーの番（担当者 {rc.FLOW_CONFIG['user']}）: 4件",
        "  回答・要望",
        "    #4 題4 [問い: 判断]",
        "    #12 題12 [問い: 確かめ]",
        f"  実装・{dialog}",
        "    #3 題3 — 本文の「やること」の 1 が行き先を名指していないので、完成で閉じず",
        "    #5 題5",
        f"開発機が持っている（ラベル「{rc.FLOW_CONFIG['devLabel']}」）: 1件",
        "    #9 題9",
    ]
    assert rc.turn_lines([], []) == [], "誰の番の issue も無ければ、セッションの始まりに何も出さない"
