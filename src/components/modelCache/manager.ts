import fs from 'fs'
import os from 'os'
import path from 'path'
import pLimit from 'p-limit'
import type { OceanNodeConfig } from '../../@types/OceanNode.js'
import type { ServiceJob, ServiceTemplate } from '../../@types/C2D/ServiceOnDemand.js'
import { ServiceStatusNumber } from '../../@types/C2D/ServiceOnDemand.js'
import {
  loadServiceTemplates,
  type TemplateLoadDiagnostics
} from '../core/service/templateLoader.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { applyCurated, deriveTemplateSpecs, mergeSelection } from './derive.js'
import { compileAllowPatterns } from './fnmatch.js'
import { HfClient, HfError, type HfClientOptions } from './hfClient.js'
import { buildIndex, CacheLockedError, CacheStore, snapshotKey } from './store.js'
import type {
  CacheState,
  FileSelection,
  HfSibling,
  ModelCacheMountVerdict,
  ModelCacheStatus,
  ModelSpec,
  ServiceModelCacheConfig,
  WantedState
} from './types.js'
import { isCommit, pathsOverlap } from './validate.js'

const LOG = '[modelCache]'
const GB = 1e9
const DEFAULT_MIN_FREE_GB = 100
const DEFAULT_INTERVAL_MIN = 60
const DEFAULT_GRACE_HOURS = 24
// Files downloaded at once. The Hub serves ~40 MB/s per connection (measured on cp1), so a
// few in parallel fill a fast link; more only adds sockets and disk seeks.
const PARALLEL_FILES = 8
const PROGRESS_LOG_MS = 5 * 60 * 1000
const STALE_PART_MS = 48 * 3600 * 1000
const STOP_WAIT_MS = 5000
const LOCK_RETRY_SLACK_MS = 5000

// A service in one of these states may still have a container reading the cache.
const LIVE_STATUSES = new Set<number>([
  ServiceStatusNumber.Starting,
  ServiceStatusNumber.PullImage,
  ServiceStatusNumber.BuildImage,
  ServiceStatusNumber.Locking,
  ServiceStatusNumber.Claiming,
  ServiceStatusNumber.Running,
  ServiceStatusNumber.Restarting,
  ServiceStatusNumber.Stopping
])

// Wanted entries whose currently published commit must stay on disk.
const KEEPS_SERVED = new Set(['ok', 'downloading', 'deferred:budget', 'error'])

class RunInterrupted extends Error {}
class DiskFloorReached extends Error {}
// A spec problem whose message is safe to publish (no paths, no secrets).
class SpecError extends Error {}

// The Hub token, read at use time. A value with whitespace or control characters inside
// (a pasted multi-line secret) is ignored: fetch would echo it back in its error message.
let warnedBadToken = false
function hubToken(): string | undefined {
  const t = process.env.SERVICE_MODEL_CACHE_HF_TOKEN?.trim()
  if (!t) return undefined
  if (!/^[\x21-\x7e]+$/.test(t)) {
    if (!warnedBadToken) {
      CORE_LOGGER.warn(`${LOG} SERVICE_MODEL_CACHE_HF_TOKEN is malformed; ignored`)
      warnedBadToken = true
    }
    return undefined
  }
  return t
}

export interface SelfInspection {
  Mounts?: Array<{ Source?: string; Destination?: string; RW?: boolean }>
}

export interface ModelCacheManagerDeps {
  getConfig: () => OceanNodeConfig | undefined
  // Service jobs that may still hold a container (for GC liveness). Without it, nothing
  // retired is ever deleted.
  getServiceJobs?: () => Promise<ServiceJob[]>
  getEngineStoragePaths?: () => string[]
  loadTemplates?: (
    dir: string | undefined,
    diag: TemplateLoadDiagnostics
  ) => Promise<ServiceTemplate[]>
  // The node's own container as dockerd sees it; null when the node is not containerized.
  inspectSelf?: () => Promise<SelfInspection | null>
  hf?: HfClientOptions
  initialDelayMs?: number
  chunkBytes?: number
}

interface PlannedFile {
  blob: string
  size: number
  lfs: boolean
}

interface Plan {
  key: string
  repo: string
  commit: string
  complete: boolean
  selection: FileSelection
  files: Map<string, PlannedFile>
  priority: number
  revisions: Set<string> // ref names this plan publishes (not commit-revisions)
  specs: ModelSpec[]
}

// A wanted spec whose Hub lookup failed this run: whatever it serves stays served.
interface ErroredSpec {
  repo: string
  revision: string
  priority: number
  commit?: string // the commit it currently serves, if any
}

interface RunContext {
  gen: number
  cfg: ServiceModelCacheConfig
  store: CacheStore
  state: CacheState
  signal: AbortSignal
  inflightRemaining: Map<string, number>
  blobJobs: Map<string, Promise<string>>
  downloaded: number
  lastProgressLog: number
  diskFloor: boolean
  persistChain: Promise<void>
}

export function selectFiles(
  siblings: HfSibling[],
  selection: FileSelection
): { files: HfSibling[]; missing: string[] } {
  if (selection.kind === 'all') return { files: siblings, missing: [] }
  if (selection.kind === 'patterns') {
    const matches = compileAllowPatterns(selection.patterns)
    return { files: siblings.filter((s) => matches(s.rfilename)), missing: [] }
  }
  const byName = new Map(siblings.map((s) => [s.rfilename, s]))
  const files: HfSibling[] = []
  const missing: string[] = []
  for (const f of selection.files) {
    const s = byName.get(f)
    if (s) files.push(s)
    else missing.push(f)
  }
  return { files, missing }
}

// dockerd resolves a bind Source on the HOST. The node checks the cache root inside its own
// container, so the root must be bound into the node at the identical path: the mount that
// holds the root must map Source + rest == root.
export function hostPathVisible(real: string, inspection: SelfInspection): boolean {
  const mounts = (inspection.Mounts ?? []).filter(
    (m) =>
      typeof m.Destination === 'string' &&
      typeof m.Source === 'string' &&
      (real === m.Destination || real.startsWith(m.Destination.replace(/\/$/, '') + '/'))
  )
  mounts.sort((a, b) => b.Destination.length - a.Destination.length)
  const m = mounts[0]
  if (!m) return false
  return m.Source + real.slice(m.Destination.length) === real && m.RW !== false
}

// A message safe to publish in index.json (mounted into every service): Hub errors are
// already "repo@sha/file: what"; anything else (fs errors carry host paths) is reduced to
// its code.
function publicError(e: any, plan: Plan): string {
  if (e instanceof HfError) return e.message
  return `${plan.repo}@${plan.commit.slice(0, 12)}: ${e?.code ?? 'internal error'}`
}

export class ModelCacheManager {
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null
  private rerun = false
  private generation = 0
  private abortController: AbortController | null = null
  private started = false
  private stopped = false
  private verdict: ModelCacheMountVerdict | null = null
  private mountBroken = false
  private nextRunAt: number | null = null
  private status: ModelCacheStatus = { state: 'disabled' }
  private readonly hf: HfClient

  constructor(private readonly deps: ModelCacheManagerDeps) {
    this.hf = new HfClient({
      token: hubToken,
      ...deps.hf
    })
  }

  // ---- lifecycle ----------------------------------------------------------------------

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    const config = this.deps.getConfig() as unknown as Record<string, unknown> | undefined
    for (const key of Object.keys(config ?? {})) {
      if (key !== 'serviceModelCache' && /model.?cache/i.test(key)) {
        CORE_LOGGER.warn(
          `${LOG} config key "${key}" is ignored; did you mean serviceModelCache?`
        )
      }
    }
    // Verify the directory right away so services started in the first minutes after a
    // boot already get the mount; the first full sync still waits for initialDelayMs.
    const cfg = this.liveCacheConfig()
    if (cfg?.enabled && cfg.path && cfg.maxSizeGb) {
      this.verifyRoot(cfg).catch((e) => CORE_LOGGER.warn(`${LOG} ${e.message}`))
    }
    this.schedule(this.deps.initialDelayMs ?? 120_000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.abortController?.abort()
    if (this.inFlight) {
      let t: NodeJS.Timeout
      await Promise.race([
        this.inFlight.catch(() => {}),
        new Promise<void>((resolve) => {
          t = setTimeout(resolve, STOP_WAIT_MS)
        })
      ])
      clearTimeout(t)
    }
  }

  // Starts a sync now: a running one stops at once (partial downloads are kept and resume)
  // and a new one starts with the live config.
  trigger(): void {
    if (this.stopped) return
    this.generation++
    if (this.inFlight) {
      this.rerun = true
      this.abortController?.abort()
      return
    }
    void this.runNow()
  }

  runNow(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true
      return this.inFlight
    }
    this.inFlight = (async () => {
      try {
        do {
          this.rerun = false
          try {
            await this.runOnce()
          } catch (e) {
            this.status = {
              ...this.status,
              state: 'error',
              error: e?.message ?? String(e)
            }
            CORE_LOGGER.error(`${LOG} sync failed: ${e?.message ?? e}`)
          }
        } while (this.rerun && !this.stopped)
      } finally {
        this.inFlight = null
        const minutes =
          this.liveCacheConfig()?.syncIntervalMinutes ?? DEFAULT_INTERVAL_MIN
        let delay = minutes * 60_000
        if (this.nextRunAt !== null) {
          delay = Math.min(delay, Math.max(1000, this.nextRunAt - Date.now()))
          this.nextRunAt = null
        }
        this.schedule(delay)
      }
    })()
    return this.inFlight
  }

  private schedule(ms: number): void {
    if (this.stopped || !this.started) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runNow()
    }, ms)
    this.timer.unref?.()
  }

  // ---- what the mount helper asks -----------------------------------------------------

  getMountVerdict(): ModelCacheMountVerdict | null {
    return this.verdict
  }

  isMountBroken(): boolean {
    return this.mountBroken
  }

  // dockerd refused a container with the cache mount: stop offering it until the next
  // sync has verified the root again.
  markMountBroken(reason: string): void {
    if (!this.mountBroken) {
      CORE_LOGGER.error(
        `${LOG} dockerd rejected the cache mount (${reason}); services start without it ` +
          'until the next sync verifies the cache path again'
      )
    }
    this.mountBroken = true
  }

  getStatus(): ModelCacheStatus {
    return { ...this.status }
  }

  private liveCacheConfig(): ServiceModelCacheConfig | undefined {
    try {
      return this.deps.getConfig()?.serviceModelCache
    } catch {
      return undefined
    }
  }

  // ---- one sync run -------------------------------------------------------------------

  private async runOnce(): Promise<void> {
    const gen = this.generation
    const cfg = this.liveCacheConfig()
    if (!cfg?.enabled || !cfg.path || !cfg.maxSizeGb) {
      this.verdict = null
      this.status = { state: 'disabled' }
      return
    }
    const startedAt = new Date().toISOString()
    this.status = { state: 'running', lastRunStartedAt: startedAt }

    let store: CacheStore
    let id: string
    try {
      ;({ store, id } = await this.verifyRoot(cfg))
    } catch (e) {
      this.verdict = null
      this.status = { state: 'error', error: e.message, lastRunStartedAt: startedAt }
      CORE_LOGGER.error(`${LOG} ${e.message}`)
      return
    }

    try {
      await store.acquireLock()
    } catch (e) {
      if (!(e instanceof CacheLockedError)) throw e
      CORE_LOGGER.warn(`${LOG} ${e.message}; skipping this run`)
      this.status = { state: 'idle', error: e.message, lastRunStartedAt: startedAt }
      // Retry as soon as that lock counts as abandoned, not a whole interval later.
      if (e.staleAt) this.nextRunAt = e.staleAt + LOCK_RETRY_SLACK_MS
      return
    }
    const lockTimer = setInterval(() => void store.refreshLock(), 60_000)
    lockTimer.unref?.()
    const abort = new AbortController()
    this.abortController = abort
    const ctx: RunContext = {
      gen,
      cfg,
      store,
      state: await store.readState(id),
      signal: abort.signal,
      inflightRemaining: new Map(),
      blobJobs: new Map(),
      downloaded: 0,
      lastProgressLog: Date.now(),
      diskFloor: false,
      persistChain: Promise.resolve()
    }
    let frozen = false
    let interrupted = false
    try {
      const wanted = await this.wantedSpecs(ctx)
      frozen = wanted.frozen
      const { plans, errored } = await this.resolvePlans(ctx, wanted.specs)
      const accepted = this.applyBudget(ctx, plans, errored)
      // Write ahead: every snapshot this run may create is in state.json before its first
      // link exists, so a crash mid-run never leaves links GC does not know about.
      for (const plan of accepted) this.prepareSnapshot(ctx, plan)
      await this.persist(ctx)
      await Promise.allSettled(accepted.map((plan) => this.downloadPlan(ctx, plan)))
      this.checkInterrupted(ctx)
      if (frozen) {
        CORE_LOGGER.warn(
          `${LOG} templates did not load cleanly; nothing is retired this run`
        )
      } else {
        await this.collectGarbage(ctx, accepted)
      }
    } catch (e) {
      if (e instanceof RunInterrupted || abort.signal.aborted) {
        interrupted = true
        CORE_LOGGER.info(`${LOG} sync interrupted (${e.message}); progress kept`)
      } else {
        throw e
      }
    } finally {
      clearInterval(lockTimer)
      this.abortController = null
      await ctx.persistChain.catch(() => {})
      try {
        await this.persist(ctx)
      } catch (e) {
        CORE_LOGGER.error(`${LOG} cannot save state: ${e.message}`)
      }
      await store.releaseLock()
    }

    const published = Object.values(ctx.state.snapshots).filter(
      (s) => s.publishedAt && !s.retiredAt
    ).length
    const bytesOnDisk = await store.blobBytes()
    const statuses = Object.values(ctx.state.wanted).flatMap((revs) =>
      Object.values(revs)
    )
    const notOk = statuses.filter((w) => w.status !== 'ok')
    this.status = {
      state: 'idle',
      lastRunStartedAt: startedAt,
      lastRunFinishedAt: new Date().toISOString(),
      templatesFrozen: frozen,
      wanted: statuses.length,
      published,
      bytesOnDisk,
      downloadedBytes: ctx.downloaded
    }
    if (!interrupted) {
      CORE_LOGGER.info(
        `${LOG} sync done: ${statuses.length} wanted, ${published} published, ` +
          `${(bytesOnDisk / GB).toFixed(1)} GB on disk, ` +
          `${(ctx.downloaded / GB).toFixed(1)} GB downloaded` +
          (notOk.length ? `, not ready: ${notOk.map((w) => w.status).join(', ')}` : '') +
          (ctx.diskFloor ? ', paused at the disk floor (minFreeGb)' : '')
      )
    }
  }

  // Root checks, every run. Sets the mount verdict only when all of them pass. Nothing is
  // written to the directory until every check that does not need to write has passed.
  private async verifyRoot(
    cfg: ServiceModelCacheConfig
  ): Promise<{ store: CacheStore; id: string }> {
    if (!path.isAbsolute(cfg.path)) {
      throw new Error('serviceModelCache.path must be absolute')
    }
    let real: string
    try {
      real = await fs.promises.realpath(cfg.path)
    } catch {
      throw new Error(`serviceModelCache.path ${cfg.path} does not exist`)
    }
    const st = await fs.promises.stat(real)
    if (!st.isDirectory())
      throw new Error(`serviceModelCache.path ${real} is not a directory`)
    try {
      await fs.promises.access(real, fs.constants.R_OK | fs.constants.W_OK)
    } catch {
      throw new Error(
        `serviceModelCache.path ${real} is not writable by the node (uid ${process.getuid?.()})`
      )
    }
    if (real === '/') throw new Error('serviceModelCache.path cannot be /')
    if (await CacheStore.isNetworkFilesystem(real)) {
      throw new Error(
        `serviceModelCache.path ${real} is on a network filesystem; it must be local disk`
      )
    }
    for (const p of await this.protectedPaths()) {
      if (pathsOverlap(real, p)) {
        throw new Error(
          `serviceModelCache.path ${real} overlaps ${p}; use a dedicated directory ` +
            '(it is mounted into every service)'
        )
      }
    }
    if (this.deps.inspectSelf) {
      let self: SelfInspection | null = null
      try {
        self = await this.deps.inspectSelf()
      } catch (e) {
        throw new Error(
          `cannot inspect the node container to check the cache path: ${e.message}`
        )
      }
      if (self && !hostPathVisible(real, self)) {
        throw new Error(
          `serviceModelCache.path ${real} is not bound into the node container at the same ` +
            'host path (read-write); dockerd could not mount it into services'
        )
      }
    }
    const store = new CacheStore(real)
    const { id } = await store.prepare()
    const pub = await fs.promises.lstat(store.publicDir)
    this.verdict = {
      configuredPath: cfg.path,
      publicRealpath: store.publicDir,
      dev: pub.dev,
      ino: pub.ino
    }
    this.mountBroken = false
    return { store, id }
  }

  private async protectedPaths(): Promise<string[]> {
    const config = this.deps.getConfig()
    const cwd = process.cwd()
    const configFile = process.env.CONFIG_PATH
      ? path.resolve(process.env.CONFIG_PATH)
      : path.join(cwd, 'config.json')
    const storage = config?.persistentStorage?.options as { folder?: unknown } | undefined
    const candidates = [
      cwd,
      path.join(cwd, 'databases'),
      os.homedir(),
      path.dirname(configFile),
      config?.serviceTemplatesPath
        ? path.resolve(cwd, config.serviceTemplatesPath)
        : null,
      typeof storage?.folder === 'string' ? path.resolve(cwd, storage.folder) : null,
      config?.httpCertPath ? path.dirname(path.resolve(cwd, config.httpCertPath)) : null,
      config?.httpKeyPath ? path.dirname(path.resolve(cwd, config.httpKeyPath)) : null,
      ...(this.deps.getEngineStoragePaths?.() ?? []).map((p) => path.resolve(cwd, p))
    ].filter((p): p is string => typeof p === 'string' && p.length > 0)
    const out: string[] = []
    for (const p of candidates) {
      out.push(await fs.promises.realpath(p).catch(() => p))
    }
    return out
  }

  private checkInterrupted(ctx: RunContext): void {
    if (this.stopped) throw new RunInterrupted('node stopping')
    if (this.generation !== ctx.gen) throw new RunInterrupted('config changed')
    const live = this.liveCacheConfig()
    if (!live?.enabled || live.path !== ctx.cfg.path) {
      throw new RunInterrupted('cache disabled or path changed')
    }
  }

  // Template-derived specs (plus the last good ones when the templates did not load
  // cleanly, so a broken catalogue mount never retires 1 TB), then curated entries on top.
  private async wantedSpecs(
    ctx: RunContext
  ): Promise<{ specs: ModelSpec[]; frozen: boolean }> {
    const { cfg, state } = ctx
    let templateSpecs: ModelSpec[] = []
    let frozen = false
    if (cfg.fromTemplates !== false) {
      const diag: TemplateLoadDiagnostics = { errors: [] }
      const templates = await (this.deps.loadTemplates ?? loadServiceTemplates)(
        this.deps.getConfig()?.serviceTemplatesPath,
        diag
      )
      const derived = deriveTemplateSpecs(templates, cfg.includeUnlisted !== false)
      for (const p of derived.problems) CORE_LOGGER.warn(`${LOG} ${p}`)
      const lastGood = state.lastGoodTemplateSpecs ?? []
      const unhealthy =
        diag.errors.length > 0 || (templates.length === 0 && lastGood.length > 0)
      if (unhealthy && lastGood.length > 0) {
        frozen = true
        CORE_LOGGER.warn(
          `${LOG} templates loaded with problems (${diag.errors.slice(0, 5).join('; ')}); ` +
            'keeping the previous template models'
        )
        // Merge per (repo, revision): a spec the loaded templates also name keeps
        // everything the last good set wanted from it.
        const merged = new Map<string, ModelSpec>()
        for (const spec of [...derived.specs, ...lastGood]) {
          const key = `${spec.repo}@${spec.revision}`
          const e = merged.get(key)
          if (!e) {
            merged.set(key, { ...spec, sources: [...spec.sources] })
          } else {
            e.selection = mergeSelection(e.selection, spec.selection)
            e.priority = Math.min(e.priority, spec.priority)
            e.sources = [...new Set([...e.sources, ...spec.sources])]
          }
        }
        templateSpecs = [...merged.values()].sort((a, b) => a.priority - b.priority)
      } else {
        templateSpecs = derived.specs
      }
      state.lastGoodTemplateSpecs = templateSpecs
      state.lastGoodTemplateSpecsAt = new Date().toISOString()
      CORE_LOGGER.debug(
        `${LOG} ${templates.length} templates loaded, ${templateSpecs.length} model specs`
      )
    }
    const { specs, problems } = applyCurated(templateSpecs, cfg.curated ?? [])
    for (const p of problems) CORE_LOGGER.warn(`${LOG} ${p}`)
    return { specs, frozen }
  }

  // One Hub API call per spec; specs that resolve to the same (repo, commit) share a plan.
  private async resolvePlans(
    ctx: RunContext,
    specs: ModelSpec[]
  ): Promise<{ plans: Plan[]; errored: ErroredSpec[] }> {
    const { state } = ctx
    const plans = new Map<string, Plan>()
    const errored: ErroredSpec[] = []
    // Built aside and swapped in at the end: an interrupted resolve must leave the previous
    // map (with the targets of unfinished downloads) in place, not an empty one.
    const previous = state.wanted
    const next: CacheState['wanted'] = {}
    for (const spec of specs) {
      this.checkInterrupted(ctx)
      const setStatus = (w: WantedState) => {
        ;(next[spec.repo] ??= {})[spec.revision] = w
      }
      const published = isCommit(spec.revision)
        ? spec.revision
        : state.refs[spec.repo]?.[spec.revision]
      try {
        const { info, skipped } = await this.hf.getRevisionInfo(
          spec.repo,
          spec.commit ?? spec.revision,
          ctx.signal
        )
        if (skipped.length) {
          CORE_LOGGER.warn(
            `${LOG} ${spec.repo}: ignoring ${skipped.length} file(s) with unusable names ` +
              'or hashes; the snapshot will not count as complete'
          )
        }
        if (info.disabled) {
          setStatus({ status: 'skipped:disabled', missingBytes: 0 })
          continue
        }
        if (info.private) {
          setStatus({ status: 'skipped:private', missingBytes: 0 })
          continue
        }
        if (info.gated !== false) {
          setStatus({ status: 'skipped:gated', missingBytes: 0 })
          continue
        }
        if (spec.commit && info.sha !== spec.commit) {
          throw new SpecError(
            `asked for commit ${spec.commit}, the Hub answered ${info.sha}`
          )
        }
        const { files, missing } = selectFiles(info.siblings, spec.selection)
        if (missing.length) {
          CORE_LOGGER.warn(
            `${LOG} ${spec.repo}@${info.sha.slice(0, 12)}: not in the repo: ${missing.join(', ')}`
          )
        }
        if (!files.length)
          throw new SpecError('the selection matches no file of the repo')
        const key = snapshotKey(spec.repo, info.sha)
        let plan = plans.get(key)
        if (!plan) {
          plan = {
            key,
            repo: spec.repo,
            commit: info.sha,
            complete: false,
            selection: spec.selection,
            files: new Map(),
            priority: spec.priority,
            revisions: new Set(),
            specs: []
          }
          plans.set(key, plan)
        } else {
          plan.selection = mergeSelection(plan.selection, spec.selection)
          plan.priority = Math.min(plan.priority, spec.priority)
        }
        if (spec.selection.kind === 'all' && skipped.length === 0) plan.complete = true
        for (const f of files) {
          plan.files.set(f.rfilename, {
            blob: f.lfs ? f.lfs.sha256 : f.blobId,
            size: f.size,
            lfs: !!f.lfs
          })
        }
        if (!isCommit(spec.revision)) plan.revisions.add(spec.revision)
        plan.specs.push(spec)
        // Already served at this commit: ok now, downloadPlan downgrades it on failure.
        setStatus({
          sha: info.sha,
          status: published === info.sha ? 'ok' : 'downloading',
          missingBytes: 0
        })
      } catch (e) {
        if (ctx.signal.aborted || e instanceof RunInterrupted) {
          throw new RunInterrupted('aborted')
        }
        // An API failure never retires anything: the last published commit stays served,
        // and an unfinished download keeps its target (its verified files stay on disk).
        const target = previous[spec.repo]?.[spec.revision]?.sha
        // index.json is readable by every service: only messages known to be safe go there
        // (and into the log), anything else is reduced to its code.
        const message =
          e instanceof HfError
            ? e.message
            : `${spec.repo}@${spec.revision}: ${
                e instanceof SpecError
                  ? e.message
                  : (e?.code ?? e?.name ?? 'internal error')
              }`
        setStatus({
          ...(target || published ? { sha: target ?? published } : {}),
          status: 'error',
          missingBytes: 0,
          error: message
        })
        errored.push({
          repo: spec.repo,
          revision: spec.revision,
          priority: spec.priority,
          ...(published ? { commit: published } : {})
        })
        CORE_LOGGER.warn(`${LOG} ${message}`)
      }
    }
    state.wanted = next
    return { plans: [...plans.values()].sort((a, b) => a.priority - b.priority), errored }
  }

  // The present, non-retired files of a snapshot, as budget entries.
  private servedFiles(
    ctx: RunContext,
    repo: string,
    commit: string
  ): Array<[string, number]> {
    const snap = ctx.state.snapshots[snapshotKey(repo, commit)]
    if (!snap?.publishedAt || snap.retiredAt) return []
    return Object.values(snap.files)
      .filter((f) => f.present && !f.retiredAt)
      .map((f) => [f.blob, f.size])
  }

  // Walks wanted entries by priority and accepts what fits in maxSizeGb, counting every
  // blob once. What an entry currently serves is booked with it: a plan that does not fit
  // keeps serving that (deferred:budget) when the served part alone still fits, otherwise
  // it is skipped:budget and whatever it served is retired. Entries whose Hub lookup failed
  // keep serving what they serve and book it unconditionally.
  private applyBudget(ctx: RunContext, plans: Plan[], errored: ErroredSpec[]): Plan[] {
    const { state, cfg } = ctx
    const maxBytes = cfg.maxSizeGb * GB
    const counted = new Map<string, number>()
    let total = 0
    const bytesOf = (blobs: Array<[string, number]>) => {
      let extra = 0
      const seen = new Set<string>()
      for (const [b, s] of blobs) {
        if (counted.has(b) || seen.has(b)) continue
        seen.add(b)
        extra += s
      }
      return extra
    }
    const count = (blobs: Array<[string, number]>) => {
      for (const [b, s] of blobs) {
        if (counted.has(b)) continue
        counted.set(b, s)
        total += s
      }
    }
    type Item = { priority: number; plan?: Plan; errored?: ErroredSpec }
    const items: Item[] = [
      ...plans.map((plan) => ({ priority: plan.priority, plan })),
      ...errored.map((e) => ({ priority: e.priority, errored: e }))
    ].sort((a, b) => a.priority - b.priority)
    const accepted: Plan[] = []
    for (const item of items) {
      if (item.errored) {
        if (item.errored.commit) {
          count(this.servedFiles(ctx, item.errored.repo, item.errored.commit))
        }
        continue
      }
      const { plan } = item
      const planBlobs: Array<[string, number]> = [...plan.files.values()].map((f) => [
        f.blob,
        f.size
      ])
      const served: Array<[string, number]> = []
      const servedCommits = new Set<string>()
      for (const rev of plan.revisions) {
        const c = state.refs[plan.repo]?.[rev]
        if (c) servedCommits.add(c)
      }
      if (plan.revisions.size === 0) servedCommits.add(plan.commit)
      for (const c of servedCommits) served.push(...this.servedFiles(ctx, plan.repo, c))

      if (total + bytesOf([...planBlobs, ...served]) <= maxBytes) {
        count([...planBlobs, ...served])
        accepted.push(plan)
        continue
      }
      let status: WantedState['status'] = 'skipped:budget'
      if (served.length && total + bytesOf(served) <= maxBytes) {
        count(served)
        status = 'deferred:budget'
      }
      for (const spec of plan.specs) {
        const w = state.wanted[spec.repo]?.[spec.revision]
        if (w) {
          w.status = status
          w.missingBytes = bytesOf(planBlobs)
        }
      }
      CORE_LOGGER.warn(
        `${LOG} ${plan.repo}@${plan.commit.slice(0, 12)}: ${status} ` +
          `(maxSizeGb ${cfg.maxSizeGb} reached)`
      )
    }
    return accepted
  }

  private prepareSnapshot(ctx: RunContext, plan: Plan): void {
    const snap = (ctx.state.snapshots[plan.key] ??= {
      repo: plan.repo,
      commit: plan.commit,
      complete: plan.complete,
      selection: plan.selection,
      files: {}
    })
    if (!snap.publishedAt) {
      snap.complete = plan.complete
      snap.selection = plan.complete ? { kind: 'all' } : plan.selection
    } else if (plan.complete) {
      snap.complete = true
      snap.selection = { kind: 'all' }
    } else if (!snap.complete) {
      // A published snapshot may still be served whole by another revision: only widen it
      // here; collectGarbage narrows it once nothing else needs more.
      snap.selection = mergeSelection(snap.selection, plan.selection)
    }
    if (snap.retiredAt) {
      // GC may have deleted its files after its last saved state: verify them again.
      for (const f of Object.values(snap.files)) delete f.present
      delete snap.retiredAt
    }
    for (const [file, f] of plan.files) {
      const existing = snap.files[file]
      if (existing && existing.blob === f.blob) {
        if (existing.retiredAt) {
          delete existing.retiredAt
          delete existing.present
        }
      } else {
        snap.files[file] = { blob: f.blob, size: f.size, lfs: f.lfs }
      }
    }
  }

  private async downloadPlan(ctx: RunContext, plan: Plan): Promise<void> {
    const { state, store } = ctx
    const snap = state.snapshots[plan.key]
    const limit = this.fileLimit(ctx)
    const results = await Promise.allSettled(
      [...plan.files.entries()]
        .sort((a, b) => b[1].size - a[1].size)
        .map(([file, f]) => limit(() => this.ensureFile(ctx, plan, file, f)))
    )
    const failed = results.filter(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult[]
    if (failed.length === 0) {
      snap.publishedAt ??= new Date().toISOString()
      for (const rev of plan.revisions) (state.refs[plan.repo] ??= {})[rev] = plan.commit
      for (const spec of plan.specs) {
        const w = state.wanted[spec.repo]?.[spec.revision]
        if (w) {
          w.status = 'ok'
          w.missingBytes = 0
          delete w.error
        }
      }
      // state.json and index.json first, refs files after: a crash in between leaves a
      // state that still knows the snapshot, and the next run rewrites the refs.
      await this.queuePersist(ctx)
      for (const rev of plan.revisions) await store.writeRef(plan.repo, rev, plan.commit)
      CORE_LOGGER.info(`${LOG} published ${plan.repo}@${plan.commit.slice(0, 12)}`)
      return
    }
    const missingBytes = [...plan.files.entries()]
      .filter(([file]) => !snap.files[file]?.present)
      .reduce((n, [, f]) => n + f.size, 0)
    const firstError = failed.find(
      (r) =>
        !(r.reason instanceof RunInterrupted) && !(r.reason instanceof DiskFloorReached)
    )
    for (const spec of plan.specs) {
      const w = state.wanted[spec.repo]?.[spec.revision]
      if (!w) continue
      w.missingBytes = missingBytes
      if (firstError) {
        w.status = 'error'
        w.error = publicError(firstError.reason, plan)
      } else if (w.status === 'ok' && missingBytes > 0) {
        w.status = 'downloading'
      }
    }
    if (firstError) {
      CORE_LOGGER.warn(
        `${LOG} ${plan.repo}@${plan.commit.slice(0, 12)}: ${failed.length} file(s) failed, ` +
          `first: ${firstError.reason?.message ?? firstError.reason}`
      )
    }
    void this.queuePersist(ctx)
  }

  private fileLimitFn: ReturnType<typeof pLimit> | null = null
  private fileLimitCtx: RunContext | null = null
  private fileLimit(ctx: RunContext): ReturnType<typeof pLimit> {
    if (this.fileLimitCtx !== ctx) {
      this.fileLimitCtx = ctx
      this.fileLimitFn = pLimit(PARALLEL_FILES)
    }
    return this.fileLimitFn
  }

  private async ensureFile(
    ctx: RunContext,
    plan: Plan,
    file: string,
    f: PlannedFile
  ): Promise<void> {
    this.checkInterrupted(ctx)
    const { store, state } = ctx
    const local = store.blobPath(plan.repo, f.blob)
    const registry = (state.blobs ??= {})
    if (!(await store.hasBlob(plan.repo, f.blob, f.size, registry))) {
      const source = await this.ensureBlob(ctx, plan, file, f)
      if (
        source !== local &&
        !(await store.hasBlob(plan.repo, f.blob, f.size, registry))
      ) {
        await store.linkBlobFrom(plan.repo, f.blob, source, f.size, registry)
      }
    }
    // Never link (and so never publish) a blob that is not the advertised size.
    if (!(await store.hasBlob(plan.repo, f.blob, f.size, registry))) {
      throw new HfError(
        `${plan.repo}@${plan.commit.slice(0, 12)}/${file}: blob missing or wrong size`,
        'size_mismatch'
      )
    }
    await store.linkSnapshotFile(plan.repo, plan.commit, file, f.blob)
    const entry = state.snapshots[plan.key]?.files[file]
    if (entry) entry.present = true
  }

  // One download per blob per run, whichever repo asks first; other repos with the same
  // content hard-link it.
  private ensureBlob(
    ctx: RunContext,
    plan: Plan,
    file: string,
    f: PlannedFile
  ): Promise<string> {
    const existing = ctx.blobJobs.get(f.blob)
    if (existing) return existing
    const job = (async () => {
      const elsewhere = await this.findBlobElsewhere(ctx, f)
      if (elsewhere) return elsewhere
      // Only new bytes stop at the disk floor; links and already present files go on.
      if (ctx.diskFloor) throw new DiskFloorReached('disk floor reached')
      const { store } = ctx
      const part = store.partPath(f.blob)
      try {
        await this.hf.downloadFile({
          repo: plan.repo,
          commit: plan.commit,
          file,
          size: f.size,
          hash: f.blob,
          lfs: f.lfs,
          partPath: part,
          signal: ctx.signal,
          chunkBytes: this.deps.chunkBytes,
          beforeChunk: async (remaining) => {
            this.checkInterrupted(ctx)
            ctx.inflightRemaining.set(f.blob, remaining)
            await this.checkDiskFloor(ctx, f.blob, remaining)
          },
          onBytes: (n) => {
            ctx.downloaded += n
            ctx.inflightRemaining.set(
              f.blob,
              Math.max(0, (ctx.inflightRemaining.get(f.blob) ?? n) - n)
            )
            this.maybeLogProgress(ctx)
          }
        })
      } catch (e) {
        if (e instanceof HfError && e.code === 'aborted')
          throw new RunInterrupted('aborted')
        throw e
      } finally {
        ctx.inflightRemaining.delete(f.blob)
      }
      await store.installBlob(plan.repo, f.blob, part, (ctx.state.blobs ??= {}))
      return store.blobPath(plan.repo, f.blob)
    })()
    ctx.blobJobs.set(f.blob, job)
    return job
  }

  private async findBlobElsewhere(
    ctx: RunContext,
    f: PlannedFile
  ): Promise<string | null> {
    const repos = new Set<string>()
    for (const snap of Object.values(ctx.state.snapshots)) {
      for (const cached of Object.values(snap.files)) {
        if (cached.blob === f.blob && cached.present) repos.add(snap.repo)
      }
    }
    for (const repo of repos) {
      if (await ctx.store.hasBlob(repo, f.blob, f.size, (ctx.state.blobs ??= {}))) {
        return ctx.store.blobPath(repo, f.blob)
      }
    }
    return null
  }

  private async checkDiskFloor(
    ctx: RunContext,
    blob: string,
    remaining: number
  ): Promise<void> {
    const free = await ctx.store.freeBytes()
    let reserved = 0
    for (const [b, r] of ctx.inflightRemaining) if (b !== blob) reserved += r
    const floor = (ctx.cfg.minFreeGb ?? DEFAULT_MIN_FREE_GB) * GB
    if (free - remaining - reserved < floor) {
      if (!ctx.diskFloor) {
        CORE_LOGGER.warn(
          `${LOG} free space would drop below minFreeGb (${floor / GB} GB); pausing downloads`
        )
      }
      ctx.diskFloor = true
      throw new DiskFloorReached('disk floor reached')
    }
  }

  private maybeLogProgress(ctx: RunContext): void {
    const now = Date.now()
    if (now - ctx.lastProgressLog < PROGRESS_LOG_MS) return
    ctx.lastProgressLog = now
    const left = [...ctx.inflightRemaining.values()].reduce((a, b) => a + b, 0)
    CORE_LOGGER.info(
      `${LOG} downloading: ${(ctx.downloaded / GB).toFixed(1)} GB this run, ` +
        `${ctx.inflightRemaining.size} file(s) in flight, ${(left / GB).toFixed(1)} GB left on them`
    )
  }

  // Retire what is no longer wanted (dropped from index.json first), then delete it once
  // the grace period has passed AND no service that might be reading it is still alive.
  private async collectGarbage(ctx: RunContext, accepted: Plan[]): Promise<void> {
    const { state, store, cfg } = ctx
    const now = new Date().toISOString()
    const keep = new Set(accepted.map((p) => p.key))
    const planByKey = new Map(accepted.map((p) => [p.key, p]))
    // Snapshots a revision is still served from while its own update is not done: their
    // files must not be narrowed by another plan that shares the commit.
    const served = new Set<string>()
    for (const [repo, revs] of Object.entries(state.wanted)) {
      for (const [rev, w] of Object.entries(revs)) {
        if (!KEEPS_SERVED.has(w.status)) continue
        const commit = isCommit(rev) ? rev : state.refs[repo]?.[rev]
        if (commit) {
          keep.add(snapshotKey(repo, commit))
          if (w.status !== 'ok') served.add(snapshotKey(repo, commit))
        }
        // An entry whose lookup failed keeps its unfinished target too.
        if (w.status === 'error' && w.sha) keep.add(snapshotKey(repo, w.sha))
      }
    }
    for (const [repo, refs] of Object.entries(state.refs)) {
      for (const [rev, commit] of Object.entries(refs)) {
        const w = state.wanted[repo]?.[rev]
        if (w && KEEPS_SERVED.has(w.status)) continue
        await store.removeRef(repo, rev)
        delete refs[rev]
        CORE_LOGGER.info(
          `${LOG} ${repo}: ${rev} no longer wanted (was ${commit.slice(0, 12)})`
        )
      }
      if (!Object.keys(refs).length) delete state.refs[repo]
    }
    for (const [key, snap] of Object.entries(state.snapshots)) {
      if (keep.has(key)) {
        delete snap.retiredAt
        const plan = planByKey.get(key)
        if (plan && !served.has(key)) {
          // Nothing else needs more of this snapshot than its plan: narrow it to the plan.
          snap.complete = plan.complete
          snap.selection = plan.complete ? { kind: 'all' } : plan.selection
          for (const [file, f] of Object.entries(snap.files)) {
            if (plan.files.has(file)) delete f.retiredAt
            else f.retiredAt ??= now
          }
        }
      } else if (!snap.publishedAt) {
        // Never listed in index.json, so nothing can be reading it.
        await store.removeSnapshot(snap.repo, snap.commit)
        delete state.snapshots[key]
      } else if (!snap.retiredAt) {
        snap.retiredAt = now
        CORE_LOGGER.info(`${LOG} retired ${snap.repo}@${snap.commit.slice(0, 12)}`)
      }
    }
    // index.json drops retired entries before anything is deleted.
    await ctx.persistChain.catch(() => {})
    await this.persist(ctx)

    const jobs = await this.serviceJobs()
    for (const [key, snap] of Object.entries(state.snapshots)) {
      if (snap.retiredAt) {
        if (!this.deletable(snap.retiredAt, cfg, jobs)) continue
        await store.removeSnapshot(snap.repo, snap.commit)
        delete state.snapshots[key]
        CORE_LOGGER.info(`${LOG} deleted ${snap.repo}@${snap.commit.slice(0, 12)}`)
        continue
      }
      for (const [file, f] of Object.entries(snap.files)) {
        if (!f.retiredAt || !this.deletable(f.retiredAt, cfg, jobs)) continue
        await store.removeSnapshotFile(snap.repo, snap.commit, file)
        delete snap.files[file]
      }
    }
    // Blobs still needed but not linked yet (accepted plans, unfinished targets) and their
    // partial downloads are kept.
    const keepBlobs = new Set<string>()
    const keepParts = new Set<string>()
    for (const key of keep) {
      const snap = state.snapshots[key]
      for (const f of Object.values(snap?.files ?? {})) {
        keepBlobs.add(store.blobPath(snap.repo, f.blob))
        keepParts.add(store.partPath(f.blob))
      }
    }
    for (const plan of accepted) {
      for (const f of plan.files.values()) {
        keepBlobs.add(store.blobPath(plan.repo, f.blob))
        keepParts.add(store.partPath(f.blob))
      }
    }
    const freed = await store.deleteUnreferencedBlobs(keepBlobs)
    if (freed > 0) CORE_LOGGER.info(`${LOG} freed ${(freed / GB).toFixed(1)} GB`)
    await store.removeStaleParts(STALE_PART_MS, keepParts)
    await store.emptyTrash()
    await store.pruneRegistry((state.blobs ??= {}))
  }

  private async serviceJobs(): Promise<ServiceJob[] | null> {
    if (!this.deps.getServiceJobs) return null
    try {
      return await this.deps.getServiceJobs()
    } catch (e) {
      CORE_LOGGER.warn(`${LOG} cannot list services (${e.message}); deleting nothing`)
      return null
    }
  }

  private deletable(
    retiredAt: string,
    cfg: ServiceModelCacheConfig,
    jobs: ServiceJob[] | null
  ): boolean {
    const retired = Date.parse(retiredAt)
    const graceMs = Math.max(1, cfg.gcGraceHours ?? DEFAULT_GRACE_HOURS) * 3600 * 1000
    if (!Number.isFinite(retired) || Date.now() - retired < graceMs) return false
    if (jobs === null) return false
    return !jobs.some(
      (j) => LIVE_STATUSES.has(j.status) && !(Date.parse(j.dateCreated) >= retired)
    )
  }

  private queuePersist(ctx: RunContext): Promise<void> {
    ctx.persistChain = ctx.persistChain
      .then(() => this.persist(ctx))
      .catch((e) => CORE_LOGGER.error(`${LOG} cannot save state: ${e.message}`))
    return ctx.persistChain
  }

  // Serializes both files before the first await, so they describe the same moment.
  private async persist(ctx: RunContext): Promise<void> {
    const stateJson = JSON.stringify(ctx.state)
    const indexJson =
      JSON.stringify(buildIndex(ctx.state, new Date().toISOString()), null, 1) + '\n'
    await ctx.store.writeState(stateJson)
    await ctx.store.writeIndex(indexJson)
  }
}
