"""mypyが型を見るPythonの版（`backend/mypy.ini`）が、本番のイメージ（`backend/Dockerfile`の`FROM`）の版と同じことの検査。

mypy.iniは版をほかから読めないので、ここで照らす。崩れると、本番の版に無い書き方（または本番の版で変わった型）を
mypyが通す。CI・クラウドの開発環境のPythonは、Dockerfileから版を読む。
"""

from __future__ import annotations

import configparser
import re
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]


def test_mypy_checks_the_image_python_version():
    image = re.search(r"^FROM python:(\d+\.\d+)", (BACKEND / "Dockerfile").read_text(encoding="utf-8"), re.MULTILINE)
    mypy = configparser.ConfigParser()
    mypy.read(BACKEND / "mypy.ini", encoding="utf-8")

    assert image is not None, "backend/Dockerfile の FROM から Python の版を読めない"
    assert mypy["mypy"]["python_version"] == image.group(1)
