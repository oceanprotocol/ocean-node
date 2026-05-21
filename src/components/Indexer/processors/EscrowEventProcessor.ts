import { ethers, Signer, FallbackProvider, Interface } from 'ethers'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import { getContractAddress } from '../utils.js'
import { EVENTS } from '../../../utils/constants.js'
import { EscrowEvent } from '../../../@types/Escrow.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' with { type: 'json' }

const escrowInterface = new Interface(EscrowJson.abi)

const addr = (v: any): string => v?.toString().toLowerCase()
const num = (v: any): string => v?.toString()

export class EscrowEventProcessor extends BaseEventProcessor {
  private readonly escrowAddress: string

  constructor(chainId: number, config: OceanNodeConfig) {
    super(chainId, config)
    this.escrowAddress = getContractAddress(chainId, 'Escrow')
  }

  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider,
    eventName?: string
  ): Promise<any> {
    try {
      if (
        !this.escrowAddress ||
        event.address.toLowerCase() !== this.escrowAddress.toLowerCase()
      ) {
        return null
      }

      const decoded = escrowInterface.parseLog({
        topics: Array.from(event.topics),
        data: event.data
      })
      if (!decoded) return null

      const { args } = decoded
      const record: EscrowEvent = {
        id: `${event.transactionHash}-${event.index}`,
        eventType: eventName,
        chainId,
        contract: event.address.toLowerCase(),
        block: event.blockNumber,
        txHash: event.transactionHash
      }

      switch (eventName) {
        case EVENTS.ESCROW_AUTH:
          record.payer = addr(args.payer)
          record.payee = addr(args.payee)
          record.maxLockedAmount = num(args.maxLockedAmount)
          record.maxLockSeconds = num(args.maxLockSeconds)
          record.maxLockCounts = num(args.maxLockCounts)
          break
        case EVENTS.ESCROW_LOCK:
          record.payer = addr(args.payer)
          record.payee = addr(args.payee)
          record.jobId = num(args.jobId)
          record.amount = num(args.amount)
          record.expiry = num(args.expiry)
          record.token = addr(args.token)
          break
        case EVENTS.ESCROW_CLAIMED:
          record.payee = addr(args.payee)
          record.jobId = num(args.jobId)
          record.token = addr(args.token)
          record.payer = addr(args.payer)
          record.amount = num(args.amount)
          record.proof = args.proof?.toString()
          break
        case EVENTS.ESCROW_CANCELED:
          record.payee = addr(args.payee)
          record.jobId = num(args.jobId)
          record.token = addr(args.token)
          record.payer = addr(args.payer)
          record.amount = num(args.amount)
          break
        case EVENTS.ESCROW_DEPOSIT:
        case EVENTS.ESCROW_WITHDRAW:
          record.payer = addr(args.payer)
          record.token = addr(args.token)
          record.amount = num(args.amount)
          break
        default:
          return null
      }

      const { escrow } = await this.getDatabase()
      if (!escrow) return null
      const result = await escrow.create(record)
      INDEXER_LOGGER.logMessage(
        `[Escrow] ${eventName} indexed for tx ${event.transactionHash} on chain ${chainId}`
      )
      return result
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error processing Escrow ${eventName} event: ${err.message}`,
        true
      )
      return null
    }
  }
}
