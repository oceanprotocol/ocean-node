import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { ServiceTemplate } from '../../../@types/C2D/ServiceOnDemand.js'
import { ServiceTemplateSchema } from '../../../utils/config/schemas.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

// Re-reads on every call so operators can add/edit/remove template files without a restart.
// (If profiling ever shows this is hot, add an mtime-keyed cache — semantics stay identical.)
export async function loadServiceTemplates(dir?: string): Promise<ServiceTemplate[]> {
  if (!dir) return [] // safety net; in practice the config schema always supplies the default

  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.json')).sort() // deterministic order → stable duplicate resolution
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

  const byId = new Map<string, ServiceTemplate>()
  for (const file of files) {
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
      byId.set(tmpl.id, tmpl)
    }
  }
  return [...byId.values()]
}
