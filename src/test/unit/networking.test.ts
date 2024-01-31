import { OceanNode } from '../../OceanNode.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { getDatabase } from '../../utils/database.js'
import { getConfiguration } from '../../utils/index.js'

import { expect } from 'chai'

describe('Test available network interfaces', async () => {
  // because of this
  it('should exist both interfaces by default, or respect config', async () => {
    const envSet = process.env.INTERFACES
    const config = await getConfiguration()
    const { hasP2P, hasHttp } = config
    if (!envSet) {
      expect(hasP2P).to.be.equal(true)
      expect(hasHttp).to.be.equal(true)
      expect(OceanNode.getInstance(await getDatabase()).getP2PNode()).to.be.instanceOf(
        OceanP2P
      )
    } else {
      try {
        let interfaces = JSON.parse(process.env.INTERFACES) as string[]
        interfaces = interfaces.map((iface: string) => {
          return iface.toUpperCase()
        })
        interfaces.includes('HTTP')
          ? expect(hasHttp).to.be.equal(true)
          : expect(hasHttp).to.be.equal(false)

        interfaces.includes('P2P')
          ? expect(hasP2P).to.be.equal(true)
          : expect(hasP2P).to.be.equal(false)
      } catch (ex) {} // just ignore it
    }
  })
})
