"""`backend/scripts/deploy_gate.py`の判定テスト（本番・ネットワークには触れない）。

履歴は一時的なgitリポジトリで作り、振り分けの一覧は本物（`backend/Dockerfile`と`HOST_PATHS`・`NOT_DEPLOYED`）を当てる。
CIの置き場の判定（`.github/workflows/ci.yml`の`changes`）との照らしだけは、このリポジトリの追跡しているファイルを読む。

ここで見ないもの: 一覧の中身（どのファイルを外すか）は宣言なので書き写さない。外したファイルが本番で
読まれていないことは`tests/structure/test_deploy_exclusions.py`が見る。
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from scripts import deploy_gate as gate

REPO = Path(__file__).resolve().parents[2]
_BACKEND_AREA = re.compile(r"\bbackend=\$\(area '([^']+)'\)")


@pytest.mark.parametrize(
    ("relation", "hits", "expected"),
    [
        ("unknown", [], True),
        ("same", ["backend/app/main.py"], False),
        ("older", ["backend/app/main.py"], False),
        ("diverged", [], True),
        ("newer", [], False),
        ("newer", ["backend/app/main.py"], True),
        # ファイルを当てない呼び方（frontend）は、本番より新しければ出す。
        ("newer", None, True),
        ("older", None, False),
    ],
)
def test_decide(relation, hits, expected):
    assert gate.decide(relation, hits)[0] is expected


def _commit(repo: Path, *names: str) -> str:
    for name in names:
        (repo / name).parent.mkdir(parents=True, exist_ok=True)
        (repo / name).write_text(name, encoding="utf-8")
    subprocess.run(["git", "add", *names], cwd=repo, check=True)
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", names[0]],
        cwd=repo,
        check=True,
    )
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def test_relation_reads_ancestry(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    first = _commit(tmp_path, "a")
    second = _commit(tmp_path, "b")
    subprocess.run(["git", "checkout", "-q", "-b", "side", first], cwd=tmp_path, check=True)
    side = _commit(tmp_path, "c")
    monkeypatch.chdir(tmp_path)

    assert gate.commit_relation("", second) == "unknown"
    assert gate.commit_relation("0" * 40, second) == "unknown"
    assert gate.commit_relation(second, second) == "same"
    assert gate.commit_relation(second, first) == "older"
    assert gate.commit_relation(first, second) == "newer"
    assert gate.commit_relation(second, side) == "diverged"


def test_only_changes_that_reach_production_deploy(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / "backend").mkdir()
    # イメージの中身は本物の組み立て方から導かせる。
    shutil.copy(Path(__file__).resolve().parents[1] / "Dockerfile", tmp_path / "backend" / "Dockerfile")
    subprocess.run(["git", "add", "backend/Dockerfile"], cwd=tmp_path, check=True)
    deployed = _commit(tmp_path, "README.md")
    # 外したもの（`**`は下の階層を跨ぐ）と対象の外（根から当てるので、下の階層にある同じ名前のディレクトリも外）だけが変わった。
    unchanged_image = _commit(tmp_path, "backend/benchmarks/deep/bench.py", "frontend/backend/app.py")
    # Dockerfileが写さない、どの一覧にも名前の無い新しいファイル。
    unchanged_outside = _commit(tmp_path, "backend/notes/new_tool.toml")
    changed_image = _commit(tmp_path, "backend/app/main.py")
    # イメージに入らないが、デプロイが揃える作業コピーからVMのsystemdが読むもの。
    changed_host = _commit(tmp_path, "backend/ops/unit.service")
    changed_origins = _commit(tmp_path, "production-origins.json")
    output = tmp_path / "github_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.chdir(tmp_path / "backend")  # 当てる先は作業ディレクトリによらずリポジトリの根から

    assert gate.main(["gate", deployed, unchanged_image]) == 0
    assert gate.main(["gate", unchanged_image, unchanged_outside]) == 0
    assert gate.main(["gate", deployed, changed_image]) == 0
    assert gate.main(["gate", changed_image, changed_host]) == 0
    assert gate.main(["gate", changed_host, changed_origins]) == 0
    assert output.read_text(encoding="utf-8").splitlines() == [
        "deploy=false", "deploy=false", "deploy=true", "deploy=true", "deploy=true"
    ]


def test_files_ci_counts_as_backend_reach_the_gate():
    """`ci.yml`の`changes`がbackendの変更に数えて`deploy-backend`を呼ぶのに、判定が届くと数えないファイルがあると、
    そのファイルだけを変えた変更は出ない（frontendの宛先なら、CORSの許可が古いまま残り、画面がAPIを読めない）。

    `backend/`の下は判定が像から決めるので、置き場の判定がそれより広く数えてよい。比べるのは、その外のファイルだけ。
    """
    area = re.compile(_BACKEND_AREA.search((REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")).group(1))
    tracked = gate.run("ls-files", cwd=REPO, check=True).stdout.splitlines()
    dockerfile = (REPO / gate.DOCKERFILE).read_text(encoding="utf-8")
    reached = gate.run("ls-files", "--", *gate.pathspec(gate.deploy_paths(dockerfile), ()), cwd=REPO, check=True)

    outside = {path for path in tracked if area.search(path) and not path.startswith("backend/")}
    assert outside <= set(reached.stdout.splitlines())


def test_any_change_deploys_without_matching_paths(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    deployed = _commit(tmp_path, "README.md")
    target = _commit(tmp_path, "frontend/src/app/page.tsx")
    output = tmp_path / "github_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.chdir(tmp_path)

    assert gate.main(["gate", "--any-change", deployed, target]) == 0
    assert gate.main(["gate", "--any-change", target, deployed]) == 0
    assert output.read_text(encoding="utf-8").splitlines() == ["deploy=true", "deploy=false"]
