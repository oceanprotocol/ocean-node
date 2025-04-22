export type NodeDetailsType = {
  node: string
  host: string
  port: string
  last_seen: string
  enode: string
  client_type: string
  client_version: string
  os: string
  country: string
  city: string
}

export type DataRowType = {
  nodeId: string
  network: string
  chainId: string
  components: string
  blockNumber: string
  errors: string
  downloadLogs: string
  nodeDetails: NodeDetailsType[]
}
