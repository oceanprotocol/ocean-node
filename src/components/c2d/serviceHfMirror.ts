import fsp from 'fs/promises'
import { fileURLToPath } from 'url'
import * as tarStream from 'tar-stream'
import type { OceanNodeConfig } from '../../@types/OceanNode.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'

// Service-on-Demand Hugging Face mirror support (docs/services.md, "Hugging Face mirror").
// When `serviceHfMirrorUrl` is set, every service container gets HF_ENDPOINT pointed at the
// mirror plus HF_HUB_DISABLE_XET=1

// Fixed path the patch lives at inside every service container.
export const HF_PATCH_CONTAINER_DIR = '/ocean/hfpatch'
export const HF_PATCH_FILE_NAME = 'sitecustomize.py'
// The patch's tar entry, extracted at '/' (archive paths are relative, no leading '/').
export const HF_PATCH_TAR_ENTRY = `${HF_PATCH_CONTAINER_DIR.slice(1)}/${HF_PATCH_FILE_NAME}`

// Shipped at <repo>/hfpatch/sitecustomize.py (copied into the Docker image next to dist/).
// This module compiles to dist/components/c2d/, three levels below the repo root.
export const SHIPPED_HF_PATCH_PATH = fileURLToPath(
  new URL(`../../../hfpatch/${HF_PATCH_FILE_NAME}`, import.meta.url)
)

export interface ServiceHfMirrorSettings {
  mirrorUrl: string | null // HF_ENDPOINT value for services; null = no mirror env
  patch: boolean // ship the download-client patch into services
}

export interface ServiceHfContainerSpec {
  env: Record<string, string>
}

// What a service container is created with, plus the variant to fall back to when the
// patch cannot be copied in (withoutPatch is null when no patch was applied).
export interface ServiceHfPlan extends ServiceHfContainerSpec {
  patch: Buffer | null // tar to put at '/' before start (hfPatchArchive); null = unpatched
  withoutPatch: ServiceHfContainerSpec | null
}

export function getServiceHfMirrorSettings(
  config: OceanNodeConfig
): ServiceHfMirrorSettings {
  const mirrorUrl = config?.serviceHfMirrorUrl || null
  // Defaults to on with a mirror; an explicit true also ships it without one.
  const patch = config?.serviceHfClientPatch ?? Boolean(mirrorUrl)
  return { mirrorUrl, patch }
}

function tarOf(content: Buffer): Promise<Buffer> {
  const pack = tarStream.pack()
  // Only the file: parent dirs are not listed, so the daemon creates missing ones and
  // leaves an image's existing /ocean alone
  pack.entry(
    { name: HF_PATCH_TAR_ENTRY, mode: 0o644, uid: 0, gid: 0, mtime: new Date(0) },
    content
  )
  pack.finalize()
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    pack.on('data', (c: Buffer) => chunks.push(c))
    pack.on('end', () => resolve(Buffer.concat(chunks)))
    pack.on('error', reject)
  })
}

let shippedArchive: Promise<Buffer> | null = null
// The tar copied into services, built once from the shipped file. `shippedPath` is a test
// seam: any other path is read and packed fresh, never cached.
export function hfPatchArchive(shippedPath = SHIPPED_HF_PATCH_PATH): Promise<Buffer> {
  if (shippedPath !== SHIPPED_HF_PATCH_PATH) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test seam
    return fsp.readFile(shippedPath).then(tarOf)
  }
  if (!shippedArchive) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed shipped path
    shippedArchive = fsp.readFile(SHIPPED_HF_PATCH_PATH).then(tarOf)
    // a failed read is retried on the next call instead of being cached forever
    shippedArchive.catch(() => {
      shippedArchive = null
    })
  }
  return shippedArchive
}

// Copies the patch into a created, not yet started container. Rejects when Docker refuses
// it — a read-only rootfs, a file at /ocean in the image, … (the status code is not
// meaningful: the API documents 403, Engine 27 answers 500 for both).
export async function injectHfPatch(
  container: { putArchive(file: Buffer, opts: object): Promise<unknown> },
  archive: Buffer
): Promise<void> {
  await container.putArchive(archive, { path: '/', noOverwriteDirNonDir: true })
}

function envValue(env: string[] | undefined, key: string): string | undefined {
  const prefix = `${key}=`
  const entry = (env ?? []).find((e) => e.startsWith(prefix))
  return entry === undefined ? undefined : entry.slice(prefix.length)
}

// Pure: the env a service gets on top of its user/template env.
// - HF_ENDPOINT / HF_HUB_DISABLE_XET: user values win. If the user sets HF_ENDPOINT, the
//   node leaves HF_HUB_DISABLE_XET alone too.
// - PYTHONPATH: the patch dir, then the user's PYTHONPATH, else the image's (kept verbatim).
// - OCEAN_HFPATCH=0 leaves PYTHONPATH untouched.
// Pass the image's Config.Env when `patch` is true, so its PYTHONPATH is not dropped.
export function applyServiceHfMirror(
  userEnv: Record<string, string>,
  imageEnv: string[] | undefined,
  opts: { mirrorUrl: string | null; patch: boolean }
): ServiceHfContainerSpec {
  const env = { ...userEnv }
  if (opts.mirrorUrl && !('HF_ENDPOINT' in userEnv)) {
    env.HF_ENDPOINT = opts.mirrorUrl
    if (!('HF_HUB_DISABLE_XET' in userEnv)) env.HF_HUB_DISABLE_XET = '1'
  }
  if (opts.patch && userEnv.OCEAN_HFPATCH !== '0') {
    const rest =
      'PYTHONPATH' in userEnv ? userEnv.PYTHONPATH : envValue(imageEnv, 'PYTHONPATH')
    env.PYTHONPATH = rest ? `${HF_PATCH_CONTAINER_DIR}:${rest}` : HF_PATCH_CONTAINER_DIR
  }
  return { env }
}

// Builds the plan for one service container. `readImageEnv` returns the image's Config.Env;
// if it fails, or the patch archive cannot be built, the plan carries the mirror env only.
// `archive` is a test seam; production uses the shipped patch.
export async function buildServiceHfPlan(
  settings: ServiceHfMirrorSettings,
  userEnv: Record<string, string>,
  readImageEnv: () => Promise<string[] | undefined>,
  serviceId: string,
  archive: () => Promise<Buffer> = () => hfPatchArchive()
): Promise<ServiceHfPlan> {
  const base = applyServiceHfMirror(userEnv, undefined, {
    mirrorUrl: settings.mirrorUrl,
    patch: false
  })
  const unpatched: ServiceHfPlan = { ...base, patch: null, withoutPatch: null }
  if (!settings.patch || userEnv.OCEAN_HFPATCH === '0') return unpatched
  let patch: Buffer
  try {
    patch = await archive()
  } catch (e) {
    CORE_LOGGER.error(
      `service ${serviceId}: HF client patch unavailable (${e?.message}) — starting without it`
    )
    return unpatched
  }
  let imageEnv: string[] | undefined
  try {
    imageEnv = await readImageEnv()
  } catch (e) {
    CORE_LOGGER.error(
      `service ${serviceId}: cannot read image env (${e?.message}) — starting without the HF client patch`
    )
    return unpatched
  }
  const patched = applyServiceHfMirror(userEnv, imageEnv, {
    mirrorUrl: settings.mirrorUrl,
    patch: true
  })
  return { ...patched, patch, withoutPatch: base }
}
