import { Hashes } from '../@types/blockchain'

// Add all the supported commands
export const PROTOCOL_COMMANDS = {
  DOWNLOAD_URL: 'downloadURL',
  ECHO: 'echo',
  GET_DDO: 'getDDO',
  QUERY: 'query',
  NONCE: 'nonce',
  STATUS: 'status',
  FIND_DDO: 'findDDO'
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

export interface GetDdoCommand extends Command {
  id: string
}

export interface QueryCommand extends Command {
  query: Record<string, any>
}

export interface FindDDOCommand extends Command {
  id: string
}

export interface NonceCommand extends Command {
  address: string // consumer address
}

export interface BroadcastCommand {
  command: string // the name of the command
  message: any // the message to broadcast
}

export const SUPPORTED_PROTOCOL_COMMANDS: string[] = [
  PROTOCOL_COMMANDS.DOWNLOAD_URL,
  PROTOCOL_COMMANDS.ECHO,
  PROTOCOL_COMMANDS.NONCE,
  PROTOCOL_COMMANDS.GET_DDO,
  PROTOCOL_COMMANDS.QUERY,
  PROTOCOL_COMMANDS.STATUS,
  PROTOCOL_COMMANDS.FIND_DDO
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
  '0x49a0cb7b80992c55744fa9510891b184199580af9b73325e21762948f7888a77': {
    type: EVENTS.METADATA_CREATED,
    text: 'MetadataCreated(address,uint8,string,bytes,bytes,bytes32,uint256,uint256)'
  },
  '0xaf0b9caa897afc5b9f6208c36ea2c50351f8e088b4bee51440a1330d05eb2e8a': {
    type: EVENTS.METADATA_UPDATED,
    text: 'MetadataUpdated(address,uint8,string,bytes,bytes,bytes32,uint256,uint256)'
  },
  '0x056552682cb72b6d2f83b680448227c7d121380339479973c99183ebc337d788': {
    type: EVENTS.METADATA_STATE,
    text: 'MetadataState(address,uint8,uint256,uint256)'
  },
  '0x268159b701772a7382794d5b17328545580f36991476451c7732c30c57226ab9': {
    type: EVENTS.ORDER_STARTED,
    text: 'OrderStarted(address,address,uint256,uint256,uint256,address,uint256)'
  },
  '0x9458647365c67324704eb848764bbfc86f3873841b0d8b47a083f6f6e1da3f84': {
    type: EVENTS.TOKEN_URI_UPDATE,
    text: 'TokenURIUpdate(address,string,uint256,uint256,uint256)'
  },
  '0x8147a9bcf6529d4216416e32d973025d3f8552b83896393d6461d2b921121d60': {
    type: EVENTS.EXCHANGE_CREATED,
    text: 'ExchangeCreated(bytes32,address,address,address,uint256)'
  },
  '0x5177204eb696c41e8463352544392b4227b66e0f53a7e403298478b9911e4174': {
    type: EVENTS.EXCHANGE_RATE_CHANGED,
    text: 'ExchangeRateChanged(bytes32,address,uint256)'
  },
  '0x4c66b3317d9653f5c59b4379c44fa754823849a2b3a213c76b99f774702b9043': {
    type: EVENTS.DISPENSER_CREATED,
    text: 'DispenserCreated(address,address,uint256,uint256,address)'
  }
}
