/* mtoc2 runtime helper: stable sort on a real tensor.
 *
 *   mtoc2_sort_real(a, descending)
 *     `b = sort(a)` / `sort(a, 'ascend'|'descend')` — returns a
 *     freshly-owned tensor of the same shape as `a`, with the flat
 *     (column-major) entries sorted in the requested direction.
 *
 *   mtoc2_sort_real_2(a, descending, &out_v, &out_i)
 *     `[v, i] = sort(...)` — fills `*out_v` with the sorted values
 *     and `*out_i` with 1-based original positions.
 *
 * Sort is stable in both directions: ties resolve by ascending
 * original index, matching numbl's behaviour (verified against
 * `sort([5 2 8 1 2], 'descend')` → indices `3 1 2 5 4`).
 *
 * The lowering layer restricts the input to a 1×N row vector or N×1
 * column vector for v1; the helper itself walks the column-major
 * flat buffer and would handle any rank, but the type system rejects
 * the higher-rank cases until the per-axis form is plumbed through.
 */

#include <stdlib.h>

typedef struct {
  double v;
  long ix;
} mtoc2_sort_pair_t;

static int mtoc2_sort_cmp_asc(const void *pa, const void *pb) {
  const mtoc2_sort_pair_t *a = (const mtoc2_sort_pair_t *)pa;
  const mtoc2_sort_pair_t *b = (const mtoc2_sort_pair_t *)pb;
  if (a->v < b->v) return -1;
  if (a->v > b->v) return 1;
  if (a->ix < b->ix) return -1;
  if (a->ix > b->ix) return 1;
  return 0;
}

static int mtoc2_sort_cmp_desc(const void *pa, const void *pb) {
  const mtoc2_sort_pair_t *a = (const mtoc2_sort_pair_t *)pa;
  const mtoc2_sort_pair_t *b = (const mtoc2_sort_pair_t *)pb;
  if (a->v > b->v) return -1;
  if (a->v < b->v) return 1;
  /* Tie-break still by ascending original index — both numbl and
   * MATLAB keep ties in original order in either direction. */
  if (a->ix < b->ix) return -1;
  if (a->ix > b->ix) return 1;
  return 0;
}

static mtoc2_tensor_t mtoc2_sort_real(mtoc2_tensor_t a, int descending) {
  long n = 1;
  for (int i = 0; i < a.ndim; i++) n *= a.dims[i];
  mtoc2_tensor_t r;
  r.real = mtoc2_alloc((size_t)n * sizeof(double));
  r.imag = NULL;
  r.ndim = a.ndim;
  for (int i = 0; i < a.ndim; i++) r.dims[i] = a.dims[i];
  if (n == 0) return r;
  mtoc2_sort_pair_t *buf =
    (mtoc2_sort_pair_t *)malloc((size_t)n * sizeof(mtoc2_sort_pair_t));
  if (!buf) {
    fprintf(stderr, "mtoc2: out of memory (sort buffer)\n");
    abort();
  }
  for (long i = 0; i < n; i++) {
    buf[i].v = a.real[i];
    buf[i].ix = i;
  }
  qsort(buf, (size_t)n, sizeof(mtoc2_sort_pair_t),
        descending ? mtoc2_sort_cmp_desc : mtoc2_sort_cmp_asc);
  for (long i = 0; i < n; i++) r.real[i] = buf[i].v;
  free(buf);
  return r;
}

static void mtoc2_sort_real_2(mtoc2_tensor_t a, int descending,
                              mtoc2_tensor_t *out_v, mtoc2_tensor_t *out_i) {
  long n = 1;
  for (int i = 0; i < a.ndim; i++) n *= a.dims[i];
  mtoc2_tensor_t v;
  mtoc2_tensor_t ix;
  v.real = mtoc2_alloc((size_t)n * sizeof(double));
  v.imag = NULL;
  v.ndim = a.ndim;
  for (int i = 0; i < a.ndim; i++) v.dims[i] = a.dims[i];
  ix.real = mtoc2_alloc((size_t)n * sizeof(double));
  ix.imag = NULL;
  ix.ndim = a.ndim;
  for (int i = 0; i < a.ndim; i++) ix.dims[i] = a.dims[i];
  if (n > 0) {
    mtoc2_sort_pair_t *buf =
      (mtoc2_sort_pair_t *)malloc((size_t)n * sizeof(mtoc2_sort_pair_t));
    if (!buf) {
      fprintf(stderr, "mtoc2: out of memory (sort buffer)\n");
      abort();
    }
    for (long i = 0; i < n; i++) {
      buf[i].v = a.real[i];
      buf[i].ix = i;
    }
    qsort(buf, (size_t)n, sizeof(mtoc2_sort_pair_t),
          descending ? mtoc2_sort_cmp_desc : mtoc2_sort_cmp_asc);
    for (long i = 0; i < n; i++) {
      v.real[i] = buf[i].v;
      ix.real[i] = (double)(buf[i].ix + 1);
    }
    free(buf);
  }
  mtoc2_tensor_assign(out_v, v);
  mtoc2_tensor_assign(out_i, ix);
}
