"""定義の表（道の区分・費用の軸）の書き込みを直列化する鍵。

道の区分と費用の軸は、書く前に互いを照らす（区分を消すと費用の軸の重さが当たらなくなり、費用の軸が知らない区分を指すと
読み込めない）。「読む→照らす→書く」を鍵なしで並べると、2つの書き込みが互いの古い姿の上で照らして通り、合わない組が
残る（TOCTOU）。DB の advisory lock にするのは、プロセスをまたいでも効くようにするため（`asyncio.Lock`は同じプロセスの
中でしか効かない）。鍵の値に意味は無く、ほかの advisory lock と重ならない固定値であればよい。
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_WRITE_LOCK_KEY = 0x4158495344454653


async def acquire_definition_write_lock(session: AsyncSession) -> None:
    """取引の範囲の鍵を取る。呼び手の`commit()`か、セッションの終わりの rollback で外れる。"""
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _WRITE_LOCK_KEY})
