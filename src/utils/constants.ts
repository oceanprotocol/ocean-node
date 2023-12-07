import { Hashes } from '../@types/blockchain'
import { DDO } from '../@types/DDO/DDO'
import { P2PCommandResponse } from '../@types/OceanNode'

// Add all the supported commands
export const PROTOCOL_COMMANDS = {
  DOWNLOAD_URL: 'downloadURL',
  ECHO: 'echo',
  ENCRYPT: 'encrypt',
  GET_DDO: 'getDDO',
  QUERY: 'query',
  NONCE: 'nonce',
  STATUS: 'status',
  FIND_DDO: 'findDDO',
  GET_FEES: 'getFees'
}

export interface Command {
  command: string
  node?: string // if not present it means current node
}

export interface DownloadURLCommand extends Command {
  url: string
  aes_encrypted_key?: string // if not present it means download without encryption
}

export interface DownloadCommand extends Command {
  documentId: string
  serviceId: string
  transferTxId: string
  fileIndex: number
  nonce: string
  consumerAddress: string
  signature: string
  url: string
  aes_encrypted_key?: string // if not present it means download without encryption
}

// group these 2
export interface DDOCommand extends Command {
  id: string
}
export interface GetDdoCommand extends DDOCommand {}
export interface FindDDOCommand extends DDOCommand {}

export interface QueryCommand extends Command {
  query: Record<string, any>
}

export interface EncryptCommand extends Command {
  blob: string
  encoding: string
  encryptionType: string
}

export interface NonceCommand extends Command {
  address: string // consumer address
}

export interface GetFeesCommand extends Command {
  ddo: DDO
  serviceId: string
}

export interface ICommandHandler {
  handleCommand(command: Command): Promise<P2PCommandResponse>
}

export interface BroadcastCommand {
  command: string // the name of the command
  message: any // the message to broadcast
}

export const SUPPORTED_PROTOCOL_COMMANDS: string[] = [
  PROTOCOL_COMMANDS.DOWNLOAD_URL,
  PROTOCOL_COMMANDS.ECHO,
  PROTOCOL_COMMANDS.ENCRYPT,
  PROTOCOL_COMMANDS.NONCE,
  PROTOCOL_COMMANDS.GET_DDO,
  PROTOCOL_COMMANDS.QUERY,
  PROTOCOL_COMMANDS.STATUS,
  PROTOCOL_COMMANDS.FIND_DDO,
  PROTOCOL_COMMANDS.GET_FEES
]

export const EVENTS = {
  METADATA_CREATED: 'MetadataCreated',
  METADATA_UPDATED: 'MetadataUpdated',
  METADATA_STATE: 'MetadataState',
  ORDER_STARTED: 'OrderStarted',
  TOKEN_URI_UPDATE: 'TokenURIUpdate',
  EXCHANGE_CREATED: 'ExchangeCreated',
  EXCHANGE_RATE_CHANGED: 'ExchangeRateChanged',
  DISPENSER_CREATED: 'DispenserCreated'
}

export const EVENT_HASHES: Hashes = {
  '0x5463569dcc320958360074a9ab27e809e8a6942c394fb151d139b5f7b4ecb1bd': {
    type: EVENTS.METADATA_CREATED,
    text: 'MetadataCreated(address,uint8,string,bytes,bytes,bytes32,uint256,uint256)'
  },
  '0xe5c4cf86b1815151e6f453e1e133d4454ae3b0b07145db39f2e0178685deac84': {
    type: EVENTS.METADATA_UPDATED,
    text: 'MetadataUpdated(address,uint8,string,bytes,bytes,bytes32,uint256,uint256)'
  },
  '0xa8336411cc72db0e5bdc4dff989eeb35879bafaceffb59b54b37645c3395adb9': {
    type: EVENTS.METADATA_STATE,
    text: 'MetadataState(address,uint8,uint256,uint256)'
  },
  '0xe1c4fa794edfa8f619b8257a077398950357b9c6398528f94480307352f9afcc': {
    type: EVENTS.ORDER_STARTED,
    text: 'OrderStarted(address,address,uint256,uint256,uint256,address,uint256)'
  },
  '0x6de6cd3982065cbd31e789e3109106f4d76d1c8a46e85262045cf947fb3fd4ed': {
    type: EVENTS.TOKEN_URI_UPDATE,
    text: 'TokenURIUpdate(address,string,uint256,uint256,uint256)'
  },
  '0xeb7a353641f7d3cc54b497ef1553fdc292b64d9cc3be8587c23dfba01f310b19': {
    type: EVENTS.EXCHANGE_CREATED,
    text: 'ExchangeCreated(bytes32,address,address,address,uint256)'
  },
  '0xe50f9919fdc524004a4ee0cb934f4734f144bec0713a52e5483b753f5de0f08c': {
    type: EVENTS.EXCHANGE_RATE_CHANGED,
    text: 'ExchangeRateChanged(bytes32,address,uint256)'
  },
  '0x7d0aa581e6eb87e15f58588ff20c39ff6622fc796ec9bb664df6ed3eb02442c9': {
    type: EVENTS.DISPENSER_CREATED,
    text: 'DispenserCreated(address,address,uint256,uint256,address)'
  }
}
