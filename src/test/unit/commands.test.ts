import { expect } from 'chai'
import { PROTOCOL_COMMANDS, SUPPORTED_PROTOCOL_COMMANDS } from '../../utils/index.js'
import { CoreHandlersRegistry } from '../../components/core/coreHandlersRegistry.js'
import { Handler } from '../../components/core/handler.js'
import { OceanNode } from '../../OceanNode.js'
import { DecryptDDOCommand, DownloadCommand } from '../../@types/commands.js'

describe('Commands and handlers', () => {
  it('Check that all supported commands have registered handlers', () => {
    // To make sure we do not forget to register handlers
    const node: OceanNode = OceanNode.getInstance()
    for (const command of SUPPORTED_PROTOCOL_COMMANDS) {
      expect(CoreHandlersRegistry.getInstance(node).getHandler(command)).to.be.instanceof(
        Handler
      )
    }
  })

  it('Check that supported commands and handlers match', () => {
    // To make sure we do not forget to register anything on supported commands
    const node: OceanNode = OceanNode.getInstance()
    const handlers: string[] = node.getCoreHandlers().getRegisteredCommands()
    expect(SUPPORTED_PROTOCOL_COMMANDS.length).to.be.equal(handlers.length)
  })

  it('Check that all commands are validating required parameters', () => {
    // To make sure we do not forget to register anything on supported commands
    const node: OceanNode = OceanNode.getInstance()

    const downloadHandler = CoreHandlersRegistry.getInstance(node).getHandler(
      PROTOCOL_COMMANDS.DOWNLOAD
    )
    const downloadCommand: DownloadCommand = {
      fileIndex: 0,
      documentId: 'did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123',
      serviceId: '1234',
      transferTxId: '0x363636',
      nonce: '1',
      consumerAddress: '0x8F292046bb73595A978F4e7A131b4EBd03A15e8a',
      signature: '0x123',
      command: PROTOCOL_COMMANDS.DOWNLOAD
    }
    expect(downloadHandler.validate(downloadCommand).valid).to.be.equal(true)
    downloadCommand.nonce = null
    expect(downloadHandler.validate(downloadCommand).valid).to.be.equal(false)

    const decryptDDOCommand: DecryptDDOCommand = {
      decrypterAddress: '0x8F292046bb73595A978F4e7A131b4EBd03A15e8a',
      chainId: 8996,
      nonce: '12345',
      signature: '0x123',
      command: PROTOCOL_COMMANDS.DECRYPT_DDO
    }
    const decryptDDOHandler = CoreHandlersRegistry.getInstance(node).getHandler(
      PROTOCOL_COMMANDS.DECRYPT_DDO
    )
    expect(decryptDDOHandler.validate(decryptDDOCommand).valid).to.be.equal(true)
    decryptDDOCommand.signature = undefined
    expect(decryptDDOHandler.validate(decryptDDOCommand).valid).to.be.equal(false)
  })
  /**
   * 
   * TODO this
    this.registerCoreHandler(PROTOCOL_COMMANDS.NONCE, new NonceHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.ENCRYPT, new EncryptHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.ENCRYPT_FILE, new EncryptFileHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.GET_DDO, new GetDdoHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.QUERY, new QueryHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.STATUS, new StatusHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.FIND_DDO, new FindDdoHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.GET_FEES, new FeesHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.ECHO, new EchoHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.REINDEX, new ReindexHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.FILE_INFO, new FileInfoHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.VALIDATE_DDO, new ValidateDDOHandler(node))
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
      new ComputeGetEnvironmentsHandler(node)
    )
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_START,
      new ComputeStartHandler(node)
    )
    this.registerCoreHandler(PROTOCOL_COMMANDS.COMPUTE_STOP, new ComputeStopHandler(node))
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
      new ComputeGetStatusHandler(node)
    )
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_GET_RESULT,
      new ComputeGetResultHandler(node)
    )
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_INITIALIZE,
      new ComputeInitializeHandler(node)
    )
   */
})
