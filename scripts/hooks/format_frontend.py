"""Edit・Write で書いた frontend のファイルへ prettier をかけるフック（CI の`format:check`が落とす形を残さない）。

.claude/settings.json の PostToolUse から打つ（標準入力でフックの JSON を受け取る。書いたファイルは`tool_input.file_path`。
公式「Hooks reference」）。対象は`format:check`（`frontend/package.json`）が見る範囲で（`SOURCE_DIR`・`SUFFIXES`。
食い違えば`scripts/tests/test_format_frontend_hook.py`が落ちる）、書いたファイルのある作業ツリーの frontend で打つ（その`.prettierrc.json`・`.prettierignore`が効く）。その frontend に
依存が入っていなければ（`npm ci`の前の作業ツリー）何もしない。
"""

import json
import subprocess
import sys
from pathlib import Path

SOURCE_DIR = "src"
SUFFIXES = (".ts", ".tsx", ".css")


def frontend_of(path: Path) -> Path | None:
    """`<frontend>/src/`の下の対象のファイルなら、その frontend。"""
    if path.suffix not in SUFFIXES:
        return None
    for parent in path.parents:
        if parent.name == SOURCE_DIR and parent.parent.name == "frontend":
            return parent.parent
    return None


def main() -> int:
    file_path = json.load(sys.stdin).get("tool_input", {}).get("file_path")
    if not file_path:
        return 0
    path = Path(file_path).resolve()
    frontend = frontend_of(path)
    if frontend is None:
        return 0
    prettier = frontend / "node_modules" / "prettier" / "bin" / "prettier.cjs"
    if not prettier.exists():
        return 0
    # 打てない（構文の誤り等）ときは利用者の画面にだけ出し、作業は止めない。CI の format:check と型検査が同じものを落とす。
    result = subprocess.run(
        ["node", str(prettier), "--write", "--log-level", "warn", path.relative_to(frontend).as_posix()],
        cwd=frontend, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
    )
    if result.returncode != 0:
        print(result.stderr.strip() or result.stdout.strip(), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.path.append(str(Path(__file__).resolve().parents[2] / "backend" / "scripts"))
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    sys.exit(main())
