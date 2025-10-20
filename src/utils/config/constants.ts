export const ENV_TO_CONFIG_MAPPING = {
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
  P2P_BOOTSTRAP_NODES: 'bootstrapNodes',
  P2P_BOOTSTRAP_TIMEOUT: 'bootstrapTimeout',
  P2P_BOOTSTRAP_TAGNAME: 'bootstrapTagName',
  P2P_BOOTSTRAP_TAGVALUE: 'bootstrapTagValue',
  P2P_BOOTSTRAP_TTL: 'bootstrapTTL',
  P2P_ENABLE_IPV4: 'enableIPV4',
  P2P_ENABLE_IPV6: 'enableIPV6',
  P2P_IP_V4_BIND_ADDRESS: 'ipV4BindAddress',
  P2P_IP_V4_BIND_TCP_PORT: 'ipV4BindTcpPort',
  P2P_IP_V4_BIND_WS_PORT: 'ipV4BindWsPort',
  P2P_IP_V6_BIND_ADDRESS: 'ipV6BindAddress',
  P2P_IP_V6_BIND_TCP_PORT: 'ipV6BindTcpPort',
  P2P_IP_V6_BIND_WS_PORT: 'ipV6BindWsPort',
  P2P_ANNOUNCE_ADDRESSES: 'announceAddresses',
  P2P_PUBSUB_PEER_DISCOVERY_INTERVAL: 'pubsubPeerDiscoveryInterval',
  P2P_DHT_MAX_INBOUND_STREAMS: 'dhtMaxInboundStreams',
  P2P_DHT_MAX_OUTBOUND_STREAMS: 'dhtMaxOutboundStreams',
  P2P_DHT_FILTER: 'dhtFilter',
  P2P_MDNS_INTERVAL: 'mDNSInterval',
  P2P_CONNECTIONS_MAX_PARALLEL_DIALS: 'connectionsMaxParallelDials',
  P2P_CONNECTIONS_DIAL_TIMEOUT: 'connectionsDialTimeout',
  P2P_ENABLE_UPNP: 'upnp',
  P2P_ENABLE_AUTONAT: 'autoNat',
  P2P_ENABLE_CIRCUIT_RELAY_SERVER: 'enableCircuitRelayServer',
  P2P_ENABLE_CIRCUIT_RELAY_CLIENT: 'enableCircuitRelayClient',
  P2P_CIRCUIT_RELAYS: 'circuitRelays',
  P2P_ANNOUNCE_PRIVATE: 'announcePrivateIp',
  P2P_FILTER_ANNOUNCED_ADDRESSES: 'filterAnnouncedAddresses',
  P2P_MIN_CONNECTIONS: 'minConnections',
  P2P_MAX_CONNECTIONS: 'maxConnections',
  P2P_AUTODIAL_PEER_RETRY_THRESHOLD: 'autoDialPeerRetryThreshold',
  P2P_AUTODIAL_CONCURRENCY: 'autoDialConcurrency',
  P2P_MAX_PEER_ADDRS_TO_DIAL: 'maxPeerAddrsToDial',
  P2P_AUTODIAL_INTERVAL: 'autoDialInterval',
  P2P_ENABLE_NETWORK_STATS: 'enableNetworkStats'
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
