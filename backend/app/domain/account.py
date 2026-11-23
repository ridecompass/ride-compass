"""利用者のログインと、走りの記録への同意の決まり。

ログインが要るのは走りを残すことだけで、ほかの口はログインなしで使える。利用者は、ログインの方法とその方法での利用者の番号の組だけで
見分け、名前とメールは持たない。
"""

from datetime import timedelta
from typing import Literal

from app.domain.strict_model import StrictModel

#: 今の規約の版。集めるもの・使い道・持たないものの文を変えたら上げ、同意し直してもらう。
TERMS_VERSION = 1

#: ログインの札が効く長さ。走るたびにログインを求めないよう、乗らない時期をまたいで効かせる。
SESSION_LIFETIME = timedelta(days=365)

LoginMethod = Literal["google"]


class AccountStatus(StrictModel):
    """自分の状態。ログインしていなければ`consented`は偽。"""

    signed_in: bool
    #: 今の規約の版（`terms_version`）に同意していて、やめていない。
    consented: bool
    terms_version: int
