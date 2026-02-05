export const ENV_TO_CONFIG_MAPPING = {
  PRIVATE_KEY: 'keys.privateKey',
  INTERFACES: 'INTERFACES',
  DB_URL: 'DB_URL',
  DB_USERNAME: 'DB_USERNAME',
  DB_PASSWORD: 'DB_PASSWORD',
  DB_TYPE: 'DB_TYPE',
  FEE_AMOUNT: 'FEE_AMOUNT',
  FEE_TOKENS: 'FEE_TOKENS',
  HTTP_API_PORT: 'httpPort',
  CONTROL_PANEL: 'hasControlPanel',
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
  DOCKER_REGISTRY_AUTHS: 'dockerRegistryAuth',
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
  P2P_pubsubPeerDiscoveryInterval: 'p2pConfig.pubsubPeerDiscoveryInterval',
  P2P_dhtMaxInboundStreams: 'p2pConfig.dhtMaxInboundStreams',
  P2P_dhtMaxOutboundStreams: 'p2pConfig.dhtMaxOutboundStreams',
  P2P_DHT_FILTER: 'p2pConfig.dhtFilter',
  P2P_mDNSInterval: 'p2pConfig.mDNSInterval',
  P2P_connectionsMaxParallelDials: 'p2pConfig.connectionsMaxParallelDials',
  P2P_connectionsDialTimeout: 'p2pConfig.connectionsDialTimeout',
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
  HTTP_CERT_PATH: 'httpCertPath',
  HTTP_KEY_PATH: 'httpKeyPath'
} as const

// Configuration defaults
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 30
export const DEFAULT_MAX_CONNECTIONS_PER_MINUTE = 60 * 2 // 120 requests per minute

export const DEFAULT_BOOTSTRAP_ADDRESSES = [
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
