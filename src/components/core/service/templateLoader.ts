import { readdir, readFile } from 'fs/promises'
import { basename, dirname, join, resolve, sep } from 'path'
import type {
  ServiceTemplate,
  ServiceTemplateWorkflow
} from '../../../@types/C2D/ServiceOnDemand.js'
import { ServiceTemplateSchema } from '../../../utils/config/schemas.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

// Reads a file a template points at. `baseDir` is the folder the template file itself lives in,
// so a flow folder's paths stay folder-local; `resolvedRoot` is the templates root, and a target
// outside it is refused. Null (with a warning naming `what`) when the path escapes the root or
// cannot be read — template paths are author-controlled, so both are authoring mistakes rather
// than node failures.
async function readTemplateFile(
  resolvedRoot: string,
  baseDir: string,
  relPath: string,
  what: string
): Promise<string | null> {
  const target = resolve(baseDir, relPath)
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    CORE_LOGGER.warn(`${what}: "${relPath}" resolves outside the templates dir`)
    return null
  }
  try {
    return await readFile(target, 'utf8')
  } catch (e) {
    CORE_LOGGER.warn(`${what}: cannot read "${relPath}" (${e.message})`)
    return null
  }
}

// Re-reads on every call so operators can add/edit/remove template files without a restart.
// (If profiling ever shows this is hot, add an mtime-keyed cache — semantics stay identical.)
export async function loadServiceTemplates(dir?: string): Promise<ServiceTemplate[]> {
  if (!dir) return [] // safety net; in practice the config schema always supplies the default

  let files: string[]
  try {
    const entries = (await readdir(dir, { recursive: true })) as string[]
    const json = entries.filter((f) => f.toLowerCase().endsWith('.json'))
    // A directory that holds any <flow>/template.json is using the folder layout, and a repo
    // laid out that way has no templates at its root — what it does have is its own
    // package.json, which the flat rule below would otherwise parse and warn about on every
    // request. The two layouts are therefore mutually exclusive rather than additive.
    const folderLayout = json.some(
      (f) => f.includes(sep) && basename(f) === 'template.json'
    )
    files = json
      .filter((f) => (folderLayout ? basename(f) === 'template.json' : !f.includes(sep)))
      .sort() // deterministic order → stable duplicate resolution
  } catch (e) {
    // A missing folder is the normal "no templates" state — the default path
    // (databases/serviceTemplates/) need not exist — so stay quiet on ENOENT.
    if (e.code === 'ENOENT') {
      CORE_LOGGER.debug(
        `serviceTemplatesPath "${dir}" does not exist — no service templates loaded`
      )
    } else {
      CORE_LOGGER.error(`serviceTemplatesPath "${dir}" is not readable: ${e.message}`)
    }
    return []
  }

  const resolvedRoot = resolve(dir)
  const byId = new Map<string, ServiceTemplate>()
  for (const file of files) {
    // Paths inside a template are relative to the template file itself, so a flow folder is
    // self-contained and can be moved without editing it.
    const baseDir = dirname(resolve(dir, file))
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(join(dir, file), 'utf8'))
    } catch (e) {
      CORE_LOGGER.warn(
        `Skipping service template file "${file}": invalid JSON (${e.message})`
      )
      continue
    }
    // A file may be a single template object or an array of templates.
    for (const candidate of Array.isArray(raw) ? raw : [raw]) {
      const parsed = ServiceTemplateSchema.safeParse(candidate)
      if (!parsed.success) {
        CORE_LOGGER.warn(
          `Skipping invalid template in "${file}": ${parsed.error.issues
            .map((i) => i.message)
            .join('; ')}`
        )
        continue
      }
      const tmpl = parsed.data as ServiceTemplate
      if (byId.has(tmpl.id)) {
        CORE_LOGGER.warn(
          `Duplicate service template id "${tmpl.id}" (in "${file}") — keeping the first occurrence`
        )
        continue
      }
      if (tmpl.commandFile) {
        // No command means nothing to run, so an unreadable file skips the whole template.
        const content = await readTemplateFile(
          resolvedRoot,
          baseDir,
          tmpl.commandFile,
          `Skipping service template "${tmpl.id}"`
        )
        if (content === null) continue
        delete tmpl.commandFile
        tmpl.command = [content]
      }
      if (tmpl.workflows?.length) {
        // A workflow with a missing/malformed file is dropped, not the whole template.
        const resolved: ServiceTemplateWorkflow[] = []
        for (const wf of tmpl.workflows) {
          if (!wf.file) {
            resolved.push(wf)
            continue
          }
          const dropping = `Template "${tmpl.id}": dropping workflow "${wf.id}"`
          const content = await readTemplateFile(resolvedRoot, baseDir, wf.file, dropping)
          if (content === null) continue
          try {
            const { file, ...rest } = wf
            resolved.push({ ...rest, graph: JSON.parse(content) })
          } catch (e) {
            CORE_LOGGER.warn(`${dropping} — invalid JSON in "${wf.file}" (${e.message})`)
          }
        }
        tmpl.workflows = resolved
      }
      byId.set(tmpl.id, tmpl)
    }
  }
  return [...byId.values()]
}
