import { PassThrough, Readable, pipeline } from 'stream'
import * as tarStream from 'tar-stream'
import yazl from 'yazl'

// Folder a service writes its results to. Archived like a compute job's outputs when the
// service has no output bucket mounted there.
export const SERVICE_OUTPUTS_PATH = '/data/outputs'

// A service-result request the engine refuses, with the HTTP status the handler returns.
export class ServiceResultError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string
  ) {
    super(message)
    this.name = 'ServiceResultError'
  }
}

export interface ServiceResult {
  stream: Readable
  headers: Record<string, string>
}

export interface TarToZipStats {
  files: number
  directories: number
  // symlinks, hardlinks, devices, fifos and entries with an unsafe name
  skipped: number
}

/**
 * Maps a tar entry name from `container.getArchive({ path: '/data/outputs' })` to its path
 * inside the zip. Docker roots that archive at the folder name ("outputs/..."), which is
 * stripped so the zip holds the folder's contents. Returns '' for the root folder itself and
 * null for a name that is unsafe to extract (absolute, drive letter, "." or ".." segments):
 * the tar is written by the service container, so it must never be able to plant a zip-slip
 * entry on the machine of whoever unzips it.
 */
export function zipEntryName(tarName: string): string | null {
  const normalized = tarName.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
  const parts = normalized.split('/').filter((p) => p !== '')
  if (parts.some((p) => p === '.' || p === '..')) return null
  if (parts[0] === 'outputs') parts.shift()
  return parts.join('/')
}

/**
 * Converts the tar stream Docker returns for a container folder into a zip stream, without
 * buffering it on disk. Regular files and folders are kept with their mtime and permission
 * bits; everything else is skipped. Files are stored, not deflated: service outputs are mostly
 * already-compressed media or model files, and deflating them would only slow down the
 * stop/restart that archives them. yazl switches to ZIP64 on its own for entries or archives
 * past 4 GB.
 */
export function tarToZip(
  tar: NodeJS.ReadableStream,
  onDone?: (stats: TarToZipStats) => void
): Readable {
  const zip = new yazl.ZipFile()
  const out = new PassThrough()
  const stats: TarToZipStats = { files: 0, directories: 0, skipped: 0 }
  const extract = tarStream.extract()

  const skip = (stream: Readable, next: () => void) => {
    stream.on('end', () => next())
    stream.resume()
  }

  extract.on('entry', (header, stream, next) => {
    // A tar that ends inside an entry (Docker stops writing it when a file shrinks while it is
    // archived, or the archive request breaks) errors the entry's stream, not only `extract`.
    // yazl never listens on the streams it is given, so without this the error is unhandled
    // and takes the node down — and the client is left with a truncated zip.
    stream.on('error', (err) => out.destroy(err))
    const name = zipEntryName(header.name)
    const permissions = (header.mode ?? 0o644) & 0o7777
    const mtime = header.mtime ?? new Date()
    if (name === null) {
      stats.skipped++
      return skip(stream, next)
    }
    if (header.type === 'directory') {
      if (name !== '') {
        zip.addEmptyDirectory(name, { mtime, mode: 0o040000 | permissions })
        stats.directories++
      }
      return skip(stream, next)
    }
    if ((header.type === 'file' || header.type === 'contiguous-file') && name !== '') {
      stats.files++
      stream.on('end', () => next())
      zip.addReadStream(stream, name, {
        mtime,
        mode: 0o100000 | permissions,
        size: header.size,
        compress: false
      })
      return
    }
    stats.skipped++
    skip(stream, next)
  })

  pipeline(tar as Readable, extract, (err) => {
    if (err) {
      out.destroy(err)
      return
    }
    zip.end()
  })
  let finished = false
  zip.outputStream.on('error', (err) => out.destroy(err))
  zip.outputStream.on('end', () => {
    finished = true
    onDone?.(stats)
  })
  zip.outputStream.pipe(out)
  // A consumer that goes away (e.g. a client aborting a download) must not leave the Docker
  // archive stream open and stalled on backpressure.
  out.on('close', () => {
    if (!finished) extract.destroy()
  })
  return out
}

/**
 * Tar that creates `/data/outputs` (mode 0777, so a non-root service user can write to it)
 * when extracted by `container.putArchive` at `root`: '/' when the image has no `/data`
 * yet, '/data' when it has one — extracting over an existing folder would reset its owner
 * and mode to the tar header's.
 */
export function emptyOutputsDirTar(root: '/' | '/data'): Promise<Buffer> {
  const pack = tarStream.pack()
  if (root === '/') pack.entry({ name: 'data', type: 'directory', mode: 0o755 })
  pack.entry({
    name: root === '/' ? 'data/outputs' : 'outputs',
    type: 'directory',
    mode: 0o777
  })
  pack.finalize()
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    pack.on('data', (c: Buffer) => chunks.push(c))
    pack.on('end', () => resolve(Buffer.concat(chunks)))
    pack.on('error', reject)
  })
}
