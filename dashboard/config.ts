export type ConfigType = {
  apiUrl: string
  apiRoutes: {
    logs: string
    status: string
  }
  nodeId: string | undefined
}

const config: ConfigType = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || '',
  apiRoutes: {
    logs: '/logs',
    status: '/directCommand'
  },
  nodeId: process.env.NEXT_PUBLIC_NODE_ID
}

export default config
