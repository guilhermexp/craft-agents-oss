export type Opaque<T, Brand extends string> = T & { readonly __brand: Brand };

