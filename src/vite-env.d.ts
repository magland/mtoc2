/**
 * Augment ImportMeta so numbl's `import.meta.env` (a Vite-only construct)
 * type-checks when imported through the sibling-relative path. numbl
 * gates a precision flag on this; in mtoc2's CLI context it's always
 * undefined and the default branch (float64) applies.
 */
interface ImportMeta {
  env?: Record<string, string | undefined>;
}
