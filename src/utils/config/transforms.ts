import { z } from 'zod'
import { CONFIG_LOGGER } from '../logging/common.js'

export const numberFromString = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'string' ? parseInt(v, 10) : v))

export const booleanFromString = z.union([z.boolean(), z.string()]).transform((v) => {
  if (typeof v === 'string') {
    return v === 'true' || v === '1' || v.toLowerCase() === 'yes'
  }
  return v
})

export const jsonFromString = <T>(schema: z.ZodType<T>) =>
  z.union([schema, z.string()]).transform((v) => {
    if (typeof v === 'string') {
      try {
        return JSON.parse(v)
      } catch (error) {
        CONFIG_LOGGER.warn(`Failed to parse JSON: ${error.message}`)
        return v
      }
    }
    return v
  })
