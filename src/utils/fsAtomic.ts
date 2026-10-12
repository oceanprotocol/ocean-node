import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const IN_PLACE_CODES = new Set(['EBUSY', 'EXDEV', 'EPERM', 'EACCES', 'EROFS'])

// Writes `data` to `file` so that a reader (or a crash) sees either the old or the new
// content, never a torn file: an exclusive temp file next to the target (O_EXCL, so a
// planted file or symlink at the temp name is refused), fchmod to the wanted mode (the
// umask cannot strip it), fsync, rename over the target, fsync the directory.
// - A symlinked target is resolved first, so the real file is replaced, not the link.
// - `mode` defaults to the existing file's mode, so a config locked down to 0600 stays 0600.
// - With `fallbackInPlace`, when no temp file can be created next to the target (directory
//   not writable, e.g. /usr/src/app in the node image) or the rename is impossible (a
//   single file bind-mounted into a container), the content is written in place instead:
//   not atomic, but what the caller did before.
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  opts: { mode?: number; fallbackInPlace?: boolean } = {}
): Promise<void> {
  const target = await fs.promises.realpath(file).catch(() => file)
  let mode = opts.mode
  if (mode === undefined) {
    try {
      mode = (await fs.promises.stat(target)).mode & 0o777
    } catch {
      mode = 0o644
    }
  }
  const dir = path.dirname(target)
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomUUID()}`
  )
  let fh: fs.promises.FileHandle
  try {
    fh = await fs.promises.open(tmp, 'wx', mode)
  } catch (e) {
    if (opts.fallbackInPlace && IN_PLACE_CODES.has(e?.code)) {
      await fs.promises.writeFile(target, data)
      return
    }
    throw e
  }
  try {
    await fh.chmod(mode)
    await fh.writeFile(data)
    await fh.sync()
  } catch (e) {
    await fh.close().catch(() => {})
    await fs.promises.rm(tmp, { force: true })
    throw e
  }
  await fh.close()
  try {
    await fs.promises.rename(tmp, target)
  } catch (e) {
    await fs.promises.rm(tmp, { force: true })
    if (opts.fallbackInPlace && IN_PLACE_CODES.has(e?.code)) {
      await fs.promises.writeFile(target, data)
      return
    }
    throw e
  }
  await fsyncDir(dir)
}

export async function fsyncDir(dir: string): Promise<void> {
  let fh: fs.promises.FileHandle
  try {
    fh = await fs.promises.open(dir, 'r')
    await fh.sync()
  } catch {
    // Not every platform/filesystem allows fsync on a directory; best-effort.
  } finally {
    await fh?.close()
  }
}
