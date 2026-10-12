import type { ServiceTemplate } from '../../@types/C2D/ServiceOnDemand.js'
import type { FileSelection, ModelSpec, ServiceModelCacheCuratedEntry } from './types.js'
import {
  isCommit,
  isValidRepoFilePath,
  isValidRepoId,
  isValidRevisionName
} from './validate.js'

// Works out which weights the templates download, the way the templates themselves do, so
// the cache can hold them before anyone starts a service.

// Port of the ComfyUI bootstraps' own scan (e.g. product-studio-qwen-image/bootstrap.sh):
// every string anywhere in every shipped workflow graph — MarkdownNotes included, the
// bootstraps download those too.
const URL_RE = /https:\/\/huggingface\.co\/[^\s)\]"]+?\.safetensors/g
const HF_PREFIX = 'https://huggingface.co/'
const CURATED_BASE_PRIORITY = 1_000_000

export interface ParsedHfUrl {
  repo: string
  revision: string
  file: string
}

// First path segments that are Hub sections, never a model owner (an owner-less
// datasets/<name>/resolve/... link would otherwise read as model repo 'datasets/<name>').
const RESERVED_OWNERS = new Set(['datasets', 'spaces', 'api'])

// The model repo a huggingface.co URL names, whatever the rest of it looks like.
export function hfUrlRepo(url: string): string | null {
  const clean = url.split('?', 1)[0].split('#', 1)[0]
  if (!clean.startsWith(HF_PREFIX)) return null
  const parts = clean.slice(HF_PREFIX.length).split('/')
  if (parts.length < 2 || RESERVED_OWNERS.has(parts[0])) return null
  const repo = `${parts[0]}/${parts[1]}`
  return isValidRepoId(repo) ? repo : null
}

export function parseHfResolveUrl(url: string): ParsedHfUrl | null {
  const clean = url.split('?', 1)[0].split('#', 1)[0]
  if (!clean.startsWith(HF_PREFIX)) return null
  const parts = clean.slice(HF_PREFIX.length).split('/')
  if (parts.length < 5 || parts[2] !== 'resolve') return null
  if (RESERVED_OWNERS.has(parts[0])) return null
  let revision: string
  let file: string
  try {
    revision = decodeURIComponent(parts[3])
    file = parts.slice(4).map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  const repo = `${parts[0]}/${parts[1]}`
  if (!file.endsWith('.safetensors')) return null
  if (!isValidRepoId(repo) || !isValidRepoFilePath(file)) return null
  if (!isCommit(revision) && !isValidRevisionName(revision)) return null
  return { repo, revision, file }
}

// Every https://huggingface.co/...safetensors URL in a value, walked iteratively (graphs come
// from the catalogue and can be large).
export function scanHfUrls(value: unknown): string[] {
  const found = new Set<string>()
  const stack: unknown[] = [value]
  while (stack.length) {
    const v = stack.pop()
    if (typeof v === 'string') {
      for (const m of v.matchAll(URL_RE)) found.add(m[0])
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item)
    } else if (v && typeof v === 'object') {
      for (const item of Object.values(v)) stack.push(item)
    }
  }
  return [...found]
}

// Catalogue order first (`order`, lowest first), unlisted templates after listed ones, then id.
export function sortTemplatesForCache(templates: ServiceTemplate[]): ServiceTemplate[] {
  return [...templates].sort((a, b) => {
    const oa = typeof a.order === 'number' ? a.order : Infinity
    const ob = typeof b.order === 'number' ? b.order : Infinity
    if (oa !== ob) return oa < ob ? -1 : 1
    const ua = a.unlisted ? 1 : 0
    const ub = b.unlisted ? 1 : 0
    if (ua !== ub) return ua - ub
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

// fnmatch-escape a literal path so it can join a pattern selection (glob.escape).
function escapeFnmatch(p: string): string {
  return p.replace(/[[*?]/g, (c) => `[${c}]`)
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}

export function mergeSelection(a: FileSelection, b: FileSelection): FileSelection {
  if (a.kind === 'all' || b.kind === 'all') return { kind: 'all' }
  if (a.kind === 'files' && b.kind === 'files') {
    return { kind: 'files', files: union(a.files, b.files) }
  }
  const asPatterns = (s: FileSelection) =>
    s.kind === 'patterns'
      ? s.patterns
      : s.kind === 'files'
        ? s.files.map(escapeFnmatch)
        : []
  return { kind: 'patterns', patterns: union(asPatterns(a), asPatterns(b)) }
}

function specKey(repo: string, revision: string): string {
  return `${repo}@${revision}`
}

function addSpec(map: Map<string, ModelSpec>, spec: ModelSpec): void {
  const key = specKey(spec.repo, spec.revision)
  const existing = map.get(key)
  if (!existing) {
    map.set(key, spec)
    return
  }
  existing.selection = mergeSelection(existing.selection, spec.selection)
  existing.priority = Math.min(existing.priority, spec.priority)
  existing.sources = union(existing.sources, spec.sources)
}

export function deriveTemplateSpecs(
  templates: ServiceTemplate[],
  includeUnlisted: boolean
): { specs: ModelSpec[]; problems: string[] } {
  const problems: string[] = []
  const specs = new Map<string, ModelSpec>()
  const sorted = sortTemplatesForCache(templates).filter(
    (t) => includeUnlisted || !t.unlisted
  )
  sorted.forEach((tmpl, priority) => {
    const source = `template:${tmpl.id}`
    const urlRepos = new Set<string>()
    for (const wf of tmpl.workflows ?? []) {
      for (const url of scanHfUrls(wf.graph)) {
        // A URL names its repo even when it cannot be cached (short-hex revision, blob/
        // link): the template wants files of that repo, never the whole repo, so its
        // includes[] entry must not turn into a full snapshot.
        const named = hfUrlRepo(url)
        if (named) urlRepos.add(named)
        const parsed = parseHfResolveUrl(url)
        if (!parsed) {
          problems.push(`${source}: skipped unsupported model URL ${url.split('?')[0]}`)
          continue
        }
        urlRepos.add(parsed.repo)
        addSpec(specs, {
          repo: parsed.repo,
          revision: parsed.revision,
          selection: { kind: 'files', files: [parsed.file] },
          priority,
          sources: [source]
        })
      }
    }
    for (const item of tmpl.includes ?? []) {
      if (item.kind !== 'model' || !item.repoId || urlRepos.has(item.repoId)) continue
      if (!isValidRepoId(item.repoId)) {
        problems.push(`${source}: skipped invalid repo id ${JSON.stringify(item.repoId)}`)
        continue
      }
      addSpec(specs, {
        repo: item.repoId,
        revision: 'main',
        selection: { kind: 'all' },
        priority,
        sources: [source]
      })
    }
  })
  return { specs: [...specs.values()], problems }
}

// A curated entry replaces every derived spec of the same repo (all revisions): it is how
// the operator narrows a repo (gemma's allow_patterns) or pins it.
export function applyCurated(
  templateSpecs: ModelSpec[],
  curated: ServiceModelCacheCuratedEntry[]
): { specs: ModelSpec[]; problems: string[] } {
  const problems: string[] = []
  const curatedSpecs = new Map<string, ModelSpec>()
  curated.forEach((entry, i) => {
    const revision = entry.revision ?? 'main'
    if (!isValidRepoId(entry.repo) || !isValidRevisionName(revision)) {
      problems.push(`curated[${i}]: invalid repo or revision, skipped`)
      return
    }
    if (entry.commit !== undefined && !isCommit(entry.commit)) {
      problems.push(`curated[${i}]: commit must be 40 lowercase hex characters, skipped`)
      return
    }
    let selection: FileSelection = { kind: 'all' }
    if (entry.files?.length) {
      const bad = entry.files.filter((f) => !isValidRepoFilePath(f))
      if (bad.length) {
        problems.push(`curated[${i}]: invalid file path(s) ${bad.join(', ')}, skipped`)
        return
      }
      selection = { kind: 'files', files: [...new Set(entry.files)] }
    } else if (entry.allowPatterns?.length) {
      selection = { kind: 'patterns', patterns: [...new Set(entry.allowPatterns)] }
    }
    const key = specKey(entry.repo, revision)
    const existing = curatedSpecs.get(key)
    if (existing && existing.commit !== entry.commit) {
      problems.push(
        `curated[${i}]: ${entry.repo}@${revision} is pinned to two different commits; kept the first`
      )
      return
    }
    addSpec(curatedSpecs, {
      repo: entry.repo,
      revision,
      ...(entry.commit ? { commit: entry.commit } : {}),
      selection,
      priority:
        typeof entry.priority === 'number' ? entry.priority : CURATED_BASE_PRIORITY + i,
      sources: ['curated']
    })
  })
  const curatedRepos = new Set([...curatedSpecs.values()].map((s) => s.repo))
  const kept = templateSpecs.filter((s) => !curatedRepos.has(s.repo))
  const specs = [...kept, ...curatedSpecs.values()].sort(
    (a, b) => a.priority - b.priority
  )
  return { specs, problems }
}
