import { z } from 'zod'
import { CONFIG_LOGGER } from '../logging/common.js'
import { errorSummary } from '../logging/redact.js'

export const booleanFromString = z.union([z.boolean(), z.string()]).transform((v) => {
  if (typeof v === 'string') {
    return v === 'true' || v === '1' || v.toLowerCase() === 'yes'
  }
  return v
})

export const jsonFromString = <T>(schema: z.ZodType<T>, field?: string) =>
  z.union([schema, z.string(), z.undefined()]).transform((v) => {
    if (v === undefined || v === 'undefined') {
      return undefined
    }
    if (typeof v === 'string') {
      try {
        return JSON.parse(v)
      } catch (error) {
        CONFIG_LOGGER.warn(
          `Failed to parse JSON${field ? ` for ${field}` : ''}: ${errorSummary(error)}`
        )
        return v
      }
    }
    return v
  })
