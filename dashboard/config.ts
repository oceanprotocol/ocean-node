export type ConfigType = {
  apiRoutes: {
    logs: string
    status: string
  }
  nodeId: string | undefined
}

const config: ConfigType = {
  apiRoutes: {
    logs: '/logs',
    status: '/directCommand'
  },
  nodeId: process.env.NEXT_PUBLIC_NODE_ID || ''
}

export default config
