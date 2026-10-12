const STAR = Symbol('star')
type Piece = string | typeof STAR

// Escapes outside a character class. In 'u' mode only syntax characters may be escaped.
function escapeChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch
}

function translateClass(pat: string[], i: number, j: number): string {
  const body = pat.slice(i, j)
  let stuff: string
  if (!body.includes('-')) {
    stuff = body.join('').replace(/\\/g, '\\\\')
  } else {
    const chunks: string[][] = []
    let start = i
    let k = pat[i] === '!' ? i + 2 : i + 1
    for (;;) {
      let found = -1
      for (let q = k; q < j; q++) {
        if (pat[q] === '-') {
          found = q
          break
        }
      }
      if (found < 0) break
      chunks.push(pat.slice(start, found))
      start = found + 1
      k = found + 3
    }
    const last = pat.slice(start, j)
    if (last.length) chunks.push(last)
    else chunks[chunks.length - 1].push('-')
    // Remove empty ranges (invalid in a regex): merge the neighbours, as CPython does.
    for (let q = chunks.length - 1; q > 0; q--) {
      const prev = chunks[q - 1]
      const cur = chunks[q]
      if (prev[prev.length - 1].codePointAt(0) > cur[0].codePointAt(0)) {
        chunks[q - 1] = [...prev.slice(0, -1), ...cur.slice(1)]
        chunks.splice(q, 1)
      }
    }
    stuff = chunks
      .map((c) => c.join('').replace(/\\/g, '\\\\').replace(/-/g, '\\-'))
      .join('-')
  }
  if (!stuff) return '(?!)' // empty class: never matches
  if (stuff === '!') return '.' // negated empty class: any character
  if (stuff[0] === '!') stuff = '^' + stuff.slice(1)
  else if (stuff[0] === '^' || stuff[0] === '[') stuff = '\\' + stuff
  // A ']' can only be the first member here; JS reads a leading ']' as the end of the class.
  return `[${stuff.replace(/]/g, '\\]')}]`
}

export function fnmatchTranslate(pattern: string): string {
  const pat = Array.from(pattern)
  const n = pat.length
  const pieces: Piece[] = []
  let i = 0
  while (i < n) {
    const c = pat[i]
    i++
    if (c === '*') {
      if (pieces.length === 0 || pieces[pieces.length - 1] !== STAR) pieces.push(STAR)
    } else if (c === '?') {
      pieces.push('.')
    } else if (c === '[') {
      let j = i
      if (j < n && pat[j] === '!') j++
      if (j < n && pat[j] === ']') j++
      while (j < n && pat[j] !== ']') j++
      if (j >= n) {
        pieces.push('\\[')
      } else {
        pieces.push(translateClass(pat, i, j))
        i = j + 1
      }
    } else {
      pieces.push(escapeChar(c))
    }
  }
  const out: string[] = []
  let p = 0
  while (p < pieces.length && pieces[p] !== STAR) out.push(pieces[p++] as string)
  let group = 0
  while (p < pieces.length) {
    p++ // the STAR
    if (p === pieces.length) {
      out.push('.*')
      break
    }
    const fixed: string[] = []
    while (p < pieces.length && pieces[p] !== STAR) fixed.push(pieces[p++] as string)
    if (p === pieces.length) {
      out.push('.*', fixed.join(''))
    } else {
      group++
      out.push(`(?=(.*?${fixed.join('')}))\\${group}`)
    }
  }
  return out.join('')
}

export function fnmatchToRegExp(pattern: string): RegExp {
  return new RegExp(`^(?:${fnmatchTranslate(pattern)})$`, 'su')
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/')
}

// filter_repo_objects(items, allow_patterns=patterns), compiled once per selection.
export function compileAllowPatterns(patterns: string[]): (filePath: string) => boolean {
  const regexes: RegExp[] = []
  for (const raw of patterns) {
    let p = normalize(raw)
    if (p.endsWith('/')) p += '*'
    try {
      regexes.push(fnmatchToRegExp(p))
    } catch {
      // Not expressible as a JS regex (should not happen after translation): matches nothing.
    }
  }
  return (filePath: string) => {
    const target = normalize(filePath)
    return regexes.some((r) => r.test(target))
  }
}

export function matchesAllowPatterns(filePath: string, patterns: string[]): boolean {
  return compileAllowPatterns(patterns)(filePath)
}
