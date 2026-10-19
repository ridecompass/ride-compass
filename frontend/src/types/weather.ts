import type { components } from "./generated/api";

type Schemas = components["schemas"];

// 最寄りのアメダス観測所の実測値。
export type AmedasObservation = Schemas["AmedasObservation"];
export type ValidArea = Schemas["ValidArea"];
