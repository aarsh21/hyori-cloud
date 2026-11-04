/** A narrowed Query resource plus the one native action retry affordances need. */
export type Refreshable<Resource> = Resource & { readonly refetch: () => void };
