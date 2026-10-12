import path from 'path'

// Every string that becomes part of a cache path comes from somewhere the node does not
// control: template JSON, workflow graphs, curated config, the Hugging Face API. Each is
// checked here before first use, and again when read back from state.json.

export const SHA1_RE = /^[0-9a-f]{40}$/
export const SHA256_RE = /^[0-9a-f]{64}$/
const REPO_PART = '[A-Za-z0-9][A-Za-z0-9._-]{0,95}'
const REPO_RE = new RegExp(`^${REPO_PART}/${REPO_PART}$`)
const REVISION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SHORT_HEX_RE = /^[0-9a-f]{7,39}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/

// huggingface_hub's validate_repo_id rules, minus namespace-less ids (a model id always has
// an owner here): no '--' (the folder name uses it as the separator), no '..', no '.git'.
export function isValidRepoId(repo: unknown): repo is string {
  return (
    typeof repo === 'string' &&
    REPO_RE.test(repo) &&
    !repo.includes('--') &&
    !repo.includes('..') &&
    !repo.endsWith('.git') &&
    !repo.endsWith('.')
  )
}

export function isCommit(value: unknown): value is string {
  return typeof value === 'string' && SHA1_RE.test(value)
}

// A ref NAME the cache may write to refs/<name>. No slashes (no refs/pr/N in v1) and nothing
// that looks like a short commit, which Hugging Face would resolve as a commit.
export function isValidRevisionName(rev: unknown): rev is string {
  return (
    typeof rev === 'string' &&
    REVISION_NAME_RE.test(rev) &&
    !rev.includes('..') &&
    !SHORT_HEX_RE.test(rev) &&
    !SHA1_RE.test(rev)
  )
}

// A repo-relative file path: forward slashes, no empty / '.' / '..' segments, no absolute
// path, no control characters, no backslash, segments of at most 255 bytes.
export function isValidRepoFilePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return false
  if (p.startsWith('/') || p.includes('\\') || CONTROL_RE.test(p)) return false
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false
    if (Buffer.byteLength(seg) > 255) return false
  }
  return true
}

export function repoFolderName(repo: string): string {
  return `models--${repo.replace('/', '--')}`
}

// path.join that refuses to leave `root`. Segments must already be validated; this is the
// backstop that every fs operation in the cache goes through.
export function safeJoin(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments)
  const rel = path.relative(root, target)
  // '..foo' is a legal name inside the root; only '..' itself or a '../' prefix escapes.
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith('..' + path.sep) ||
    path.isAbsolute(rel)
  ) {
    throw new Error(`refusing path outside the model cache: ${segments.join('/')}`)
  }
  return target
}

// True when `a` and `b` are the same path or one contains the other.
export function pathsOverlap(a: string, b: string): boolean {
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  if (ra === rb) return true
  const withSep = (p: string) => (p.endsWith(path.sep) ? p : p + path.sep)
  return ra.startsWith(withSep(rb)) || rb.startsWith(withSep(ra))
}
