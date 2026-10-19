import type { components } from "./generated/api";

type Schemas = components["schemas"];

// 表示範囲の中のMSMの格子点の予報。値の並びは`times`と揃う。
export type MsmGridForecast = Schemas["MsmGridForecast"];
// 最寄りのアメダス観測所の実測値。
export type AmedasObservation = Schemas["AmedasObservation"];
export type ValidArea = Schemas["ValidArea"];
