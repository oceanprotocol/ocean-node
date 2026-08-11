// Normalization for caller-supplied `fromTimestamp`-style query filters.
//
// This is for *request parameters*, not for stored job timestamps: use
// `parseJobTimestamp` (compute_engine_base.ts) to read a persisted timestamp column, which
// treats the `'0'` sentinel as "not set". Here `0`/garbage must be distinguishable from
// "no filter" so the handler can answer 400 instead of silently returning an empty list.

// Parses the `fromTimestamp` filter into Unix milliseconds. Accepts an ISO date string
// or a Unix timestamp (seconds or milliseconds) given as a string / number-like string.
// Returns undefined for "no filter" and null for an unparseable value (caller → 400).
export function parseFromTimestamp(value?: string): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  if (/^\d+$/.test(String(value))) {
    const n = Number(value)
    // 1e12 ms ≈ Sep 2001; any plausible seconds value is far below it
    return n > 1e12 ? n : n * 1000
  }
  const t = Date.parse(String(value))
  return Number.isNaN(t) ? null : t
}

// Same parse, expressed in Unix *seconds* — the unit the compute_jobs table stores its
// dateCreated/dateFinished columns in. Kept as an explicit wrapper so no call site has to
// guess whether it is holding seconds or milliseconds.
export function parseFromTimestampSeconds(value?: string): number | undefined | null {
  const ms = parseFromTimestamp(value)
  if (ms === undefined || ms === null) return ms
  return ms / 1000
}
