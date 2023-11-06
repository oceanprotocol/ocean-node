;(module.exports = {
  friendlyName: 'get providers for did ',

  description: 'getProvidersForDid',

  inputs: {},

  exits: {},

  fn: async (req: Request, res: Response): Promise<void> => {
    if (!req.query.did) {
      res.sendStatus(400)
      return
    }
    await req.oceanNode.node.advertiseDid(req.query.did as string)
    res.sendStatus(200)
  }
}),
  {
    friendlyName: 'Dids',

    description: 'advertiseDid',

    inputs: {},

    exits: {},

    fn: async (req: Request, res: Response): Promise<void> => {
      if (!req.query.did) {
        res.sendStatus(400)
        return
      }
      const providers = await req.oceanNode.node.getProvidersForDid(
        req.query.did as string
      )
      res.json(providers)
    }
  }
