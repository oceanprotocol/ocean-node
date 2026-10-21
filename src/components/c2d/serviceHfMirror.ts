import { createHash, randomUUID } from 'crypto'
import { existsSync } from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import type { OceanNodeConfig } from '../../@types/OceanNode.js'
import type { DockerMountObject } from '../../@types/PersistentStorage.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'

// Service-on-Demand Hugging Face mirror support (docs/services.md, "Hugging Face mirror").
// When `serviceHfMirrorUrl` is set, every service container gets HF_ENDPOINT pointed at the
// mirror plus HF_HUB_DISABLE_XET=1 (with Xet on, huggingface_hub fetches a xet-read-token
// and pulls from huggingface.co directly, bypassing the mirror). Hub's stock plain-HTTP
// client is GIL-bound, so the node also ships a sitecustomize.py that swaps hub's http_get
// for a urllib readinto loop; it is bind-mounted read-only into the service and put first
// on PYTHONPATH. Compute jobs are not touched. Every step degrades: a bad URL disables the
// feature at config load, and a patch that cannot be prepared or mounted leaves the
// service starting with the mirror env only.

// Fixed path the patch dir is mounted at inside every service container.
export const HF_PATCH_CONTAINER_DIR = '/ocean/hfpatch'
export const HF_PATCH_FILE_NAME = 'sitecustomize.py'

// Shipped at <repo>/hfpatch/sitecustomize.py (copied into the Docker image next to dist/).
// This module compiles to dist/components/c2d/, three levels below the repo root.
export const SHIPPED_HF_PATCH_PATH = fileURLToPath(
  new URL(`../../../hfpatch/${HF_PATCH_FILE_NAME}`, import.meta.url)
)

export interface ServiceHfMirrorSettings {
  mirrorUrl: string | null // HF_ENDPOINT value for services; null = no mirror env
  patch: boolean // ship the download-client patch into services
  patchHostDir: string | null // node-owned dir holding the patch, same path on host and node
  // persistent-storage buckets root: the patch dir must never be inside it, because bucket
  // dirs are bind-mounted read-write into services (null when there is no localfs storage)
  bucketsRoot: string | null
}

export interface ServiceHfContainerSpec {
  env: Record<string, string>
  mounts: DockerMountObject[]
}

// What a service container is created with, plus the variant to fall back to when Docker
// rejects the patch mount (withoutPatch is null when no patch was applied).
export interface ServiceHfPlan extends ServiceHfContainerSpec {
  patchHostDir: string | null
  withoutPatch: ServiceHfContainerSpec | null
}

function runningInContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv')
}

function localfsStorageFolder(config: OceanNodeConfig): string | null {
  const ps = config?.persistentStorage
  const folder = (ps?.options as { folder?: unknown } | undefined)?.folder
  if (ps?.enabled && ps.type === 'localfs' && typeof folder === 'string' && folder) {
    return path.resolve(folder)
  }
  return null
}

// Bind-mount sources are resolved by the Docker daemon on the HOST, so the patch dir must be
// a path that is the same inside the node and on the host. In order: the explicit
// `serviceHfPatchDir`; `<persistentStorage folder>/hfpatch` for localfs storage (that folder
// already has to be mounted at the same path, because bucket binds use it as their Source;
// `hfpatch` is a sibling of `buckets/`, never inside it); `./databases/hfpatch` when the node
// is not containerized (its paths are host paths). Otherwise there is no safe default and
// the patch is skipped.
export function resolveHfPatchHostDir(config: OceanNodeConfig): string | null {
  if (config.serviceHfPatchDir) return config.serviceHfPatchDir
  const folder = localfsStorageFolder(config)
  if (folder) return path.join(folder, 'hfpatch')
  if (!runningInContainer()) return path.resolve('databases', 'hfpatch')
  return null
}

export function getServiceHfMirrorSettings(
  config: OceanNodeConfig
): ServiceHfMirrorSettings {
  const mirrorUrl = config?.serviceHfMirrorUrl || null
  // Defaults to on with a mirror; an explicit true also ships it without one.
  const patch = config?.serviceHfClientPatch ?? Boolean(mirrorUrl)
  const folder = localfsStorageFolder(config)
  return {
    mirrorUrl,
    patch,
    patchHostDir: patch ? resolveHfPatchHostDir(config) : null,
    bucketsRoot: folder ? path.join(folder, 'buckets') : null
  }
}

let shippedPatch: Promise<Buffer> | null = null
function readShippedPatch(shippedPath: string): Promise<Buffer> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- shipped path / test seam
  if (shippedPath !== SHIPPED_HF_PATCH_PATH) return fsp.readFile(shippedPath)
  if (!shippedPatch) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed shipped path
    shippedPatch = fsp.readFile(SHIPPED_HF_PATCH_PATH)
    // a failed read is retried on the next call instead of being cached forever
    shippedPatch.catch(() => {
      shippedPatch = null
    })
  }
  return shippedPatch
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// The patch is code that runs in every Python service, so the node only publishes it from a
// dir that nobody but the node (or root) can change. "Trusted owner" = the node's own uid or
// root; on platforms without uids (Windows) ownership is not checked.
const NODE_UID = typeof process.getuid === 'function' ? process.getuid() : null

function trustedOwner(uid: number): boolean {
  return NODE_UID === null || uid === NODE_UID || uid === 0
}

function isWithin(child: string, root: string): boolean {
  const rel = path.relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function modeStr(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0')
}

/* eslint-disable security/detect-non-literal-fs-filename -- node-owned, operator-configured dir */
async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fsp.realpath(p)
  } catch {
    return p
  }
}

// Every ancestor of the canonical patch dir must be owned by the node or root, and writable
// by nobody else: anyone who can write an ancestor can rename the patch dir (or the
// ancestor below it) away and put their own in its place. Group write counts like other
// write — group membership is not inferred, whoever the owner is. Either is accepted only
// on a sticky dir (/tmp style), where others cannot rename or delete entries they do not
// own, and only because the entry below it is itself node- or root-owned (every component
// of the path is checked for that, the leaf by the caller). Foreign-owned ancestors are
// rejected whatever their mode, because their owner can chmod them at any time.
async function assertTrustedAncestors(realDir: string): Promise<void> {
  let dir = path.dirname(realDir)
  for (;;) {
    const st = await fsp.lstat(dir)
    if (!trustedOwner(st.uid)) {
      throw new Error(`ancestor ${dir} is owned by uid ${st.uid}, not the node or root`)
    }
    if (st.mode & 0o022 && !(st.mode & 0o1000)) {
      throw new Error(
        `ancestor ${dir} (mode ${modeStr(st.mode)}, gid ${st.gid}) is ` +
          `${st.mode & 0o002 ? 'world' : 'group'}-writable without the sticky bit`
      )
    }
    const parent = path.dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

// configured → canonical pairs already logged, so a symlinked config logs once, not per start
const loggedCanonical = new Set<string>()

// Makes `<canonical dir>/sitecustomize.py` byte-identical to `content` and returns the
// canonical dir — the ONLY path the caller may mount. The configured dir is created, then
// resolved once with realpath, and every check and write after that runs on the canonical
// path, so no symlink in the configured path (an alias the node does not control) is
// trusted or mounted: retargeting it after this returns cannot change what Docker binds.
// The canonical dir must be: outside the buckets tree, a node- or root-owned directory,
// mode 0755, with only trusted ancestors; the file a node- or root-owned 0644 regular
// file. It is written to a fresh temp file (O_EXCL) and renamed into place, so a starting
// service never sees a partial file and a planted symlink is replaced, not followed; a
// file that is already trusted and matches by hash is left alone (cheap per start).
// Throws on anything it cannot establish; the caller turns that into "no patch".
async function writeHfPatchDir(
  hostDir: string,
  content: Buffer,
  bucketsRoot: string | null
): Promise<{ dir: string; written: boolean }> {
  const configured = path.resolve(hostDir)
  if (bucketsRoot && isWithin(configured, path.resolve(bucketsRoot))) {
    throw new Error(`it is inside the persistent-storage buckets dir ${bucketsRoot}`)
  }
  await fsp.mkdir(configured, { recursive: true, mode: 0o755 })
  const dir = await fsp.realpath(configured)
  if (dir !== configured && !loggedCanonical.has(`${configured}\0${dir}`)) {
    loggedCanonical.add(`${configured}\0${dir}`)
    CORE_LOGGER.info(
      `HF client patch dir ${configured} resolves to ${dir}; ${dir} is checked and mounted ` +
        `(it must exist at that same path on the Docker host)`
    )
  }
  if (bucketsRoot && isWithin(dir, await realpathOrSelf(path.resolve(bucketsRoot)))) {
    throw new Error(`it resolves into the persistent-storage buckets dir ${bucketsRoot}`)
  }
  let st = await fsp.lstat(dir)
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`)
  if (!trustedOwner(st.uid)) {
    throw new Error(
      `${dir} is owned by uid ${st.uid}, not the node (uid ${NODE_UID}) or root`
    )
  }
  // mkdir's mode is masked by the umask and ignored for an existing dir. A failed chmod
  // propagates: the dir is then not in a state the node can vouch for.
  if ((st.mode & 0o7777) !== 0o755) {
    await fsp.chmod(dir, 0o755)
    st = await fsp.lstat(dir)
  }
  if ((st.mode & 0o7777) !== 0o755) {
    throw new Error(`${dir} has mode ${modeStr(st.mode)} after chmod 0755`)
  }
  await assertTrustedAncestors(dir)

  const target = path.join(dir, HF_PATCH_FILE_NAME)
  try {
    const fst = await fsp.lstat(target)
    if (
      fst.isFile() &&
      trustedOwner(fst.uid) &&
      (fst.mode & 0o7777) === 0o644 &&
      sha256(await fsp.readFile(target)) === sha256(content)
    ) {
      return { dir, written: false }
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e
  }
  const tmp = path.join(dir, `.${HF_PATCH_FILE_NAME}.${randomUUID()}.tmp`)
  try {
    await fsp.writeFile(tmp, content, { mode: 0o644, flag: 'wx' })
    await fsp.chmod(tmp, 0o644)
    await fsp.rename(tmp, target)
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    throw e
  }
  const fst = await fsp.lstat(target)
  if (!fst.isFile() || !trustedOwner(fst.uid) || fst.mode & 0o022) {
    throw new Error(`${target} is not a node-owned 0644 file after writing it`)
  }
  return { dir, written: true }
}
/* eslint-enable security/detect-non-literal-fs-filename */

// Prepares the patch dir. Never throws. Returns the canonical (symlink-resolved) dir that
// was validated — mount that, never the configured path — or null, meaning "start services
// without the patch". `content` / `shippedPath` are test seams; production reads the
// shipped file.
export async function prepareHfPatchDir(
  hostDir: string,
  opts: { bucketsRoot?: string | null; content?: Buffer; shippedPath?: string } = {}
): Promise<string | null> {
  try {
    const content =
      opts.content ?? (await readShippedPatch(opts.shippedPath ?? SHIPPED_HF_PATCH_PATH))
    const { dir, written } = await writeHfPatchDir(
      hostDir,
      content,
      opts.bucketsRoot ?? null
    )
    if (written) CORE_LOGGER.info(`HF client patch written to ${dir}`)
    return dir
  } catch (e) {
    CORE_LOGGER.warn(
      `HF client patch not used (${hostDir}): ${e?.message} — services start without it`
    )
    return null
  }
}

function envValue(env: string[] | undefined, key: string): string | undefined {
  const prefix = `${key}=`
  const entry = (env ?? []).find((e) => e.startsWith(prefix))
  return entry === undefined ? undefined : entry.slice(prefix.length)
}

// Pure: the env and mounts a service gets on top of its user/template env.
// - HF_ENDPOINT / HF_HUB_DISABLE_XET: each one the user already set wins. A user-set
//   HF_ENDPOINT means "not our mirror", so HF_HUB_DISABLE_XET is then left to the user too.
// - PYTHONPATH: the patch dir goes first, followed by what the container would have had
//   without the node: the user's PYTHONPATH when they set one (Docker semantics: it
//   replaces the image's), else the image's Config.Env PYTHONPATH. That value is kept
//   verbatim, empty components included (an empty entry means "the working directory",
//   which an image may rely on); an unset or empty value gives just the patch dir.
// - A user OCEAN_HFPATCH=0 skips the mount and PYTHONPATH change entirely.
// `imageEnv` must be the image's Config.Env when a patch dir is passed; the caller passes
// patchHostDir null when it could not read it, so the image's PYTHONPATH is never dropped.
export function applyServiceHfMirror(
  userEnv: Record<string, string>,
  imageEnv: string[] | undefined,
  opts: { mirrorUrl: string | null; patchHostDir: string | null }
): ServiceHfContainerSpec {
  const env = { ...userEnv }
  const mounts: DockerMountObject[] = []
  if (opts.mirrorUrl && !('HF_ENDPOINT' in userEnv)) {
    env.HF_ENDPOINT = opts.mirrorUrl
    if (!('HF_HUB_DISABLE_XET' in userEnv)) env.HF_HUB_DISABLE_XET = '1'
  }
  if (opts.patchHostDir && userEnv.OCEAN_HFPATCH !== '0') {
    const rest =
      'PYTHONPATH' in userEnv ? userEnv.PYTHONPATH : envValue(imageEnv, 'PYTHONPATH')
    env.PYTHONPATH = rest ? `${HF_PATCH_CONTAINER_DIR}:${rest}` : HF_PATCH_CONTAINER_DIR
    mounts.push({
      Type: 'bind',
      Source: opts.patchHostDir,
      Target: HF_PATCH_CONTAINER_DIR,
      ReadOnly: true
    })
  }
  return { env, mounts }
}

// Builds the plan for one service container. `readImageEnv` returns the image's Config.Env;
// if it fails, or the patch dir cannot be prepared, the plan carries the mirror env only.
export async function buildServiceHfPlan(
  settings: ServiceHfMirrorSettings,
  userEnv: Record<string, string>,
  readImageEnv: () => Promise<string[] | undefined>,
  serviceId: string
): Promise<ServiceHfPlan> {
  const base = applyServiceHfMirror(userEnv, undefined, {
    mirrorUrl: settings.mirrorUrl,
    patchHostDir: null
  })
  const unpatched: ServiceHfPlan = { ...base, patchHostDir: null, withoutPatch: null }
  if (!settings.patch || !settings.patchHostDir || userEnv.OCEAN_HFPATCH === '0') {
    return unpatched
  }
  // the validated canonical dir: the configured path may contain symlinks
  const patchDir = await prepareHfPatchDir(settings.patchHostDir, {
    bucketsRoot: settings.bucketsRoot
  })
  if (!patchDir) return unpatched
  let imageEnv: string[] | undefined
  try {
    imageEnv = await readImageEnv()
  } catch (e) {
    CORE_LOGGER.warn(
      `service ${serviceId}: cannot read image env (${e?.message}) — starting without the HF client patch`
    )
    return unpatched
  }
  const patched = applyServiceHfMirror(userEnv, imageEnv, {
    mirrorUrl: settings.mirrorUrl,
    patchHostDir: patchDir
  })
  return { ...patched, patchHostDir: patchDir, withoutPatch: base }
}

// True when a createContainer / start error is about the patch mount: Docker and the OCI
// runtime name the mount's source or target in those errors — e.g. "bind source path does
// not exist: <dir>" at create (the dir is not at that path on the host), or "error mounting
// \"<dir>\" to rootfs at \"/ocean/hfpatch\"" at start (the image has a file there).
export function isHfPatchMountError(err: any, patchHostDir: string | null): boolean {
  if (!patchHostDir) return false
  const msg = String(err?.message ?? err)
  return msg.includes(patchHostDir) || msg.includes(HF_PATCH_CONTAINER_DIR)
}
