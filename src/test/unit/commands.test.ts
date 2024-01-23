import { expect } from 'chai'
import { SUPPORTED_PROTOCOL_COMMANDS } from '../../utils/index.js'
import { CoreHandlersRegistry } from '../../components/core/coreHandlersRegistry.js'
import { Handler } from '../../components/core/handler.js'
import { OceanNode } from '../../OceanNode.js'

describe('Commands and handlers', async () => {
  it('Check that all supported commands have registered handlers', async () => {
    // To make sure we do not forget to register handlers
    const node: OceanNode = OceanNode.getInstance()
    for (const command of SUPPORTED_PROTOCOL_COMMANDS) {
      expect(CoreHandlersRegistry.getInstance(node).getHandler(command)).to.be.instanceof(
        Handler
      )
    }
  })
})
