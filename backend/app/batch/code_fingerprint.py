"""処理のコードの指紋。**あるモジュールから`import`でたどれる`app`の中のモジュールの中身**から作る。

入力が前回と同じなら処理をしない仕組み（取込: `ingest.py`・派生の段: `derive_cli.py`）は、コードも入力に数える。コードを入れないと、
読み方を直したあとも前回の結果が残る。

たどるのはソースの文（AST）で、関数の中の`import`も数える（重いライブラリを使うときだけ読むモジュールが、
関数の中で読み込む）。`from <パッケージ> import <名前>`は、名前がモジュールならそのモジュールも数える。
パッケージを読むと`__init__.py`が走るので、たどったモジュールの親のパッケージも数える。`app`の外
（標準ライブラリ・依存のライブラリ）はたどらない——たどったモジュールが読み込むライブラリは、版を別に数える
（`library_versions`）。
"""

import ast
import functools
import hashlib
import importlib.metadata
from collections.abc import Iterable
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

#: `app`のパッケージを置いた場所（`backend/`）。モジュールの名前はここから読むファイルへ移す。
ROOT = Path(__file__).resolve().parents[2]

_PACKAGE = "app"


def _module_file(name: str) -> Path | None:
    """モジュールの名前が指すファイル。モジュールでなければ（クラス・関数の名前）None。"""
    base = ROOT.joinpath(*name.split("."))
    for path in (base / "__init__.py", base.with_suffix(".py")):
        if path.is_file():
            return path
    return None


def _in_app(name: str) -> bool:
    return name == _PACKAGE or name.startswith(f"{_PACKAGE}.")


def _imported(name: str, path: Path) -> frozenset[str]:
    """`path`（モジュール`name`）が読み込むモジュールの絶対の名前（モジュールでない名前も混ざる）。"""
    package = name if path.name == "__init__.py" else name.rpartition(".")[0]
    return _imported_by_source(package, path.read_bytes())


# 読み解きは中身で決まるので、同じ中身は1プロセスで1度だけ読み解く。取込・派生の段は1回ごとに全部のモジュールを
# たどり直し、読み解きが指紋の時間の大半を占める。
@functools.cache
def _imported_by_source(package: str, source: bytes) -> frozenset[str]:
    found: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                parts = package.split(".")
                base = ".".join(parts[:len(parts) - node.level + 1])
                module = f"{base}.{node.module}" if node.module else base
            else:
                module = node.module or ""
            found.add(module)
            found.update(f"{module}.{alias.name}" for alias in node.names)
    return frozenset(found)


def _with_parents(name: str) -> list[str]:
    parts = name.split(".")
    return [".".join(parts[:i]) for i in range(1, len(parts) + 1)]


def reachable_modules(module: str) -> dict[str, Path]:
    """`module`から`import`でたどれる`app`の中のモジュール（`module`と親のパッケージを含む）の名前 → ファイル。"""
    seen: dict[str, Path] = {}
    pending = _with_parents(module)
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        path = _module_file(name)
        if path is None:
            continue
        seen[name] = path
        for imported in _imported(name, path):
            if _in_app(imported):
                pending.extend(_with_parents(imported))
    return seen


def code_fingerprint(module: str) -> str:
    """`module`からたどれるモジュールの名前と中身のSHA-256。どれか1つの中身が変わると変わる。"""
    digest = hashlib.sha256()
    for name, path in sorted(reachable_modules(module).items()):
        digest.update(name.encode())
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def library_versions(module: str) -> tuple[str, ...]:
    """`module`からたどれるモジュールが読み込むライブラリと、それらが依存するライブラリの名前と版（`<名前>==<版>`）。

    読み込むライブラリは、たどったモジュールの`import`の先頭の名前を、入っている配布物へ移して決める。読み込まない
    ライブラリ（`app`のほかの所だけが使うもの）の版が変わっても、指紋は変わらない。
    """
    names = {imported.partition(".")[0] for name, path in reachable_modules(module).items()
             for imported in _imported(name, path) if not _in_app(imported)}
    return _distribution_versions({dist for name in names for dist in _packages().get(name, ())})


# 入っている配布物はプロセスの間に替わらないので、全部の配布物のファイルの一覧を読むのは1プロセスで1度だけにする。
@functools.cache
def _packages() -> dict[str, list[str]]:
    """`import`の先頭の名前 → それを入れた配布物の名前。"""
    return dict(importlib.metadata.packages_distributions())


def _distribution_versions(roots: Iterable[str]) -> tuple[str, ...]:
    """配布物`roots`と、その依存を入っている分だけたどった配布物の名前と版。

    依存の宣言は、追加の機能（extra）の名前の条件付きで書かれる。`roots`はどの追加の機能を入れたかが`import`から
    分からず（`sqlalchemy`の非同期の口は追加の機能`asyncio`の依存`greenlet`を読む）、宣言の全部の追加の機能の依存を
    数える。その先は、依存の宣言が求めた追加の機能だけを数える——入っていない配布物は数えないので、多く数えるのは
    入っている分だけで、多く数えても段が余計に流れるだけで済む。
    """
    root_keys = {canonicalize_name(name) for name in roots}
    found: dict[str, str] = {}
    # 配布物 → 依存を数えた追加の機能。後から別の追加の機能を求められたら、その分の依存も数える。
    counted: dict[str, frozenset[str]] = {}
    pending: list[tuple[str, frozenset[str]]] = [(name, frozenset()) for name in root_keys]
    while pending:
        name, extras = pending.pop()
        key = canonicalize_name(name)
        if key in counted and extras <= counted[key]:
            continue
        try:
            dist = importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            continue
        found[key] = f"{dist.metadata['Name']}=={dist.version}"
        if key in root_keys:
            extras = frozenset(dist.metadata.get_all("Provides-Extra") or ())
        extras |= counted.get(key, frozenset())
        counted[key] = extras
        for line in dist.requires or ():
            requirement = Requirement(line)
            if requirement.marker is None or any(requirement.marker.evaluate({"extra": extra})
                                                  for extra in ("", *extras)):
                pending.append((requirement.name, frozenset(requirement.extras)))
    return tuple(sorted(found.values()))
