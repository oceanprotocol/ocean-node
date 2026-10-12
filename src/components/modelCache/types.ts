// Shapes shared by the node-level model cache (see docs/modelCache.md).

export interface ServiceModelCacheCuratedEntry {
  repo: string // Hugging Face repo id, org/name
  revision?: string // ref NAME the cache publishes (refs/<revision>); default 'main'
  commit?: string // 40-hex pin: the cache serves this commit as refs/<revision>
  allowPatterns?: string[] // huggingface_hub allow_patterns semantics
  files?: string[] // exact repo-relative paths
  priority?: number // lower first; curated entries without one keep list order
}

export interface ServiceModelCacheConfig {
  enabled: boolean
  path?: string // HOST path, bound into the node container at the identical path
  maxSizeGb?: number
  minFreeGb?: number
  fromTemplates?: boolean
  includeUnlisted?: boolean
  curated?: ServiceModelCacheCuratedEntry[]
  syncIntervalMinutes?: number
  gcGraceHours?: number
}

export type FileSelection =
  | { kind: 'all' }
  | { kind: 'patterns'; patterns: string[] }
  | { kind: 'files'; files: string[] }

// One wanted (repo, revision) before it is resolved to a commit.
export interface ModelSpec {
  repo: string
  revision: string // ref name, or a 40-hex commit when a template URL names one
  commit?: string // curated pin
  selection: FileSelection
  priority: number // lower = more important
  sources: string[] // 'template:<id>' / 'curated'
}

export interface HfSibling {
  rfilename: string
  size: number
  blobId: string // git blob sha1
  lfs?: { sha256: string; size: number }
}

export interface HfRevisionInfo {
  id: string
  sha: string
  private: boolean
  gated: false | string
  disabled: boolean
  siblings: HfSibling[]
}

// A file of a snapshot, as stored: `blob` is the blob file name (sha256 for LFS, git sha1
// otherwise), which is also the hash it was verified against.
export interface CachedFile {
  blob: string
  size: number
  lfs: boolean
  present?: boolean // blob verified in place and the snapshot link created
  retiredAt?: string // ISO; set when the file left the wanted set of a still-wanted snapshot
}

export interface SnapshotState {
  repo: string
  commit: string
  complete: boolean // every file of the repo at this commit
  selection: FileSelection
  files: Record<string, CachedFile>
  publishedAt?: string // ISO; set once every non-retired file is verified and linked
  retiredAt?: string // ISO; set when no wanted spec maps to this snapshot any more
}

export type WantedStatus =
  | 'ok'
  | 'downloading'
  | 'deferred:budget'
  | 'skipped:budget'
  | 'skipped:gated'
  | 'skipped:private'
  | 'skipped:disabled'
  | 'error'

export interface WantedState {
  sha?: string
  status: WantedStatus
  missingBytes: number
  error?: string
}

export interface CacheState {
  version: 1
  id: string
  snapshots: Record<string, SnapshotState> // key: `${repo}@${commit}`
  refs: Record<string, Record<string, string>> // repo -> revision name -> published commit
  wanted: Record<string, Record<string, WantedState>> // repo -> revision -> status
  lastGoodTemplateSpecs?: ModelSpec[]
  lastGoodTemplateSpecsAt?: string
  // Every blob the node installed: `<repo folder>/<blob>` -> its inode and size. A file at a
  // blob path that is not this exact inode was not put there by the node and is not trusted.
  blobs?: BlobRegistry
}

export type BlobRegistry = Record<string, { ino: string; size: number }>

export interface CacheIndex {
  version: 1
  generatedAt: string
  repos: Record<
    string,
    {
      refs: Record<string, string>
      wanted: Record<string, WantedState>
      snapshots: Record<
        string,
        {
          path: string
          complete: boolean
          selection: null | { allowPatterns: string[] } | { files: string[] }
          files: Record<string, number>
        }
      >
    }
  >
}

// What the manager verified about the cache root; the mount helper mounts only this.
export interface ModelCacheMountVerdict {
  configuredPath: string
  publicRealpath: string
  dev: number
  ino: number
}

export interface ModelCacheStatus {
  state: 'disabled' | 'idle' | 'running' | 'error'
  error?: string
  lastRunStartedAt?: string
  lastRunFinishedAt?: string
  templatesFrozen?: boolean
  wanted?: number
  published?: number
  bytesOnDisk?: number
  downloadedBytes?: number
}
