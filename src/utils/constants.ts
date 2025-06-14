import { Hashes } from '../@types/blockchain'

// Add all the supported commands
export const PROTOCOL_COMMANDS = {
  DOWNLOAD: 'download',
  DOWNLOAD_URL: 'downloadURL', // we still use this
  ENCRYPT: 'encrypt',
  ENCRYPT_FILE: 'encryptFile',
  DECRYPT_DDO: 'decryptDDO',
  GET_DDO: 'getDDO',
  QUERY: 'query',
  NONCE: 'nonce',
  STATUS: 'status',
  DETAILED_STATUS: 'detailedStatus',
  FIND_DDO: 'findDDO',
  GET_FEES: 'getFees',
  FILE_INFO: 'fileInfo',
  VALIDATE_DDO: 'validateDDO',
  COMPUTE_GET_ENVIRONMENTS: 'getComputeEnvironments',
  COMPUTE_START: 'startCompute',
  FREE_COMPUTE_START: 'freeStartCompute',
  COMPUTE_STOP: 'stopCompute',
  COMPUTE_GET_STATUS: 'getComputeStatus',
  COMPUTE_GET_STREAMABLE_LOGS: 'getComputeStreamableLogs',
  COMPUTE_GET_RESULT: 'getComputeResult',
  COMPUTE_INITIALIZE: 'initializeCompute',
  STOP_NODE: 'stopNode',
  REINDEX_TX: 'reindexTx',
  REINDEX_CHAIN: 'reindexChain',
  HANDLE_INDEXING_THREAD: 'handleIndexingThread',
  COLLECT_FEES: 'collectFees',
  POLICY_SERVER_PASSTHROUGH: 'PolicyServerPassthrough',
  GET_P2P_PEER: 'getP2PPeer',
  GET_P2P_PEERS: 'getP2PPeers',
  GET_P2P_NETWORK_STATS: 'getP2PNetworkStats',
  FIND_PEER: 'findPeer',
  CREATE_AUTH_TOKEN: 'createAuthToken',
  INVALIDATE_AUTH_TOKEN: 'invalidateAuthToken'
}
// more visible, keep then close to make sure we always update both
export const SUPPORTED_PROTOCOL_COMMANDS: string[] = [
  PROTOCOL_COMMANDS.DOWNLOAD,
  PROTOCOL_COMMANDS.ENCRYPT,
  PROTOCOL_COMMANDS.ENCRYPT_FILE,
  PROTOCOL_COMMANDS.NONCE,
  PROTOCOL_COMMANDS.DECRYPT_DDO,
  PROTOCOL_COMMANDS.GET_DDO,
  PROTOCOL_COMMANDS.QUERY,
  PROTOCOL_COMMANDS.STATUS,
  PROTOCOL_COMMANDS.DETAILED_STATUS,
  PROTOCOL_COMMANDS.FIND_DDO,
  PROTOCOL_COMMANDS.GET_FEES,
  PROTOCOL_COMMANDS.FILE_INFO,
  PROTOCOL_COMMANDS.VALIDATE_DDO,
  PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
  PROTOCOL_COMMANDS.COMPUTE_START,
  PROTOCOL_COMMANDS.FREE_COMPUTE_START,
  PROTOCOL_COMMANDS.COMPUTE_STOP,
  PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
  PROTOCOL_COMMANDS.COMPUTE_GET_RESULT,
  PROTOCOL_COMMANDS.COMPUTE_GET_STREAMABLE_LOGS,
  PROTOCOL_COMMANDS.COMPUTE_INITIALIZE,
  PROTOCOL_COMMANDS.STOP_NODE,
  PROTOCOL_COMMANDS.REINDEX_TX,
  PROTOCOL_COMMANDS.REINDEX_CHAIN,
  PROTOCOL_COMMANDS.HANDLE_INDEXING_THREAD,
  PROTOCOL_COMMANDS.COLLECT_FEES,
  PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
  PROTOCOL_COMMANDS.GET_P2P_PEER,
  PROTOCOL_COMMANDS.GET_P2P_PEERS,
  PROTOCOL_COMMANDS.GET_P2P_NETWORK_STATS,
  PROTOCOL_COMMANDS.FIND_PEER,
  PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
  PROTOCOL_COMMANDS.INVALIDATE_AUTH_TOKEN
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
  DISPENSER_CREATED: 'DispenserCreated',
  DISPENSER_ACTIVATED: 'DispenserActivated',
  DISPENSER_DEACTIVATED: 'DispenserDeactivated',
  EXCHANGE_ACTIVATED: 'ExchangeActivated',
  EXCHANGE_DEACTIVATED: 'ExchangeDeactivated'
}

export const INDEXER_CRAWLING_EVENTS = {
  CRAWLING_STARTED: 'crawlingStarted',
  REINDEX_QUEUE_POP: 'popFromQueue', // this is for reindex tx, not chain
  // use same names as the corresponding commands for these events
  REINDEX_CHAIN: PROTOCOL_COMMANDS.REINDEX_CHAIN,
  REINDEX_TX: PROTOCOL_COMMANDS.REINDEX_TX
}

export const INDEXER_MESSAGES = {
  REINDEX_TX: PROTOCOL_COMMANDS.REINDEX_TX, // use the same names, no need to add different strings all the time
  REINDEX_CHAIN: PROTOCOL_COMMANDS.REINDEX_CHAIN,
  START_CRAWLING: 'start-crawling',
  STOP_CRAWLING: 'stop-crawling'
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
  },
  '0xe9372084cb52c5392afee4b9d79d131e04b1e65676088d50a8f39fffb16a8745': {
    type: EVENTS.DISPENSER_ACTIVATED,
    text: 'DispenserActivated(address)'
  },
  '0x393f01061139648745ea000bb047bbe1785bd3a19d3a9c90f6747e1d2357d2b8': {
    type: EVENTS.DISPENSER_DEACTIVATED,
    text: 'DispenserDeactivated(address)'
  },
  '0xc7344c45124818d1d3a4c24ccb9b86d8b88d3bd05209b2a42b494cb32a503529': {
    type: EVENTS.EXCHANGE_ACTIVATED,
    text: 'ExchangeActivated(bytes32,address)'
  },
  '0x03da9148e1de78fba22de63c573465562ebf6ef878a1d3ea83790a560229984c': {
    type: EVENTS.EXCHANGE_DEACTIVATED,
    text: 'ExchangeDeactivated(bytes32,address)'
  }
}

// this type should also move to the types folder (once we move command types)
export interface EnvVariable {
  name: string
  value: any
  required: boolean
}

export const DB_TYPES = {
  ELASTIC_SEARCH: 'elasticsearch',
  TYPESENSE: 'typesense'
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
  INDEXER_NETWORKS: {
    name: 'INDEXER_NETWORKS',
    value: process.env.INDEXER_NETWORKS,
    required: false
  },
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
  // p2p specific
  P2P_BOOTSTRAP_NODES: {
    name: 'P2P_BOOTSTRAP_NODES',
    value: process.env.P2P_BOOTSTRAP_NODES,
    required: false
  },
  P2P_ANNOUNCE_ADDRESSES: {
    name: 'P2P_ANNOUNCE_ADDRESSES',
    value: process.env.P2P_ANNOUNCE_ADDRESSES,
    required: false
  },
  P2P_FILTER_ANNOUNCED_ADDRESSES: {
    name: 'P2P_FILTER_ANNOUNCED_ADDRESSES',
    value: process.env.P2P_FILTER_ANNOUNCED_ADDRESSES,
    required: false
  },
  // node specific
  NODE_ENV: { name: 'NODE_ENV', value: process.env.NODE_ENV, required: false },
  AUTHORIZED_DECRYPTERS: {
    name: 'AUTHORIZED_DECRYPTERS',
    value: process.env.AUTHORIZED_DECRYPTERS,
    required: false
  },
  AUTHORIZED_DECRYPTERS_LIST: {
    name: 'AUTHORIZED_DECRYPTERS_LIST',
    value: process.env.AUTHORIZED_DECRYPTERS_LIST,
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
  ALLOWED_VALIDATORS_LIST: {
    name: 'ALLOWED_VALIDATORS_LIST',
    value: process.env.ALLOWED_VALIDATORS_LIST,
    required: false
  },
  INDEXER_INTERVAL: {
    name: 'INDEXER_INTERVAL',
    value: process.env.INDEXER_INTERVAL,
    required: false // without a value set, it defaults to 30 secs
  },
  LOG_RETENTION_TIME: {
    name: 'LOG_RETENTION_TIME',
    value: process.env.LOG_RETENTION_TIME,
    required: false
  },
  ALLOWED_ADMINS: {
    name: 'ALLOWED_ADMINS',
    value: process.env.ALLOWED_ADMINS,
    required: false
  },
  ALLOWED_ADMINS_LIST: {
    name: 'ALLOWED_ADMINS_LIST',
    value: process.env.ALLOWED_ADMINS_LIST,
    required: false
  },
  ASSET_PURGATORY_URL: {
    name: 'ASSET_PURGATORY_URL',
    value: process.env.ASSET_PURGATORY_URL,
    required: false
  },
  ACCOUNT_PURGATORY_URL: {
    name: 'ACCOUNT_PURGATORY_URL',
    value: process.env.ACCOUNT_PURGATORY_URL,
    required: false
  },
  CONTROL_PANEL: {
    name: 'CONTROL_PANEL',
    // keep this for backwards compatibility for now
    value: process.env.CONTROL_PANEL || process.env.DASHBOARD,
    required: false
  },
  MAX_REQ_PER_MINUTE: {
    // rate limit per minute (MAX requests per minute for a given IP or peer ID)
    name: 'MAX_REQ_PER_MINUTE',
    value: process.env.MAX_REQ_PER_MINUTE,
    required: false
  },
  MAX_CONNECTIONS_PER_MINUTE: {
    // rate connections limit per minute (MAX requests per minute that the node will process)
    name: 'MAX_CONNECTIONS_PER_MINUTE',
    value: process.env.MAX_CONNECTIONS_PER_MINUTE,
    required: false
  },
  RATE_DENY_LIST: {
    // rate limit / deny list (peers and ips)
    name: 'RATE_DENY_LIST',
    value: process.env.RATE_DENY_LIST,
    required: false
  },
  MAX_CHECKSUM_LENGTH: {
    // c2d, maximum length for a file if checksum is required.
    name: 'MAX_CHECKSUM_LENGTH',
    value: process.env.MAX_CHECKSUM_LENGTH,
    required: false
  },
  LOG_LEVEL: {
    // default log level (if not specified, "debug" for "development" and "info" for "production")
    name: 'LOG_LEVEL',
    value: process.env.LOG_LEVEL,
    required: false
  },
  LOG_CONSOLE: {
    // log to console output? true if no other bellow is set
    name: 'LOG_CONSOLE',
    value: process.env.LOG_CONSOLE,
    required: false
  },
  LOG_FILES: {
    // log to files?
    name: 'LOG_FILES',
    value: process.env.LOG_FILES,
    required: false
  },
  LOG_DB: {
    // log to DB?
    name: 'LOG_DB',
    value: process.env.LOG_DB,
    required: false
  },
  UNSAFE_URLS: {
    name: 'UNSAFE_URLS',
    value: process.env.UNSAFE_URLS,
    required: false
  },
  DB_TYPE: {
    name: 'DB_TYPE',
    value: process.env.DB_TYPE,
    required: false
  },
  CRON_DELETE_DB_LOGS: {
    name: 'CRON_DELETE_DB_LOGS',
    value: process.env.CRON_DELETE_DB_LOGS,
    required: false
  },
  CRON_CLEANUP_C2D_STORAGE: {
    name: 'CRON_CLEANUP_C2D_STORAGE',
    value: process.env.CRON_CLEANUP_C2D_STORAGE,
    required: false
  },
  DOCKER_COMPUTE_ENVIRONMENTS: {
    name: 'DOCKER_COMPUTE_ENVIRONMENTS',
    value: process.env.DOCKER_COMPUTE_ENVIRONMENTS,
    required: false
  },
  DOCKER_SOCKET_PATH: {
    name: 'DOCKER_SOCKET_PATH',
    value: process.env.DOCKER_SOCKET_PATH,
    required: false
  },
  DOCKER_PROTOCOL: {
    name: 'DOCKER_PROTOCOL',
    value: process.env.DOCKER_PROTOCOL,
    required: false
  },
  DOCKER_HOST: {
    name: 'DOCKER_HOST',
    value: process.env.DOCKER_HOST,
    required: false
  },
  DOCKER_PORT: {
    name: 'DOCKER_PORT',
    value: process.env.DOCKER_PORT,
    required: false
  },
  DOCKER_CA_PATH: {
    name: 'DOCKER_CA_PATH',
    value: process.env.DOCKER_CA_PATH,
    required: false
  },
  DOCKER_CERT_PATH: {
    name: 'DOCKER_CERT_PATH',
    value: process.env.DOCKER_CERT_PATH,
    required: false
  },
  DOCKER_KEY_PATH: {
    name: 'DOCKER_KEY_PATH',
    value: process.env.DOCKER_KEY_PATH,
    required: false
  },
  IS_BOOTSTRAP: {
    name: 'IS_BOOTSTRAP',
    value: process.env.IS_BOOTSTRAP,
    required: false
  },
  AUTHORIZED_PUBLISHERS: {
    name: 'AUTHORIZED_PUBLISHERS',
    value: process.env.AUTHORIZED_PUBLISHERS,
    required: false
  },
  AUTHORIZED_PUBLISHERS_LIST: {
    name: 'AUTHORIZED_PUBLISHERS_LIST',
    value: process.env.AUTHORIZED_PUBLISHERS_LIST,
    required: false
  },
  POLICY_SERVER_URL: {
    name: 'POLICY_SERVER_URL',
    value: process.env.POLICY_SERVER_URL,
    required: false
  },
  VALIDATE_UNSIGNED_DDO: {
    name: 'VALIDATE_UNSIGNED_DDO',
    value: process.env.VALIDATE_UNSIGNED_DDO,
    required: false
  }
}
export const CONNECTION_HISTORY_DELETE_THRESHOLD = 300
// default to 30 requests per minute (configurable), per ip/peer
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 30
// max connections per minute (configurable), all connections
export const DEFAULT_MAX_CONNECTIONS_PER_MINUTE = 60 * 2 // 120 requests per minute
// 1 minute
export const CONNECTIONS_RATE_INTERVAL = 60 * 1000
// Typesense's maximum limit to send 250 hits at a time
export const TYPESENSE_HITS_CAP = 250
export const DDO_IDENTIFIER_PREFIX = 'did:op:'
// global ocean node API services path
export const SERVICES_API_BASE_PATH = '/api/services'

export const defaultBootstrapAddresses = [
  // Public IPFS bootstraps
  // '/ip4/104.131.131.82/tcp/4001/ipfs/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
  // '/dnsaddr/bootstrap.libp2p.io/ipfs/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  // '/dnsaddr/bootstrap.libp2p.io/ipfs/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  // OPF nodes
  //  node1
  '/dns4/node1.oceanprotocol.com/tcp/9000/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
  '/dns4/node1.oceanprotocol.com/tcp/9001/ws/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
  '/dns6/node1.oceanprotocol.com/tcp/9002/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
  '/dns6/node1.oceanprotocol.com/tcp/9003/ws/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
  // node 2
  '/dns4/node2.oceanprotocol.com/tcp/9000/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
  '/dns4/node2.oceanprotocol.com/tcp/9001/ws/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
  '/dns6/node2.oceanprotocol.com/tcp/9002/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
  '/dns6/node2.oceanprotocol.com/tcp/9003/ws/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
  // node 3
  '/dns4/node3.oceanprotocol.com/tcp/9000/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
  '/dns4/node3.oceanprotocol.com/tcp/9001/ws/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
  '/dns6/node3.oceanprotocol.com/tcp/9002/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
  '/dns6/node3.oceanprotocol.com/tcp/9003/ws/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
  // node 4
  '/dns4/node4.oceanprotocol.com/tcp/9000/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom',
  '/dns4/node4.oceanprotocol.com/tcp/9001/ws/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom',
  '/dns6/node4.oceanprotocol.com/tcp/9002/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom',
  '/dns6/node4.oceanprotocol.com/tcp/9003/ws/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom'
]

export const knownUnsafeURLs: string[] = [
  // AWS and GCP
  '^.*(169.254.169.254).*',
  // GCP
  '^.*(metadata.google.internal).*',
  '^.*(http://metadata).*',
  // Azure
  '^.*(http://169.254.169.254).*',
  // Oracle Cloud
  '^.*(http://192.0.0.192).*',
  // Alibaba Cloud
  '^.*(http://100.100.100.200).*',
  // k8s ETCD
  '^.*(127.0.0.1).*'
]
