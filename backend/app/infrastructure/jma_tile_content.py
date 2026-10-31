"""JMA動的タイルの中身が空かどうかの判定。中継の応答・キャッシュ・在否インデックスが同じ基準で読む。"""

import io

from PIL import Image


def is_empty_tile(content: bytes, extension: str) -> bool:
    """タイルに描くものが無いか。

    ラスタは全画素が透明かどうかで判定する（`getchannel("A").getbbox()`は非透明領域の
    外接矩形を返し、全て透明ならNone）。ベクタ（洪水キキクル）は空のMVTが0バイトで
    配信されるため長さで判定する。

    **判定できない場合は「中身あり」に倒す**——この判定は「取りに行かなくてよい」
    「実体を保持しなくてよい」の根拠に使うため、誤って空と判定すると危険情報が
    表示されなくなる。
    """
    if extension == "pbf":
        return len(content) == 0
    try:
        with Image.open(io.BytesIO(content)) as image:
            rgba = image if image.mode == "RGBA" else image.convert("RGBA")
            return rgba.getchannel("A").getbbox() is None
    except Exception:  # 壊れた画像・未知の形式は「中身あり」扱いで取得を止めない
        return False
