"""ベンチマークが「どのコードを測ったか」を残すことの検査（`benchmarks/revision.py`）。

ここで見ないもの: gitから状態を読む結線（`read_revision_state`）と、それを出す実行口
（`announce_revision`）は手元の作業コピーと配信元を読むので通さない。古いかの判じ方は
`scripts/checkout_freshness.py`が持ち、`scripts/tests/test_checkout_freshness.py`が見る。
どの実行口も素性を出すことは`tests/structure/test_benchmark_revision_announced.py`が見る。
"""

from benchmarks.revision import RevisionState, describe

SHA = "a" * 40


def test_describe_records_the_measured_commit_and_uncommitted_changes():
    text = describe(RevisionState(head=SHA, dirty=True))
    assert SHA[:12] in text
    assert "未コミット" in text


def test_describe_says_when_uncommitted_changes_could_not_be_read():
    """git が状態を返さなかった作業コピーを「未コミットの変更なし」と読ませない（数字を別の版のものと取り違える）。"""
    assert "確かめられない" in describe(RevisionState(head=SHA, dirty=None))
