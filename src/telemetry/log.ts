/**
 * Telemetry diagnostics.
 *
 * Routed through the node's winston `CORE_LOGGER` rather than stdout, so telemetry bootstrap
 * messages land in the same place as the rest of the node's logs and never pollute a protocol
 * channel. Importing `CORE_LOGGER` creates the node's loggers, which open the log files
 * (logs/<module>-YYYY-MM-DD.log unless LOG_FILES=false) but start nothing else, so importing it
 * from the `--import` bootstrap is safe.
 */
import { CORE_LOGGER } from '../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../utils/logging/Logger.js'

// every caller is non-fatal (the node keeps running without telemetry): errors are warnings
export function telemetryLog(message: string, error?: unknown, level?: string): void {
  const suffix =
    error === undefined
      ? ''
      : ` — ${error instanceof Error ? error.message : String(error)}`
  const line = `[telemetry] ${message}${suffix}`
  try {
    CORE_LOGGER.log(
      level ??
        (error === undefined ? LOG_LEVELS_STR.LEVEL_INFO : LOG_LEVELS_STR.LEVEL_WARN),
      line,
      true
    )
  } catch {
    // Never let a logging failure escape the telemetry path.
  }
}
