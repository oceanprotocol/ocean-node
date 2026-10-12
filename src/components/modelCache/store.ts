import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeFileAtomic } from '../../utils/fsAtomic.js'
import type { BlobRegistry, CacheIndex, CacheState, SnapshotState } from './types.js'
import {
  isCommit,
  isValidRepoFilePath,
  isValidRepoId,
  isValidRevisionName,
  repoFolderName,
  safeJoin,
  SHA1_RE,
  SHA256_RE
} from './validate.js'

// On-disk layout of the cache root (see docs/modelCache.md):
//   <root>/.ocean-model-cache   sentinel written by the node
//   <root>/public/              bind-mounted read-only into services
//     hf/hub/models--org--name/{blobs,snapshots,refs}   classic huggingface_hub layout
//     index.json                                        the consumer contract
//   <root>/private/             node-only: tmp/ (partial downloads), trash/, state.json, sync.lock

export const SENTINEL = '.ocean-model-cache'
const LOCK_STALE_MS = 10 * 60 * 1000
// statfs f_type values of network filesystems the cache must not live on.
const NETWORK_FS_TYPES = new Set([
  0x6969 /* NFS */, 0xff534d42 /* CIFS */, 0xfe534d42 /* SMB2 */
])

// mkdir -p, then chmod what it created: the umask (e.g. UMask=0077 under systemd) would
// otherwise strip the bits services need to read public/.
async function mkdirp(dir: string, mode: number): Promise<void> {
  const first = await fs.promises.mkdir(dir, { recursive: true, mode })
  if (!first) return
  for (let d = dir; ; d = path.dirname(d)) {
    await fs.promises.chmod(d, mode)
    if (d === first || path.dirname(d) === d) break
  }
}

export class NotACacheDirError extends Error {}
export class CacheLockedError extends Error {
  constructor(
    message: string,
    readonly staleAt?: number // epoch ms when the current lock counts as abandoned
  ) {
    super(message)
  }
}

// A lock left by a process on this host that no longer runs, or by an earlier life of
// this very pid (a restarted container reuses its pid): nobody will release it.
function isOrphanedLock(holder: string): boolean {
  const [host, pidText] = holder.split(':')
  const pid = Number(pidText)
  if (host !== os.hostname() || !Number.isSafeInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return e?.code === 'ESRCH'
  }
}

export function emptyState(id: string): CacheState {
  return { version: 1, id, snapshots: {}, refs: {}, wanted: {} }
}

export function snapshotKey(repo: string, commit: string): string {
  return `${repo}@${commit}`
}

export class CacheStore {
  readonly publicDir: string
  readonly privateDir: string
  readonly hubDir: string
  readonly tmpDir: string
  readonly trashDir: string
  private lockToken: string | null = null

  constructor(readonly root: string) {
    this.publicDir = path.join(root, 'public')
    this.privateDir = path.join(root, 'private')
    this.hubDir = path.join(this.publicDir, 'hf', 'hub')
    this.tmpDir = path.join(this.privateDir, 'tmp')
    this.trashDir = path.join(this.privateDir, 'trash')
  }

  // The root must be an empty directory (the node then claims it) or one the node already
  // claimed. Anything else is refused: the public half is mounted into every service, so
  // the node only mounts content it put there itself.
  async prepare(): Promise<{ id: string }> {
    const entries = await fs.promises.readdir(this.root)
    let id: string
    if (entries.length === 0) {
      id = crypto.randomUUID()
      await writeFileAtomic(
        path.join(this.root, SENTINEL),
        JSON.stringify({ id, createdAt: new Date().toISOString() }) + '\n',
        { mode: 0o444 }
      )
    } else {
      try {
        const raw = JSON.parse(
          await fs.promises.readFile(path.join(this.root, SENTINEL), 'utf8')
        )
        if (typeof raw?.id !== 'string' || !raw.id) throw new Error('no id')
        id = raw.id
      } catch {
        throw new NotACacheDirError(
          `${this.root} is not empty and is not a model cache this node created ` +
            `(no valid ${SENTINEL}); point serviceModelCache.path at an empty dedicated directory`
        )
      }
    }
    await mkdirp(this.hubDir, 0o755)
    await mkdirp(this.tmpDir, 0o700)
    await mkdirp(this.trashDir, 0o700)
    await fs.promises.chmod(this.publicDir, 0o755)
    await fs.promises.chmod(this.privateDir, 0o700)
    return { id }
  }

  // ---- paths ------------------------------------------------------------------------

  repoDir(repo: string): string {
    if (!isValidRepoId(repo)) throw new Error(`invalid repo id ${repo}`)
    return safeJoin(this.hubDir, repoFolderName(repo))
  }

  blobPath(repo: string, blob: string): string {
    if (!SHA1_RE.test(blob) && !SHA256_RE.test(blob))
      throw new Error(`invalid blob ${blob}`)
    return safeJoin(this.repoDir(repo), 'blobs', blob)
  }

  snapshotDir(repo: string, commit: string): string {
    if (!isCommit(commit)) throw new Error(`invalid commit ${commit}`)
    return safeJoin(this.repoDir(repo), 'snapshots', commit)
  }

  snapshotFile(repo: string, commit: string, file: string): string {
    if (!isValidRepoFilePath(file)) throw new Error(`invalid file path ${file}`)
    return safeJoin(this.snapshotDir(repo, commit), ...file.split('/'))
  }

  refPath(repo: string, revision: string): string {
    if (!isValidRevisionName(revision)) throw new Error(`invalid revision ${revision}`)
    return safeJoin(this.repoDir(repo), 'refs', revision)
  }

  partPath(blob: string): string {
    if (!SHA1_RE.test(blob) && !SHA256_RE.test(blob))
      throw new Error(`invalid blob ${blob}`)
    return safeJoin(this.tmpDir, `${blob}.part`)
  }

  publicIndexPath(): string {
    return path.join(this.publicDir, 'index.json')
  }

  statePath(): string {
    return path.join(this.privateDir, 'state.json')
  }

  // ---- filesystem facts -------------------------------------------------------------

  async freeBytes(): Promise<number> {
    const st = await fs.promises.statfs(this.root)
    return Number(st.bavail) * Number(st.bsize)
  }

  static async isNetworkFilesystem(dir: string): Promise<boolean> {
    const st = await fs.promises.statfs(dir)
    return NETWORK_FS_TYPES.has(Number(st.type))
  }

  blobKey(repo: string, blob: string): string {
    return `${repoFolderName(repo)}/${blob}`
  }

  private async identity(p: string): Promise<{ ino: string; size: number }> {
    const st = await fs.promises.lstat(p, { bigint: true })
    return { ino: st.ino.toString(), size: Number(st.size) }
  }

  // A blob counts as present only when it is the very file the node installed there: a
  // regular file of the right size with the inode the node recorded. The directory is the
  // node's, but a bucket symlink followed by node code can still create files in it, so a
  // file the node did not install is never trusted, whatever its size.
  async hasBlob(
    repo: string,
    blob: string,
    size: number,
    registry: BlobRegistry
  ): Promise<boolean> {
    const rec = registry[this.blobKey(repo, blob)]
    if (!rec || rec.size !== size) return false
    try {
      const st = await fs.promises.lstat(this.blobPath(repo, blob), { bigint: true })
      return st.isFile() && Number(st.size) === size && st.ino.toString() === rec.ino
    } catch {
      return false
    }
  }

  // Blobs are read-only (0444): the node replaces files by rename only, so nothing that
  // merely writes through a path (a symlink planted in a bucket) can alter a verified blob.
  async installBlob(
    repo: string,
    blob: string,
    from: string,
    registry: BlobRegistry
  ): Promise<void> {
    const dest = this.blobPath(repo, blob)
    await mkdirp(path.dirname(dest), 0o755)
    await fs.promises.chmod(from, 0o444)
    await fs.promises.rename(from, dest)
    registry[this.blobKey(repo, blob)] = await this.identity(dest)
  }

  // Same content already verified in another repo: hard link it (no extra bytes), copy when
  // linking is not possible.
  async linkBlobFrom(
    repo: string,
    blob: string,
    source: string,
    size: number,
    registry: BlobRegistry
  ): Promise<void> {
    const dest = this.blobPath(repo, blob)
    await mkdirp(path.dirname(dest), 0o755)
    const tmp = safeJoin(this.tmpDir, `${blob}.link-${crypto.randomUUID()}`)
    try {
      try {
        await fs.promises.link(source, tmp)
      } catch {
        await fs.promises.copyFile(source, tmp)
        await fs.promises.chmod(tmp, 0o444)
      }
      await fs.promises.rename(tmp, dest)
      registry[this.blobKey(repo, blob)] = await this.identity(dest)
    } catch (e) {
      await fs.promises.rm(tmp, { force: true })
      // Another file of the same content got there first: that is success.
      if (!(await this.hasBlob(repo, blob, size, registry))) throw e
    }
  }

  // Drops registry entries whose file is gone or is no longer the recorded inode.
  async pruneRegistry(registry: BlobRegistry): Promise<void> {
    for (const [key, rec] of Object.entries(registry)) {
      const [folder, blob] = key.split('/')
      let keep = false
      try {
        if (
          folder.startsWith('models--') &&
          (SHA1_RE.test(blob) || SHA256_RE.test(blob))
        ) {
          const st = await fs.promises.lstat(
            safeJoin(this.hubDir, folder, 'blobs', blob),
            {
              bigint: true
            }
          )
          keep = st.isFile() && st.ino.toString() === rec.ino
        }
      } catch {
        keep = false
      }
      if (!keep) delete registry[key]
    }
  }

  // snapshots/<commit>/<file> -> relative link to ../../blobs/<blob>. Replaced through a
  // temporary link + rename when it is missing or points elsewhere.
  async linkSnapshotFile(
    repo: string,
    commit: string,
    file: string,
    blob: string
  ): Promise<void> {
    const link = this.snapshotFile(repo, commit, file)
    const blobFile = this.blobPath(repo, blob)
    const target = path.relative(path.dirname(link), blobFile)
    const resolved = path.resolve(path.dirname(link), target)
    if (resolved !== blobFile) throw new Error(`bad link target for ${file}`)
    await mkdirp(path.dirname(link), 0o755)
    try {
      const st = await fs.promises.lstat(link)
      if (st.isSymbolicLink() && (await fs.promises.readlink(link)) === target) return
    } catch {
      // missing: create it
    }
    const tmp = `${link}.tmp-${crypto.randomUUID()}`
    await fs.promises.symlink(target, tmp)
    try {
      await fs.promises.rename(tmp, link)
    } catch (e) {
      await fs.promises.rm(tmp, { force: true })
      throw e
    }
  }

  async writeRef(repo: string, revision: string, commit: string): Promise<void> {
    if (!isCommit(commit)) throw new Error(`invalid commit ${commit}`)
    const ref = this.refPath(repo, revision)
    await mkdirp(path.dirname(ref), 0o755)
    // Exactly the sha, no newline: huggingface_hub reads refs without stripping.
    await writeFileAtomic(ref, commit, { mode: 0o444 })
  }

  async removeRef(repo: string, revision: string): Promise<void> {
    await fs.promises.rm(this.refPath(repo, revision), { force: true })
  }

  async removeSnapshotFile(repo: string, commit: string, file: string): Promise<void> {
    await fs.promises.rm(this.snapshotFile(repo, commit, file), { force: true })
  }

  // Two-phase: move the snapshot out of public/ first (one rename, atomic for readers),
  // then delete it from the trash.
  async removeSnapshot(repo: string, commit: string): Promise<void> {
    const dir = this.snapshotDir(repo, commit)
    const trash = safeJoin(
      this.trashDir,
      `${repoFolderName(repo)}--${commit}-${process.pid}-${Date.now()}`
    )
    try {
      await fs.promises.rename(dir, trash)
    } catch (e) {
      if (e?.code === 'ENOENT') return
      throw e
    }
    await fs.promises.rm(trash, { recursive: true, force: true })
  }

  // Every blob some snapshot link on disk points at, as absolute paths. Read from the links
  // themselves, not from state.json, so a crash between linking and saving state can never
  // make GC delete a blob that is in use.
  async linkedBlobs(): Promise<Set<string>> {
    const live = new Set<string>()
    let repos: string[] = []
    try {
      repos = await fs.promises.readdir(this.hubDir)
    } catch {
      return live
    }
    for (const repoFolder of repos) {
      if (!repoFolder.startsWith('models--')) continue
      const snapRoot = path.join(this.hubDir, repoFolder, 'snapshots')
      const stack = [snapRoot]
      while (stack.length) {
        const dir = stack.pop()
        let entries: fs.Dirent[]
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const e of entries) {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) stack.push(p)
          else if (e.isSymbolicLink()) {
            try {
              live.add(path.resolve(dir, await fs.promises.readlink(p)))
            } catch {
              // vanished meanwhile
            }
          }
        }
      }
    }
    return live
  }

  // Deletes blob files that are neither linked from any snapshot nor in `keep` (absolute
  // paths). Returns the bytes freed (hard-linked copies count once, on the last unlink).
  async deleteUnreferencedBlobs(keep: Set<string>): Promise<number> {
    const linked = await this.linkedBlobs()
    let freed = 0
    let repos: string[] = []
    try {
      repos = await fs.promises.readdir(this.hubDir)
    } catch {
      return 0
    }
    for (const repoFolder of repos) {
      if (!repoFolder.startsWith('models--')) continue
      const blobsDir = path.join(this.hubDir, repoFolder, 'blobs')
      let blobs: string[] = []
      try {
        blobs = await fs.promises.readdir(blobsDir)
      } catch {
        continue
      }
      for (const name of blobs) {
        const p = path.join(blobsDir, name)
        if (linked.has(p) || keep.has(p)) continue
        try {
          const st = await fs.promises.lstat(p)
          await fs.promises.rm(p, { force: true })
          if (st.nlink <= 1) freed += st.size
        } catch {
          // already gone
        }
      }
    }
    return freed
  }

  // Bytes used by blobs, each inode counted once (hard links across repos share bytes).
  async blobBytes(): Promise<number> {
    const seen = new Set<string>()
    let total = 0
    let repos: string[] = []
    try {
      repos = await fs.promises.readdir(this.hubDir)
    } catch {
      return 0
    }
    for (const repoFolder of repos) {
      const blobsDir = path.join(this.hubDir, repoFolder, 'blobs')
      let blobs: string[] = []
      try {
        blobs = await fs.promises.readdir(blobsDir)
      } catch {
        continue
      }
      for (const name of blobs) {
        try {
          const st = await fs.promises.lstat(path.join(blobsDir, name))
          const key = `${st.dev}:${st.ino}`
          if (!st.isFile() || seen.has(key)) continue
          seen.add(key)
          total += st.size
        } catch {
          // vanished
        }
      }
    }
    return total
  }

  async removeStaleParts(maxAgeMs: number, keep: Set<string>): Promise<void> {
    let names: string[] = []
    try {
      names = await fs.promises.readdir(this.tmpDir)
    } catch {
      return
    }
    const now = Date.now()
    for (const name of names) {
      const p = path.join(this.tmpDir, name)
      if (keep.has(p)) continue
      try {
        const st = await fs.promises.lstat(p)
        if (now - st.mtimeMs > maxAgeMs) await fs.promises.rm(p, { force: true })
      } catch {
        // vanished
      }
    }
  }

  async emptyTrash(): Promise<void> {
    let names: string[] = []
    try {
      names = await fs.promises.readdir(this.trashDir)
    } catch {
      return
    }
    for (const name of names) {
      await fs.promises.rm(path.join(this.trashDir, name), {
        recursive: true,
        force: true
      })
    }
  }

  // ---- state + index ----------------------------------------------------------------

  async readState(id: string): Promise<CacheState> {
    let raw: any
    try {
      raw = JSON.parse(await fs.promises.readFile(this.statePath(), 'utf8'))
    } catch {
      return emptyState(id)
    }
    if (raw?.version !== 1 || raw.id !== id || typeof raw.snapshots !== 'object') {
      return emptyState(id)
    }
    return sanitizeState(raw, id)
  }

  // Takes the already-serialized state so a caller can snapshot it before awaiting.
  async writeState(stateJson: string): Promise<void> {
    await writeFileAtomic(this.statePath(), stateJson, { mode: 0o400 })
  }

  async writeIndex(indexJson: string): Promise<void> {
    await writeFileAtomic(this.publicIndexPath(), indexJson, { mode: 0o444 })
  }

  // ---- cross-process lock -----------------------------------------------------------

  async acquireLock(): Promise<void> {
    const lock = path.join(this.privateDir, 'sync.lock')
    const token = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await fs.promises.open(lock, 'wx', 0o400)
        await fh.writeFile(token)
        await fh.close()
        this.lockToken = token
        return
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e
        const st = await fs.promises.stat(lock).catch((): null => null)
        const holder = await fs.promises.readFile(lock, 'utf8').catch(() => '')
        if (!st || Date.now() - st.mtimeMs > LOCK_STALE_MS || isOrphanedLock(holder)) {
          await fs.promises.rm(lock, { force: true })
          continue
        }
        throw new CacheLockedError(
          `${this.root} is being synced by another process`,
          st.mtimeMs + LOCK_STALE_MS
        )
      }
    }
    throw new CacheLockedError(`${this.root} is being synced by another process`)
  }

  async refreshLock(): Promise<void> {
    if (!this.lockToken) return
    const now = new Date()
    await fs.promises
      .utimes(path.join(this.privateDir, 'sync.lock'), now, now)
      .catch(() => {})
  }

  async releaseLock(): Promise<void> {
    if (!this.lockToken) return
    const lock = path.join(this.privateDir, 'sync.lock')
    try {
      if ((await fs.promises.readFile(lock, 'utf8')) === this.lockToken) {
        await fs.promises.rm(lock, { force: true })
      }
    } catch {
      // gone already
    }
    this.lockToken = null
  }
}

// Drops anything in a loaded state.json that would not pass the checks it passed when it
// was written: GC deletes paths built from these values.
function sanitizeState(raw: any, id: string): CacheState {
  const state = emptyState(id)
  for (const [key, snap] of Object.entries<any>(raw.snapshots ?? {})) {
    if (
      !snap ||
      !isValidRepoId(snap.repo) ||
      !isCommit(snap.commit) ||
      key !== snapshotKey(snap.repo, snap.commit)
    ) {
      continue
    }
    const files: SnapshotState['files'] = {}
    for (const [file, f] of Object.entries<any>(snap.files ?? {})) {
      if (
        isValidRepoFilePath(file) &&
        f &&
        (SHA1_RE.test(f.blob) || SHA256_RE.test(f.blob)) &&
        Number.isSafeInteger(f.size)
      ) {
        files[file] = {
          blob: f.blob,
          size: f.size,
          lfs: f.lfs === true,
          ...(typeof f.retiredAt === 'string' ? { retiredAt: f.retiredAt } : {}),
          ...(f.present === true ? { present: true } : {})
        }
      }
    }
    state.snapshots[key] = {
      repo: snap.repo,
      commit: snap.commit,
      complete: snap.complete === true,
      selection: snap.selection ?? { kind: 'all' },
      files,
      ...(typeof snap.publishedAt === 'string' ? { publishedAt: snap.publishedAt } : {}),
      ...(typeof snap.retiredAt === 'string' ? { retiredAt: snap.retiredAt } : {})
    }
  }
  for (const [repo, refs] of Object.entries<any>(raw.refs ?? {})) {
    if (!isValidRepoId(repo) || !refs || typeof refs !== 'object') continue
    for (const [rev, commit] of Object.entries<any>(refs)) {
      if (isValidRevisionName(rev) && isCommit(commit)) {
        state.refs[repo] = { ...(state.refs[repo] ?? {}), [rev]: commit }
      }
    }
  }
  if (raw.wanted && typeof raw.wanted === 'object') state.wanted = raw.wanted
  if (Array.isArray(raw.lastGoodTemplateSpecs)) {
    state.lastGoodTemplateSpecs = raw.lastGoodTemplateSpecs.filter(isSaneSpec)
    state.lastGoodTemplateSpecsAt = raw.lastGoodTemplateSpecsAt
  }
  state.blobs = {}
  for (const [key, rec] of Object.entries<any>(raw.blobs ?? {})) {
    const [folder, blob, extra] = key.split('/')
    if (
      extra === undefined &&
      typeof folder === 'string' &&
      folder.startsWith('models--') &&
      (SHA1_RE.test(blob) || SHA256_RE.test(blob)) &&
      typeof rec?.ino === 'string' &&
      /^\d+$/.test(rec.ino) &&
      Number.isSafeInteger(rec.size)
    ) {
      state.blobs[key] = { ino: rec.ino, size: rec.size }
    }
  }
  return state
}

function isSaneSpec(s: any): boolean {
  const sel = s?.selection
  const selectionOk =
    sel?.kind === 'all' ||
    (sel?.kind === 'files' &&
      Array.isArray(sel.files) &&
      sel.files.every((f: unknown) => isValidRepoFilePath(f))) ||
    (sel?.kind === 'patterns' &&
      Array.isArray(sel.patterns) &&
      sel.patterns.every((p: unknown) => typeof p === 'string'))
  return (
    isValidRepoId(s?.repo) &&
    (isCommit(s?.revision) || isValidRevisionName(s?.revision)) &&
    (s.commit === undefined || isCommit(s.commit)) &&
    selectionOk &&
    Number.isFinite(s.priority) &&
    Array.isArray(s.sources)
  )
}

export function buildIndex(state: CacheState, generatedAt: string): CacheIndex {
  const index: CacheIndex = { version: 1, generatedAt, repos: {} }
  const repoEntry = (repo: string) =>
    (index.repos[repo] ??= { refs: {}, wanted: {}, snapshots: {} })
  for (const snap of Object.values(state.snapshots)) {
    if (!snap.publishedAt || snap.retiredAt) continue
    const files: Record<string, number> = {}
    let allPresent = true
    for (const [file, f] of Object.entries(snap.files)) {
      if (f.retiredAt) {
        allPresent = false
        continue
      }
      if (!f.present) {
        allPresent = false
        continue
      }
      files[file] = f.size
    }
    const selection =
      snap.selection.kind === 'all'
        ? null
        : snap.selection.kind === 'patterns'
          ? { allowPatterns: snap.selection.patterns }
          : { files: snap.selection.files }
    repoEntry(snap.repo).snapshots[snap.commit] = {
      path: `hf/hub/${repoFolderName(snap.repo)}/snapshots/${snap.commit}`,
      complete: snap.complete && allPresent,
      selection: snap.complete ? null : selection,
      files
    }
  }
  for (const [repo, refs] of Object.entries(state.refs)) {
    for (const [rev, commit] of Object.entries(refs)) {
      if (index.repos[repo]?.snapshots[commit]) repoEntry(repo).refs[rev] = commit
    }
  }
  for (const [repo, revs] of Object.entries(state.wanted)) {
    if (!isValidRepoId(repo)) continue
    repoEntry(repo).wanted = structuredClone(revs)
  }
  return index
}
