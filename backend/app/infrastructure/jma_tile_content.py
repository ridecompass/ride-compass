"""JMA動的タイルの中身が空かどうかの判定。中継の応答・キャッシュ・在否インデックスが同じ基準で読む。"""

import io

from PIL import Image

from app.infrastructure.simple_api_client import UnexpectedShapeError


def is_empty_tile(content: bytes, extension: str) -> bool:
    """タイルに描くものが無いか。

    ラスタは全画素が透明かどうかで判定する（`getchannel("A").getbbox()`は非透明領域の
    外接矩形を返し、全て透明ならNone）。ベクタ（洪水キキクル）は空のMVTが0バイトで
    配信されるため長さで判定する。地物の集まり（GeoJSON）は空と判定しない。

    画像として読めなければ投げる（空と判定すると危険情報が表示されなくなり、中身ありとして配ると壊れた画像を描かせる）。
    """
    if extension == "pbf":
        return len(content) == 0
    if extension == "geojson":
        # 地物の集まり（落雷の地点等）は、地物が無いコマも空の集まりがそのコマの中身で、画面は404を「取れなかった」と読む。
        return False
    try:
        with Image.open(io.BytesIO(content)) as image:
            rgba = image if image.mode == "RGBA" else image.convert("RGBA")
            return rgba.getchannel("A").getbbox() is None
    except (OSError, ValueError, SyntaxError) as error:
        raise UnexpectedShapeError("jma tile is not an image") from error
