import { Hashes } from '../@types/blockchain'

// Add all the supported commands
export const PROTOCOL_COMMANDS = {
  DOWNLOAD: 'download',
  DOWNLOAD_URL: 'downloadURL', // we still use this
  REINDEX: 'reIndex',
  ECHO: 'echo',
  ENCRYPT: 'encrypt',
  ENCRYPT_FILE: 'encryptFile',
  DECRYPT_DDO: 'decryptDDO',
  GET_DDO: 'getDDO',
  QUERY: 'query',
  NONCE: 'nonce',
  STATUS: 'status',
  FIND_DDO: 'findDDO',
  GET_FEES: 'getFees',
  FILE_INFO: 'fileInfo',
  VALIDATE_DDO: 'validateDDO',
  COMPUTE_GET_ENVIRONMENTS: 'getComputeEnvironments',
  COMPUTE_START: 'startCompute',
  COMPUTE_STOP: 'stopCompute',
  COMPUTE_GET_STATUS: 'getComputeStatus',
  COMPUTE_GET_RESULT: 'getComputeResult',
  COMPUTE_INITIALIZE: 'initializeCompute',
  STOP_NODE: 'stopNode'
}
// more visible, keep then close to make sure we always update both
export const SUPPORTED_PROTOCOL_COMMANDS: string[] = [
  PROTOCOL_COMMANDS.DOWNLOAD,
  PROTOCOL_COMMANDS.REINDEX,
  PROTOCOL_COMMANDS.ECHO,
  PROTOCOL_COMMANDS.ENCRYPT,
  PROTOCOL_COMMANDS.ENCRYPT_FILE,
  PROTOCOL_COMMANDS.NONCE,
  PROTOCOL_COMMANDS.DECRYPT_DDO,
  PROTOCOL_COMMANDS.GET_DDO,
  PROTOCOL_COMMANDS.QUERY,
  PROTOCOL_COMMANDS.STATUS,
  PROTOCOL_COMMANDS.FIND_DDO,
  PROTOCOL_COMMANDS.GET_FEES,
  PROTOCOL_COMMANDS.FILE_INFO,
  PROTOCOL_COMMANDS.VALIDATE_DDO,
  PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
  PROTOCOL_COMMANDS.COMPUTE_START,
  PROTOCOL_COMMANDS.COMPUTE_STOP,
  PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
  PROTOCOL_COMMANDS.COMPUTE_GET_RESULT,
  PROTOCOL_COMMANDS.COMPUTE_INITIALIZE,
  PROTOCOL_COMMANDS.STOP_NODE
]

export const MetadataStates = {
  ACTIVE: 0,
  END_OF_LIFE: 1,
  DEPRECATED: 2,
  REVOKED: 3,
  ORDERING_DISABLED: 4,
  UNLISTED: 5
}

export const EVENTS = {
  METADATA_CREATED: 'MetadataCreated',
  METADATA_UPDATED: 'MetadataUpdated',
  METADATA_STATE: 'MetadataState',
  ORDER_STARTED: 'OrderStarted',
  ORDER_REUSED: 'OrderReused',
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
  '0x526e31449ea46e2aecf9b480c8d7dfa191348ef74ffdf75b445a6ab726daa6ff': {
    type: EVENTS.ORDER_REUSED,
    text: 'OrderReused(bytes32,address,uint256,uint256)'
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

// this type should also move to the types folder (once we move command types)
export interface EnvVariable {
  name: string
  value: any
  required: boolean
}

// usefull to keep track of what all the env variables we are using
// (faster to read than README and we can easily use the constants if needed)
// required means its not mandatory OR we have defaults
export const ENVIRONMENT_VARIABLES: Record<any, EnvVariable> = {
  HTTP_API_PORT: {
    name: 'HTTP_API_PORT',
    value: process.env.HTTP_API_PORT,
    required: false
  },
  PRIVATE_KEY: { name: 'PRIVATE_KEY', value: process.env.PRIVATE_KEY, required: true },
  // used on test environments (ci)
  NODE1_PRIVATE_KEY: {
    name: 'NODE1_PRIVATE_KEY',
    value: process.env.NODE1_PRIVATE_KEY,
    required: false
  },
  NODE2_PRIVATE_KEY: {
    name: 'NODE2_PRIVATE_KEY',
    value: process.env.NODE2_PRIVATE_KEY,
    required: false
  },
  RPCS: { name: 'RPCS', value: process.env.RPCS, required: false },
  DB_URL: { name: 'DB_URL', value: process.env.DB_URL, required: false },
  // these 2 bellow will change in the future (not required, just remove functionality)
  IPFS_GATEWAY: {
    name: 'IPFS_GATEWAY',
    value: process.env.IPFS_GATEWAY,
    required: false
  },
  ARWEAVE_GATEWAY: {
    name: 'ARWEAVE_GATEWAY',
    value: process.env.ARWEAVE_GATEWAY,
    required: false
  },
  LOAD_INITIAL_DDOS: {
    name: 'LOAD_INITIAL_DDOS',
    value: process.env.LOAD_INITIAL_DDOS,
    required: false
  },
  FEE_TOKENS: { name: 'FEE_TOKENS', value: process.env.FEE_TOKENS, required: false },
  FEE_AMOUNT: { name: 'FEE_AMOUNT', value: process.env.FEE_AMOUNT, required: false },
  ADDRESS_FILE: {
    name: 'ADDRESS_FILE',
    value: process.env.ADDRESS_FILE,
    required: false
  },
  // node specific
  NODE_ENV: { name: 'NODE_ENV', value: process.env.NODE_ENV, required: false },
  AUTHORIZED_DECRYPTERS: {
    name: 'AUTHORIZED_DECRYPTERS',
    value: process.env.AUTHORIZED_DECRYPTERS,
    required: false
  },
  OPERATOR_SERVICE_URL: {
    name: 'OPERATOR_SERVICE_URL',
    value: process.env.OPERATOR_SERVICE_URL,
    required: false // without provider we don't have it
  },
  INTERFACES: {
    name: 'INTERFACES',
    value: process.env.INTERFACES,
    required: false // without a value set, its both p2p2 and http
  },
  ALLOWED_VALIDATORS: {
    name: 'ALLOWED_VALIDATORS',
    value: process.env.ALLOWED_VALIDATORS,
    required: false
  },
  INDEXER_INTERVAL: {
    name: 'INDEXER_INTERVAL',
    value: process.env.INDEXER_INTERVAL,
    required: false // without a value set, it defaults to 30 secs
  },
  ALLOWED_ADMINS: {
    name: 'ALLOWED_ADMINS',
    value: process.env.ALLOWED_ADMINS,
    required: false
  }
}
