import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
// type-only import so this leaf util does not create a runtime import cycle with OceanNode.ts
import type { OceanNode } from '../../../OceanNode.js'
import {
  MAINTENANCE_MODE_CODE,
  MAINTENANCE_MODE_ERROR
} from '../../../utils/constants.js'

// HTTP 503 Service Unavailable — the correct "temporarily unavailable, retry elsewhere" family.
// NOTE: 503 is already reused in these handlers for "subsystem unavailable" (e.g. "Compute
// engines not configured"), so clients MUST discriminate on the `code` field, not the status.
const MAINTENANCE_HTTP_STATUS = 503

// Builds the maintenance rejection response. The `code` rides in BOTH the P2P status frame
// (status.code, serialized over the wire) AND the streamed JSON body, because the HTTP layer
// only forwards the stream body + the status line to the client — never arbitrary status
// fields. So the body is what makes `code` reach an HTTP/ocean.js caller.
export function buildMaintenanceResponse(): P2PCommandResponse {
  return {
    stream: Readable.from(
      JSON.stringify({ error: MAINTENANCE_MODE_ERROR, code: MAINTENANCE_MODE_CODE })
    ),
    status: {
      httpStatus: MAINTENANCE_HTTP_STATUS,
      error: MAINTENANCE_MODE_ERROR,
      code: MAINTENANCE_MODE_CODE
    }
  }
}

// Single gating helper shared by every guarded handler: returns the maintenance rejection
// response when the node is draining, or null to let the request proceed.
export function maintenanceGuard(node: OceanNode): P2PCommandResponse | null {
  return node.isInMaintenance() ? buildMaintenanceResponse() : null
}
