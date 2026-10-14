import type zhCN from "./zh-CN";

type DeepString<T> = { readonly [K in keyof T]: T[K] extends string ? string : DeepString<T[K]> };

/** Every locale must provide exactly the keys of the default (Chinese) dictionary. */
export type Messages = DeepString<typeof zhCN>;
