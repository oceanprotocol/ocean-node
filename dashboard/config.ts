export type ConfigType = {
  apiURL: {
    logs: string
    status: string
  }
  nodeId: string
}

const config: ConfigType = {
  apiURL: {
    logs: 'http://localhost:8010/proxy/logs',
    status: 'http://localhost:8010/proxy/directCommand',
  },
  nodeId:
    process.env.NEXT_PUBLIC_NODE_ID ||
    '16Uiu2HAm6G73f3wiPtrmT7BNLqA3PCzQGGtpShu9qNFjAJgAM4R7',
}

export default config
