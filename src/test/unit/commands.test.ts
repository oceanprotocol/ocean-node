import { expect } from 'chai'
import { SUPPORTED_PROTOCOL_COMMANDS, getConfig } from '../../utils/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { CoreHandlersRegistry } from '../../components/core/coreHandlersRegistry.js'
import { Handler } from '../../components/core/handler.js'

describe('Commands and handlers', async () => {
  it('Check that all supported commands have registered handlers', async () => {
    // To make sure we do not forget to register handlers
    const config: OceanNodeConfig = await getConfig()
    const nodeP2P = new OceanP2P(config)
    for (const command of SUPPORTED_PROTOCOL_COMMANDS) {
      expect(
        CoreHandlersRegistry.getInstance(nodeP2P).getHandler(command)
      ).to.be.instanceof(Handler)
    }
  })
})
