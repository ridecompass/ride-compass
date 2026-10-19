import type { components } from "./generated/api";

type Schemas = components["schemas"];

// 表示範囲の中のMSMの格子点の予報。値の並びは`times`と揃う。
export type MsmGridForecast = Schemas["MsmGridForecast"];
// 最寄りのアメダス観測所の実測値。
export type AmedasObservation = Schemas["AmedasObservation"];
// 地点に最も近いMSMの格子点の、今日の1時間ごとの値。値の並びは`times`と揃う。
export type GridPointToday = Schemas["GridPointToday"];
export type ValidArea = Schemas["ValidArea"];
