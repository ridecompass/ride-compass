"""本番へ出すかを決める（`.github/workflows/deploy-backend.yml`と`.github/workflows/deploy-frontend.yml`が呼ぶ）。

    python backend/scripts/deploy_gate.py [--any-change] <本番で動いているコミット> <出したいコミット>

本番がこのコミットかこれより新しいコミットで動いていれば出さない。本番より新しいなら、本番で動いている
コミットから出したいコミットまでの変更に、本番へ届くファイル（`deploy_paths`。イメージの中身は`DOCKERFILE`から
導く）のうち`NOT_DEPLOYED`に当たらないものが1つでもあれば出す（backend）。当てるのはgitのpathspec（`git diff --name-only`）。`--any-change`は
ファイルを当てずに出す（frontend。届く変更があるかは、呼ぶ前に`ci.yml`の`changes`が決めている）。
判定と理由を1行で出し、GitHub Actionsの中では`$GITHUB_OUTPUT`へ`deploy=true|false`を書く。

**差分の起点を「直前のpush」ではなく「本番で動いているコミット」に取る。** CIが赤で出せなかった
変更は、次にCIを通ったコミットの差分へそのまま含まれる（直前のpushとの差分では、テストだけを
直したコミットが本番へのコードの変更を運ばず、その変更が次の変更まで出なくなる）。
本番で動いているコミットが分からない・履歴に無いときは出す（出し漏れより出し直しの方が安い）。
"""

from __future__ import annotations

import os
import posixpath
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from repo_git import run

#: 本番のイメージの組み立て方。これ自身と、これがCOPYで組み立ての文脈（このファイルのディレクトリ）から写すものが
#: イメージに届く。
DOCKERFILE = "backend/Dockerfile"

#: イメージの外から本番へ届くもの。書き方は`NOT_DEPLOYED`と同じgitのpathspecのglobで、リポジトリの根から当てる
#: （`*`は`/`を跨がず、`**`は跨ぐ）。
HOST_PATHS = (
    # イメージに入らないが、デプロイがVMの作業コピーを揃えて`systemctl daemon-reload`で届ける。
    "backend/ops/**",
    # デプロイの手順そのもの。
    ".github/workflows/deploy-backend.yml",
)

#: イメージに届いても、本番へ出す理由にならないもの。
NOT_DEPLOYED = (
    # 本番プロセスが読まないもの。生成スクリプトとそれだけが読む表示値で、
    # 変更は生成物（frontend/src/types/generated/）を経由してだけ画面へ届く。
    # **backend/app配下はbackend/tests/structure/test_deploy_exclusions.pyが、本番側から
    # importされていないことを検査する**——importされた時点で、ここに挙げたままでは
    # 変更が本番へ届かなくなる。
    "backend/scripts/export_openapi.py",
    "backend/scripts/cross_language_expectations.py",
    "backend/scripts/schema_shape.py",
    # 本番でルートを作る確かめ。デプロイのあとと定時に、ランナーから本番を外から叩く（像の中では動かさない）。
    "backend/scripts/prod_route_check.py",
    # 本番の点のタイルの確かめ。デプロイのあとと定時に、ランナーから本番を外から叩く（像の中では動かさない）。
    "backend/scripts/prod_point_tile_check.py",
    # 本番のDBのバックアップの止まりの見張り。定時に、ランナーから本番の`/health`を読む（像の中では動かさない）。
    "backend/scripts/prod_backup_check.py",
    "backend/app/domain/warning_display.py",
)


def image_sources(dockerfile: str) -> list[str]:
    """`dockerfile`のCOPYが組み立ての文脈から写す元（文脈からの相対）。"""
    sources = []
    for line in dockerfile.splitlines():
        parts = line.split()
        if parts[:1] == ["COPY"]:
            sources += parts[1:-1]
    return sources


def deploy_paths(dockerfile: str) -> tuple[str, ...]:
    """本番へ届くファイルを指すglob。イメージの中身は`dockerfile`のCOPYから導く（写す元がファイルでもディレクトリでも当たる）。"""
    context = posixpath.dirname(DOCKERFILE)
    image = [posixpath.normpath(f"{context}/{src}") for src in image_sources(dockerfile)]
    return (DOCKERFILE, *(p for path in image for p in (path, f"{path}/**")), *HOST_PATHS)


def pathspec(include: tuple[str, ...], exclude: tuple[str, ...]) -> list[str]:
    """`include`のどれかに当たり`exclude`のどれにも当たらないファイルを指すpathspec。"""
    return [f":(top,glob){p}" for p in include] + [f":(top,glob,exclude){p}" for p in exclude]


def decide(relation: str, hits: list[str] | None) -> tuple[bool, str]:
    """`relation`は本番で動いているコミット（deployed）と出したいコミット（target）の関係。

    unknown: deployedが分からない／履歴に無い、same: 同じ、older: targetがdeployedの祖先、
    newer: deployedがtargetの祖先、diverged: どちらも祖先でない。`hits`はnewerのときの、
    その間に変わった本番のイメージに届くファイルで、Noneはファイルを当てないこと。
    """
    if relation == "unknown":
        return True, "本番で動いているコミットが分からないため出す"
    if relation == "same":
        return False, "本番は既にこのコミットで動いている"
    if relation == "older":
        return False, "本番はこれより新しいコミットで動いている（後から終わった古いCIの実行）"
    if relation == "diverged":
        return True, "本番のコミットと履歴が分かれているため出す"
    if hits is None:
        return True, "本番はこれより古いコミットで動いている"
    if not hits:
        return False, "本番のイメージに届く変更が無い"
    return True, f"本番のイメージに届く変更が{len(hits)}件ある（例: {hits[0]}）"


def commit_relation(deployed: str, target: str) -> str:
    if not deployed or run("cat-file", "-e", f"{deployed}^{{commit}}").returncode != 0:
        return "unknown"
    if run("rev-parse", deployed).stdout.strip() == run("rev-parse", target).stdout.strip():
        return "same"
    if run("merge-base", "--is-ancestor", target, deployed).returncode == 0:
        return "older"
    if run("merge-base", "--is-ancestor", deployed, target).returncode == 0:
        return "newer"
    return "diverged"


def main(argv: list[str]) -> int:
    any_change = argv[1] == "--any-change"
    deployed, target = (arg.strip() for arg in argv[1 + any_change :])
    relation = commit_relation(deployed, target)
    hits: list[str] | None = None if any_change else []
    if relation == "newer" and not any_change:
        # 組み立て方は出したいコミットのものを読む（COPYを外した変更は、Dockerfileの変更として当たる）。
        dockerfile = run("show", f"{target}:{DOCKERFILE}")
        if dockerfile.returncode != 0:
            print(dockerfile.stderr, file=sys.stderr)
            return 1
        diff = run("diff", "--name-only", deployed, target, "--", *pathspec(deploy_paths(dockerfile.stdout), NOT_DEPLOYED))
        if diff.returncode != 0:
            print(diff.stderr, file=sys.stderr)
            return 1
        hits = [line for line in diff.stdout.splitlines() if line]
    deploy, reason = decide(relation, hits)
    print(f"{'出す' if deploy else '出さない'}: {reason}（本番 {deployed[:8] or '不明'} → {target[:8]}）")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as f:
            f.write(f"deploy={'true' if deploy else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
