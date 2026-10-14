import { CommandHandler } from './handler.js'
import { GetEscrowEventsCommand, RangeFilter } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import {
  ESCROW_EVENTS,
  MAX_ESCROW_CLIENT_SCAN,
  TYPESENSE_HITS_CAP
} from '../../../utils/constants.js'
import {
  validateEscrowRanges,
  splitRanges,
  passesClientRanges
} from '../../database/escrowSearch.js'

export class EscrowEventsHandler extends CommandHandler {
  validate(command: GetEscrowEventsCommand): ValidateParams {
    if (command.eventType && !ESCROW_EVENTS.includes(command.eventType)) {
      return {
        valid: false,
        status: 400,
        reason: `eventType must be one of: ${ESCROW_EVENTS.join(', ')}`
      }
    }
    const rangeCheck = validateEscrowRanges(command.ranges)
    if (!rangeCheck.valid) {
      return { valid: false, status: 400, reason: rangeCheck.reason }
    }
    // NOTE: intentionally no auth check here — getEscrowEvents is a public read on both the
    // P2P and HTTP paths. Do not add a token/signature gate.
    return validateCommandParameters(command, [])
  }

  async handle(task: GetEscrowEventsCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const database = await this.getOceanNode().getDatabase()
      if (!database || !database.escrow) {
        CORE_LOGGER.error('Escrow database is not available')
        return {
          stream: null,
          status: { httpStatus: 503, error: 'Escrow database is not available' }
        }
      }

      const { nativeRanges, clientRanges } = splitRanges(task.ranges)

      const filters: Record<string, any> = {
        chainId: task.chainId,
        eventType: task.eventType,
        payer: typeof task.payer === 'string' ? task.payer.toLowerCase() : undefined,
        payee: typeof task.payee === 'string' ? task.payee.toLowerCase() : undefined,
        token: typeof task.token === 'string' ? task.token.toLowerCase() : undefined,
        provider:
          typeof task.provider === 'string' ? task.provider.toLowerCase() : undefined,
        contract: typeof task.contract === 'string' ? task.contract : undefined,
        jobId: task.jobId,
        txHash: task.txId,
        reclaimable: typeof task.reclaimable === 'boolean' ? task.reclaimable : undefined
      }
      // native (store-side) ranges are merged into the filters map passed to the DB
      for (const [field, range] of Object.entries(nativeRanges)) {
        filters[field] = range
      }

      let result: Record<string, any>[]
      if (Object.keys(clientRanges).length === 0) {
        result = (await database.escrow.search(filters, task.offset, task.size)) || []
      } else {
        result = await this.searchWithClientRanges(
          database,
          filters,
          clientRanges,
          task.offset,
          task.size
        )
      }

      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in EscrowEventsHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }

  // Range filters on uint256 fields (stored as strings) can't be pushed to the store, so we
  // page through the store-side matches (equality + native ranges) and apply the BigInt range
  // predicate client-side, then slice to the requested offset/size. Bounded by
  // MAX_ESCROW_CLIENT_SCAN so a selective filter can't trigger unbounded deep pagination.
  private async searchWithClientRanges(
    database: any,
    filters: Record<string, any>,
    clientRanges: Record<string, RangeFilter>,
    offset?: number,
    size?: number
  ): Promise<Record<string, any>[]> {
    const wantOffset = offset && offset > 0 ? offset : 0
    const wantSize = size && size > 0 ? size : 100
    const needed = wantOffset + wantSize
    const pageSize = TYPESENSE_HITS_CAP

    const matched: Record<string, any>[] = []
    let scanned = 0
    let from = 0
    while (scanned < MAX_ESCROW_CLIENT_SCAN) {
      const page = await database.escrow.search(filters, from, pageSize)
      if (!page || page.length === 0) break
      scanned += page.length
      for (const record of page) {
        if (passesClientRanges(record, clientRanges)) matched.push(record)
      }
      if (matched.length >= needed) break
      if (page.length < pageSize) break // last page reached
      from += pageSize
    }
    return matched.slice(wantOffset, wantOffset + wantSize)
  }
}
