import type { MetadataAlgorithm } from './DDO/Metadata.js'
import type { Command } from './commands.js'
export interface Compute {
  env: string // with hash
  validUntil: number
}

export interface ComputeAsset {
  url?: string
  documentId: string
  serviceId: string
  transferTxId?: string
  userdata?: { [key: string]: any }
}

export interface ComputeAlgorithm {
  documentId?: string
  serviceId?: string
  url?: string
  meta?: MetadataAlgorithm
  transferTxId?: string
  algocustomdata?: { [key: string]: any }
  userdata?: { [key: string]: any }
}

export interface InitializeComputeCommand extends Command {
  datasets: [ComputeAsset]
  algorithm: ComputeAlgorithm
  compute: Compute
  consumerAddress: string
  chainId: number
}
