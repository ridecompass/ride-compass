"""MSMの公表の範囲と形状（北緯22.4〜47.6度・東経120〜150度、505×481点）から作った格子。

MSMの読み出しを差し替えるテストが、配信と同じ格子点を返すのに使う。
"""

from app.domain.msm import MsmGrid

MSM_BBOX = (22.4, 120.0, 47.6, 150.0)
MSM_GRID = MsmGrid.from_bbox_and_shape(MSM_BBOX, 505, 481)
