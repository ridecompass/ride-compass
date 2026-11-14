// いくつかの画面が同じ名前で指す画面の名前（docs/modules/frontend/frontend-design-system.md「5-4. 画面の語」）。
// 地図の上の入口と道のりのグラフのタブ・「ルート設定」のタブとそれを名指す文が、同じ名前で同じ意味を指すよう、ここだけが持つ。

import { mapDisplay } from "@/types/generated/mapDisplay";

/** 場所の事実（標高・道路の種類・スポット等）を重ねる所。 */
export const FACT_DISPLAY_NAME = "表示";

/** 選んだレンズの負担で、道・ルートの線・道のりのグラフを塗る所。 */
export const BURDEN_PAINT_NAME = "負担で塗る";

/** 「ルート設定」の、道の区分ごとの避け方を選ぶタブ。行は地図の道路のまとまりの層の区分なので、まとまりの名前を使う。 */
export const ROAD_SETTINGS_TAB_NAME = mapDisplay.overlayGroups.find((group) => group.key === "road")!.label;
