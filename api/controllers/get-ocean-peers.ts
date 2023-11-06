;(module.exports = {
  friendlyName: 'Get ocean peers',

  description: '',

  inputs: {},

  exits: {},

  fn: async (req: Request, res: Response): Promise<void> => {
    const peers = await req.oceanNode.node.getPeers()
    customLogger.log(getDefaultLevel(), `getOceanPeers: ${peers}`, true)
    res.json(peers)
  }
}),
  {
    friendlyName: 'Get ocean peers',

    description: 'getAllPeerStore',

    inputs: {},

    exits: {},

    fn: async (req: Request, res: Response): Promise<void> => {
      const peers = await req.oceanNode.node.getAllPeerStore()
      res.json(peers)
    }
  },
  {
    friendlyName: 'Get ocean peers',

    description: 'getPeerDetails',

    inputs: {},

    exits: {},

    fn: async (req: Request, res: Response): Promise<void> => {
      if (!req.query.peerId) {
        res.sendStatus(400)
        return
      }
      const peers = await req.oceanNode.node.getPeerDetails(String(req.query.peerId))
      res.json(peers)
    }
  }
