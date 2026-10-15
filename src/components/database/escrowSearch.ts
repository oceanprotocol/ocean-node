import { RangeFilter } from '../../@types/commands.js'

// Fields stored as native numeric types in both backends (Typesense int64 / ES long).
// Range filters on these are pushed down to the store's query DSL.
export const NATIVE_RANGE_FIELDS = ['block', 'chainId']

// uint256 fields stored as strings/text to avoid precision loss. Lexicographic range in the
// store would be wrong (e.g. "9" > "100"), so range filters on these are applied client-side
// with BigInt comparison after fetching candidate rows.
export const CLIENT_RANGE_FIELDS = [
  'amount',
  'subsidyAmount',
  'bonusAmount',
  'oldAmount',
  'newAmount',
  'maxLockedAmount',
  'maxLockSeconds',
  'maxLockCounts',
  'expiry',
  'newExpiry',
  'expiryTimestamp'
]

export const ALLOWED_RANGE_FIELDS = [...NATIVE_RANGE_FIELDS, ...CLIENT_RANGE_FIELDS]

// A filter value is a range (vs an equality scalar) when it is a plain object carrying at
// least one of the range bounds.
export function isRangeFilter(value: any): value is RangeFilter {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ('min' in value || 'max' in value || 'gt' in value || 'lt' in value)
  )
}

function toBigInt(x: string | number | undefined | null): bigint | undefined {
  if (x === undefined || x === null || x === '') return undefined
  try {
    return BigInt(x)
  } catch {
    return undefined
  }
}

function hasValue(x: string | number | undefined | null): boolean {
  return x !== undefined && x !== null && x !== ''
}

// Validate the `ranges` map coming from the command: known fields only, integer bounds,
// and min<=max / gt<lt where both sides are given.
export function validateEscrowRanges(ranges?: Record<string, RangeFilter>): {
  valid: boolean
  reason?: string
} {
  if (ranges === undefined || ranges === null) return { valid: true }
  if (typeof ranges !== 'object' || Array.isArray(ranges)) {
    return { valid: false, reason: 'ranges must be an object' }
  }
  for (const [field, r] of Object.entries(ranges)) {
    if (!ALLOWED_RANGE_FIELDS.includes(field)) {
      return {
        valid: false,
        reason: `range filter not supported for field '${field}'. Allowed: ${ALLOWED_RANGE_FIELDS.join(
          ', '
        )}`
      }
    }
    if (!isRangeFilter(r)) {
      return {
        valid: false,
        reason: `range for '${field}' must specify min, max, gt or lt`
      }
    }
    for (const bound of ['min', 'max', 'gt', 'lt'] as const) {
      const val = r[bound]
      if (hasValue(val) && toBigInt(val) === undefined) {
        return {
          valid: false,
          reason: `range bound '${field}.${bound}' must be an integer`
        }
      }
    }
    const min = toBigInt(r.min)
    const max = toBigInt(r.max)
    if (min !== undefined && max !== undefined && min > max) {
      return { valid: false, reason: `range for '${field}': min must be <= max` }
    }
    const gt = toBigInt(r.gt)
    const lt = toBigInt(r.lt)
    if (gt !== undefined && lt !== undefined && gt >= lt) {
      return { valid: false, reason: `range for '${field}': gt must be < lt` }
    }
  }
  return { valid: true }
}

// Native range fields are numeric in the store (Typesense int64 / ES long), so their bounds go
// straight into the numeric DSL. Emit each defined bound as a canonical decimal string so a
// value given as hex ("0x64"), a number, or with leading zeros ("007") is not sent verbatim.
// Absent bounds stay absent; a non-parseable bound (shouldn't occur post-validation) is left
// untouched. Client-side ranges are NOT normalized — passesClientRanges parses them with BigInt.
function normalizeNativeRange(r: RangeFilter): RangeFilter {
  const out: RangeFilter = {}
  for (const bound of ['min', 'max', 'gt', 'lt'] as const) {
    const v = r[bound]
    if (!hasValue(v)) continue
    const big = toBigInt(v)
    out[bound] = big !== undefined ? big.toString() : v
  }
  return out
}

// Split the ranges into those pushed to the store (native numeric fields) and those applied
// client-side (uint256 string fields). Unknown fields are dropped (validation rejects them
// before this is reached).
export function splitRanges(ranges?: Record<string, RangeFilter>): {
  nativeRanges: Record<string, RangeFilter>
  clientRanges: Record<string, RangeFilter>
} {
  const nativeRanges: Record<string, RangeFilter> = {}
  const clientRanges: Record<string, RangeFilter> = {}
  for (const [field, r] of Object.entries(ranges || {})) {
    if (!isRangeFilter(r)) continue
    if (NATIVE_RANGE_FIELDS.includes(field)) nativeRanges[field] = normalizeNativeRange(r)
    else if (CLIENT_RANGE_FIELDS.includes(field)) clientRanges[field] = r
  }
  return { nativeRanges, clientRanges }
}

// Does a record satisfy every client-side (BigInt) range? A record missing a filtered field,
// or holding a non-numeric value, fails.
export function passesClientRanges(
  record: Record<string, any>,
  clientRanges: Record<string, RangeFilter>
): boolean {
  for (const [field, r] of Object.entries(clientRanges || {})) {
    const value = toBigInt(record?.[field])
    if (value === undefined) return false
    const min = toBigInt(r.min)
    const max = toBigInt(r.max)
    const gt = toBigInt(r.gt)
    const lt = toBigInt(r.lt)
    if (min !== undefined && value < min) return false
    if (max !== undefined && value > max) return false
    if (gt !== undefined && value <= gt) return false
    if (lt !== undefined && value >= lt) return false
  }
  return true
}

// Build a Typesense `filter_by` string from a filters map whose values are either equality
// scalars or RangeFilter objects. Range objects only make sense on numeric fields.
export function buildTypesenseFilterBy(filters: Record<string, any>): string {
  const clauses: string[] = []
  // An array value means several constraints on the SAME field, all ANDed — e.g. an equality
  // and a range on `chainId`; each element is emitted as its own clause.
  const emit = (field: string, value: any) => {
    if (value === undefined || value === null || value === '') return
    if (isRangeFilter(value)) {
      if (hasValue(value.min)) clauses.push(`${field}:>=${value.min}`)
      if (hasValue(value.max)) clauses.push(`${field}:<=${value.max}`)
      if (hasValue(value.gt)) clauses.push(`${field}:>${value.gt}`)
      if (hasValue(value.lt)) clauses.push(`${field}:<${value.lt}`)
    } else if (typeof value === 'string') {
      // Backtick string values so spaces/special chars can't break the syntax;
      // strip backticks from the value so it can't escape the quoted literal.
      clauses.push(`${field}:=\`${value.replace(/`/g, '')}\``)
    } else {
      clauses.push(`${field}:=${value}`)
    }
  }
  for (const [field, value] of Object.entries(filters || {})) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) value.forEach((v) => emit(field, v))
    else emit(field, value)
  }
  return clauses.join(' && ')
}

// Build an Elasticsearch query body from the same filters map: `term` for equality,
// `range` for RangeFilter objects.
export function buildElasticQuery(filters: Record<string, any>): Record<string, any> {
  const must: Record<string, any>[] = []
  // An array value means several constraints on the SAME field, all ANDed (e.g. an equality
  // term plus a range on `chainId`); each element becomes its own clause in `must`.
  const emit = (field: string, value: any) => {
    if (value === undefined || value === null || value === '') return
    if (isRangeFilter(value)) {
      const range: Record<string, any> = {}
      if (hasValue(value.min)) range.gte = value.min
      if (hasValue(value.max)) range.lte = value.max
      if (hasValue(value.gt)) range.gt = value.gt
      if (hasValue(value.lt)) range.lt = value.lt
      if (Object.keys(range).length) must.push({ range: { [field]: range } })
    } else {
      must.push({ term: { [field]: value } })
    }
  }
  for (const [field, value] of Object.entries(filters || {})) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) value.forEach((v) => emit(field, v))
    else emit(field, value)
  }
  return must.length ? { bool: { must } } : { match_all: {} }
}
