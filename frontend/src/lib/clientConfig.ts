/** `GET /api/client-config`の応答（画面が起動のときに1回取る、再デプロイなしに変わる値）から、画面が読む形を導く。 */
import type { ClientConfigResponse, RoadClassCatalog } from "@/types/route";

/** 画面の設定。地図だけが読む形（タイルの世代・事故の年）は地図の機能が同じ応答から導く。 */
export interface ClientConfig {
  /** フロントが使う較正値（id → いま効いている値）。backendの`domain/tuning.py`が宣言し、
   * 管理画面から変えた値が再デプロイなしにここへ届く。**取得できるまでは空**——ビルド時生成物の既定で
   * 埋めると、管理画面で較正したのとは別の値で黙って動く。読み手は引けない間その機能を出さない。 */
  clientTuning: Readonly<Record<string, number>>;
  /** 道の区分（地図の線の層・回避タブの行）。正本は管理DBで、**取得できるまでは層も行も0件**。 */
  roadClasses: RoadClassCatalog;
  /** 取得が成功したか。falseの間は他の欄が空。 */
  loaded: boolean;
  /** 取得に失敗し、まだ一度も成功していないか（`loaded`と同時にtrueにならない）。 */
  failed: boolean;
}

/** ビルド時生成物（route-generate-config.json）に在る較正値のid。 */
type ClientTuningId = keyof (typeof import("@/types/generated/route-generate-config.json"))["client_tuning"];

/** フロントが読む較正値のid。**ここに並んだidは、ビルド時生成物に在るものだけを型が通す**——backendの宣言から
 * 消す/綴りを変えると、フロントは引けないまま、その値を使う機能を黙って出さなくなるため。 */
export const CLIENT_TUNING_IDS = {
  /** 区間を割る下限（km）。これ未満の共有区間では割らない。 */
  minStretchKm: "splice.min_stretch_km",
  /** 走行モデルの標準値。想定速度の説明文に出す。 */
  massKg: "speed.mass_kg",
  cdaM2: "speed.cda_m2",
  maxDescentKmh: "speed.max_descent_kmh",
  walkingKmh: "speed.walking_kmh",
  /** 全長の目標からの許容差（目標の距離に対する割合）。全長の目標の説明文に出す。 */
  distanceToleranceRatio: "search.distance_tolerance_ratio",
  /** 土地被覆を数える帯の外の幅（m）。作り直しに使った値が届く。土地被覆の層の説明文に出す。 */
  landcoverRingOuterM: "landcover.ring_outer_m",
} as const satisfies Record<string, ClientTuningId>;

/** 較正値を1つ引く。**引けなければ`undefined`**——ここで既定を作らない。既定を作ると、
 * 宣言から消えた値を「0」等として使い続け、較正したのとは別の挙動で黙って動く。 */
export function clientTuningValue(config: Pick<ClientConfig, "clientTuning">, id: string): number | undefined {
  return Object.hasOwn(config.clientTuning, id) ? config.clientTuning[id] : undefined;
}

const EMPTY_ROAD_CLASSES: RoadClassCatalog = {
  generation: "",
  map_layers: [],
  avoidance: { levels: [], sections: [], rows: [] },
};

// 取得できるまでは較正値も区分も無い状態で、呼び出し側は`loaded`で区別する（ビルド時の写しを持たない——持つと、APIが
// 失敗したときに古い値で動き、伝播の失敗が見えなくなる）。
export const EMPTY_CLIENT_CONFIG: ClientConfig = {
  clientTuning: {},
  roadClasses: EMPTY_ROAD_CLASSES,
  loaded: false,
  failed: false,
};

export function clientConfigFromResponse(response: ClientConfigResponse): ClientConfig {
  return { clientTuning: response.client_tuning, roadClasses: response.road_classes, loaded: true, failed: false };
}
