/**
 * Telemetry diagnostics.
 *
 * Routed through the node's winston `CORE_LOGGER` rather than stdout, so telemetry bootstrap
 * messages land in the same place as the rest of the node's logs and never pollute a protocol
 * channel. Loading `CORE_LOGGER` is cheap and side-effect-free, so importing it from the
 * `--import` bootstrap is safe.
 */
import { CORE_LOGGER } from '../utils/logging/common.js'

export function telemetryLog(message: string, error?: unknown): void {
  const suffix =
    error === undefined
      ? ''
      : ` — ${error instanceof Error ? error.message : String(error)}`
  const line = `[telemetry] ${message}${suffix}`
  try {
    if (error === undefined) {
      CORE_LOGGER.info(line)
    } else {
      CORE_LOGGER.error(line)
    }
  } catch {
    // Never let a logging failure escape the telemetry path.
  }
}
