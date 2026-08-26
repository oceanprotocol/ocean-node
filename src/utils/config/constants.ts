export const ENV_TO_CONFIG_MAPPING = {
  PRIVATE_KEY: 'keys.privateKey',
  INTERFACES: 'INTERFACES',
  DB_URL: 'DB_URL',
  DB_USERNAME: 'DB_USERNAME',
  DB_PASSWORD: 'DB_PASSWORD',
  DB_TYPE: 'DB_TYPE',
  // NOTE: deliberately flat (not under dbConfig.*) — preprocessConfigData() rebuilds
  // data.dbConfig from scratch when DB_URL is set, which would drop anything nested there.
  DB_INIT_MAX_ATTEMPTS: 'dbInitMaxAttempts',
  DB_INIT_RETRY_DELAY: 'dbInitRetryDelay',
  DB_INIT_MAX_RETRY_DELAY: 'dbInitMaxRetryDelay',
  FEE_AMOUNT: 'FEE_AMOUNT',
  FEE_TOKENS: 'FEE_TOKENS',
  HTTP_API_PORT: 'httpPort',
  RPCS: 'supportedNetworks',
  IPFS_GATEWAY: 'ipfsGateway',
  ARWEAVE_GATEWAY: 'arweaveGateway',
  ACCOUNT_PURGATORY_URL: 'accountPurgatoryUrl',
  ASSET_PURGATORY_URL: 'assetPurgatoryUrl',
  UNSAFE_URLS: 'unsafeURLs',
  IS_BOOTSTRAP: 'isBootstrap',
  ESCROW_CLAIM_TIMEOUT: 'claimDurationTimeout',
  VALIDATE_UNSIGNED_DDO: 'validateUnsignedDDO',
  JWT_SECRET: 'jwtSecret',
  MAX_REQ_PER_MINUTE: 'rateLimit',
  MAX_CONNECTIONS_PER_MINUTE: 'maxConnections',
  RATE_DENY_LIST: 'denyList',
  AUTHORIZED_DECRYPTERS: 'authorizedDecrypters',
  AUTHORIZED_DECRYPTERS_LIST: 'authorizedDecryptersList',
  ALLOWED_VALIDATORS: 'allowedValidators',
  ALLOWED_VALIDATORS_LIST: 'allowedValidatorsList',
  AUTHORIZED_PUBLISHERS: 'authorizedPublishers',
  AUTHORIZED_PUBLISHERS_LIST: 'authorizedPublishersList',
  ALLOWED_ADMINS: 'allowedAdmins',
  ALLOWED_ADMINS_LIST: 'allowedAdminsList',
  DOCKER_COMPUTE_ENVIRONMENTS: 'dockerComputeEnvironments',
  SERVICE_TEMPLATES_PATH: 'serviceTemplatesPath',
  DOCKER_REGISTRY_AUTHS: 'dockerRegistrysAuth',
  P2P_BOOTSTRAP_NODES: 'p2pConfig.bootstrapNodes',
  P2P_BOOTSTRAP_TIMEOUT: 'p2pConfig.bootstrapTimeout',
  P2P_BOOTSTRAP_TAGNAME: 'p2pConfig.bootstrapTagName',
  P2P_BOOTSTRAP_TAGVALUE: 'p2pConfig.bootstrapTagValue',
  P2P_BOOTSTRAP_TTL: 'p2pConfig.bootstrapTTL',
  P2P_ENABLE_IPV4: 'p2pConfig.enableIPV4',
  P2P_ENABLE_IPV6: 'p2pConfig.enableIPV6',
  P2P_ipV4BindAddress: 'p2pConfig.ipV4BindAddress',
  P2P_ipV4BindTcpPort: 'p2pConfig.ipV4BindTcpPort',
  P2P_ipV4BindWsPort: 'p2pConfig.ipV4BindWsPort',
  P2P_ipV4BindWssPort: 'p2pConfig.ipV4BindWssPort',
  P2P_ipV6BindAddress: 'p2pConfig.ipV6BindAddress',
  P2P_ipV6BindTcpPort: 'p2pConfig.ipV6BindTcpPort',
  P2P_ipV6BindWsPort: 'p2pConfig.ipV6BindWsPort',
  P2P_ANNOUNCE_ADDRESSES: 'p2pConfig.announceAddresses',
  P2P_dhtMaxInboundStreams: 'p2pConfig.dhtMaxInboundStreams',
  P2P_dhtMaxOutboundStreams: 'p2pConfig.dhtMaxOutboundStreams',
  P2P_DHT_FILTER: 'p2pConfig.dhtFilter',
  P2P_DHT_FORCE_SERVER: 'p2pConfig.dhtForceServer',
  P2P_mDNSInterval: 'p2pConfig.mDNSInterval',
  P2P_connectionsMaxParallelDials: 'p2pConfig.connectionsMaxParallelDials',
  P2P_connectionsDialTimeout: 'p2pConfig.connectionsDialTimeout',
  P2P_MAXDIALQUEUELENGTH: 'p2pConfig.maxDialQueueLength',
  P2P_ENABLE_UPNP: 'p2pConfig.upnp',
  P2P_ENABLE_AUTONAT: 'p2pConfig.autoNat',
  P2P_ENABLE_CIRCUIT_RELAY_SERVER: 'p2pConfig.enableCircuitRelayServer',
  P2P_ENABLE_CIRCUIT_RELAY_CLIENT: 'p2pConfig.enableCircuitRelayClient',
  P2P_CIRCUIT_RELAYS: 'p2pConfig.circuitRelays',
  P2P_ANNOUNCE_PRIVATE: 'p2pConfig.announcePrivateIp',
  P2P_FILTER_ANNOUNCED_ADDRESSES: 'p2pConfig.filterAnnouncedAddresses',
  P2P_MIN_CONNECTIONS: 'p2pConfig.minConnections',
  P2P_MAX_CONNECTIONS: 'p2pConfig.maxConnections',
  P2P_AUTODIALPEERRETRYTHRESHOLD: 'p2pConfig.autoDialPeerRetryThreshold',
  P2P_AUTODIALCONCURRENCY: 'p2pConfig.autoDialConcurrency',
  P2P_MAXPEERADDRSTODIAL: 'p2pConfig.maxPeerAddrsToDial',
  P2P_AUTODIALINTERVAL: 'p2pConfig.autoDialInterval',
  P2P_ENABLE_NETWORK_STATS: 'p2pConfig.enableNetworkStats',
  // the P2P timeout budgets. src/components/P2P/timeouts.ts holds the values
  // and reads these same variables, so an env override reaches both the validated config and
  // the consuming code.
  P2P_FINDPEER_TIMEOUT_MS: 'p2pConfig.findPeerTimeout',
  P2P_FINDPROVIDERS_TIMEOUT_MS: 'p2pConfig.findProvidersTimeout',
  P2P_STREAM_IDLE_TIMEOUT_MS: 'p2pConfig.streamIdleTimeout',
  P2P_STREAM_BODY_TIMEOUT_MS: 'p2pConfig.streamBodyTimeout',
  P2P_SENDTO_RESOLVE_MS: 'p2pConfig.sendToResolveTimeout',
  P2P_SENDTO_DIAL_MS: 'p2pConfig.sendToDialTimeout',
  P2P_SENDTO_STREAM_MS: 'p2pConfig.sendToStreamTimeout',
  P2P_SENDTO_MAX_ATTEMPTS: 'p2pConfig.sendToMaxAttempts',
  // sendTo's overall setup deadline. Without this line the variable reached
  // timeouts.ts (which reads process.env directly) but not the validated config, so
  // `P2P_SENDTO_TOTAL_MS=30000` left config at 45000 while the running code used 30000 -
  // and generated ENVIRONMENT_VARIABLES list did not know the key existed.
  P2P_SENDTO_TOTAL_MS: 'p2pConfig.sendToTotalTimeout',
  P2P_ADVERTISE_TIMEOUT_MS: 'p2pConfig.advertiseTimeout',
  P2P_PEERSTORE_GET_MS: 'p2pConfig.peerStoreGetTimeout',
  P2P_DISCOVERY_DIAL_MS: 'p2pConfig.discoveryDialTimeout',
  P2P_COMMAND_MAX_INBOUND_STREAMS: 'p2pConfig.commandMaxInboundStreams',
  P2P_FINDDDO_TIMEOUT_MS: 'p2pConfig.findDdoTimeout',
  // Per-provider budget inside FindDDO, and how long a "nobody had it" answer is remembered.
  // `P2P_PROVIDER_RETRY_SLEEP_MS` is gone with the back-off it configured: providers are now
  // queried concurrently, so there is no interval between them to tune.
  P2P_FINDDDO_PROVIDER_TIMEOUT_MS: 'p2pConfig.findDdoProviderTimeout',
  P2P_DDO_NOT_FOUND_CACHE_MS: 'p2pConfig.ddoNotFoundCacheTimeout',
  // The app-level peer-address cache and its negative half.
  P2P_RESOLVE_CACHE_MS: 'p2pConfig.resolveCacheTimeout',
  P2P_RESOLVE_NEGATIVE_CACHE_MS: 'p2pConfig.resolveNegativeCacheTimeout',
  // Ceiling on concurrent outbound sendTo calls, so a provider fan-out or an indexer decrypt
  // loop cannot starve the dial queue.
  P2P_SENDTO_MAX_CONCURRENCY: 'p2pConfig.sendToMaxConcurrency',
  // Routing-table size at which the P2P interface reports itself ready, and the delay before
  // kad-dht's first self-query.
  P2P_READY_MIN_ROUTING_PEERS: 'p2pConfig.readyMinRoutingPeers',
  P2P_INITIAL_QUERY_SELF_MS: 'p2pConfig.initialQuerySelfTimeout',
  P2P_PEERSTORE_MAX_ADDRESS_AGE_MS: 'p2pConfig.peerStoreMaxAddressAge',
  P2P_PEERSTORE_MAX_PEER_AGE_MS: 'p2pConfig.peerStoreMaxPeerAge',
  HTTP_CERT_PATH: 'httpCertPath',
  HTTP_KEY_PATH: 'httpKeyPath',
  ENABLE_BENCHMARK: 'enableBenchmark',
  PERSISTENT_STORAGE: 'persistentStorage'
} as const

// Configuration defaults
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 30
// Database init retry at node startup. Worst case wait before giving up with these defaults is
// 2 + 4 + 8 + 16 + 30 * 5 = 180 seconds, so a container health probe must tolerate that.
export const DEFAULT_DB_INIT_MAX_ATTEMPTS = 10
export const DEFAULT_DB_INIT_RETRY_DELAY = 2000
export const DEFAULT_DB_INIT_MAX_RETRY_DELAY = 30000
export const DEFAULT_MAX_CONNECTIONS_PER_MINUTE = 60 * 2 // 120 requests per minute
export const SEPOLIA_CHAIN_ID = '11155111'
export const BASE_CHAIN_ID = '8453'
export const USDC_TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
export const USDC_TOKEN_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

export const DEFAULT_BOOTSTRAP_ADDRESSES = [
  // OPF nodes
  //  node1
  '/dns4/bootstrap1.oncompute.ai/tcp/9000/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
  '/dns4/bootstrap1.oncompute.ai/tcp/9001/ws/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
  '/dns6/bootstrap1.oncompute.ai/tcp/9002/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
  '/dns6/bootstrap1.oncompute.ai/tcp/9003/ws/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
  // node 2
  '/dns4/bootstrap2.oncompute.ai/tcp/9000/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
  '/dns4/bootstrap2.oncompute.ai/tcp/9001/ws/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
  '/dns6/bootstrap2.oncompute.ai/tcp/9002/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
  '/dns6/bootstrap2.oncompute.ai/tcp/9003/ws/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
  // node 3
  '/dns4/bootstrap3.oncompute.ai/tcp/9000/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
  '/dns4/bootstrap3.oncompute.ai/tcp/9001/ws/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
  '/dns6/bootstrap3.oncompute.ai/tcp/9002/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
  '/dns6/bootstrap3.oncompute.ai/tcp/9003/ws/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
  // node 4
  '/dns4/bootstrap4.oncompute.ai/tcp/9000/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom',
  '/dns4/bootstrap4.oncompute.ai/tcp/9001/ws/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom',
  '/dns6/bootstrap4.oncompute.ai/tcp/9002/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom',
  '/dns6/bootstrap4.oncompute.ai/tcp/9003/ws/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom'
] as const

export const DEFAULT_UNSAFE_URLS = [
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
] as const

export const DEFAULT_FILTER_ANNOUNCED_ADDRESSES = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4'
] as const
