"""気象庁タイルの中継の段取り（キャッシュ → 親タイルからの補間 → 上流）。"""

from collections.abc import Callable

from app.domain.jma_tile_specs import source_zoom_for_interpolation
from app.infrastructure.simple_api_client import UnexpectedShapeError
from app.infrastructure.http_client import UpstreamNotFound
from app.infrastructure.jma_tile_client import JmaTileClient
from app.infrastructure.jma_tile_interpolation import crop_and_upscale, crop_and_upscale_mvt, parse_tile_path


async def _interpolated_tile(jma_tile_client: JmaTileClient, path: str) -> tuple[bytes, str] | None:
    """配信元が実データを持たないズームの要求に対し、親タイルから補間したタイルの内容とContent-Type。

    ラスタ（画像の拡大）・ベクタ（座標の変換）のどちらも対象。対象外（実データがあるズーム・タイル以外のパス）・
    親が空のときはNone。親が読めず補間できなければ投げる。Content-Typeは親タイルのものをそのまま使う（配信元が返す値と
    揃え、拡張子から推測しない）。
    """
    coords = parse_tile_path(path)
    if coords is None:
        return None
    if source_zoom_for_interpolation(coords.element, coords.z) is None:
        return None
    parent = await jma_tile_client.get(coords.parent_path())
    if isinstance(parent, UpstreamNotFound):
        # 親が空なら拡大しても空にしかならない。
        return None
    parent_content, parent_content_type = parent
    try:
        if coords.ext == "pbf":
            return crop_and_upscale_mvt(parent_content, coords.quadrant), parent_content_type
        return crop_and_upscale(parent_content, coords.quadrant), parent_content_type
    except (OSError, ValueError, SyntaxError) as error:
        raise UnexpectedShapeError(f"jma parent tile cannot be interpolated: {coords.parent_path()}") from error


async def proxied_tile(
    jma_tile_client: JmaTileClient, path: str, before_upstream: Callable[[], None]
) -> tuple[bytes, str] | UpstreamNotFound:
    """`path`の内容とContent-Type。

    キャッシュに無いときだけ、補間・上流へ出る前に`before_upstream`を1回呼ぶ（呼び出し側の歯止め。
    送出すればそこで止まる）。配信元が実データを持たないズームは親タイルから補間し、元のパスの鍵で
    キャッシュへ書き戻す。上流に無い（描くものが無いと確認済みを含む）なら`UpstreamNotFound`。上流の障害は投げる。
    """
    cached = await jma_tile_client.get_cached(path)
    if cached is not None:
        return cached
    before_upstream()
    interpolated = await _interpolated_tile(jma_tile_client, path)
    if interpolated is not None:
        content, content_type = interpolated
        return await jma_tile_client.store(path, content, content_type)
    return await jma_tile_client.fetch(path)
