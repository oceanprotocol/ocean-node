import { expect } from 'chai'
import { PROTOCOL_COMMANDS, SUPPORTED_PROTOCOL_COMMANDS } from '../../utils/index.js'
import { CoreHandlersRegistry } from '../../components/core/coreHandlersRegistry.js'
import { Handler } from '../../components/core/handler.js'
import { OceanNode } from '../../OceanNode.js'
import {
  ComputeGetEnvironmentsCommand,
  ComputeGetResultCommand,
  ComputeGetStatusCommand,
  ComputeInitializeCommand,
  ComputeStartCommand,
  ComputeStopCommand,
  DecryptDDOCommand,
  DownloadCommand,
  EchoCommand,
  EncryptCommand,
  EncryptFileCommand,
  FileInfoCommand,
  FindDDOCommand,
  GetDdoCommand,
  GetFeesCommand,
  NonceCommand,
  QueryCommand,
  ReindexCommand,
  StatusCommand,
  ValidateDDOCommand
} from '../../@types/commands.js'
import { NonceHandler } from '../../components/core/nonceHandler.js'
import { DownloadHandler } from '../../components/core/downloadHandler.js'
import {
  EncryptFileHandler,
  EncryptHandler
} from '../../components/core/encryptHandler.js'
import {
  FindDdoHandler,
  GetDdoHandler,
  ValidateDDOHandler
} from '../../components/core/ddoHandler.js'
import { QueryHandler } from '../../components/core/queryHandler.js'
import { StatusHandler } from '../../components/core/statusHandler.js'
import { FeesHandler } from '../../components/core/feesHandler.js'
import { EchoHandler } from '../../components/core/echoHandler.js'
import { ReindexHandler } from '../../components/core/reindexHandler.js'
import { FileInfoHandler } from '../../components/core/fileInfoHandler.js'
import { ComputeGetEnvironmentsHandler } from '../../components/core/compute/environments.js'
import { ComputeStartHandler } from '../../components/core/compute/startCompute.js'
import { ComputeStopHandler } from '../../components/core/compute/stopCompute.js'
import { ComputeGetStatusHandler } from '../../components/core/compute/getStatus.js'
import { ComputeGetResultHandler } from '../../components/core/compute/getResults.js'
import { ComputeInitializeHandler } from '../../components/core/compute/initialize.js'

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

    // downloadHandler
    const downloadHandler: DownloadHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.DOWNLOAD)
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
    // -----------------------------------------
    // DecryptDDOHandler
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

    // -----------------------------------------
    // NonceHandler
    const nonceHandler: NonceHandler = CoreHandlersRegistry.getInstance(node).getHandler(
      PROTOCOL_COMMANDS.NONCE
    )
    const nonceCommand: NonceCommand = {
      address: '0x8F292046bb73595A978F4e7A131b4EBd03A15e8a',
      command: PROTOCOL_COMMANDS.NONCE
    }
    expect(nonceHandler.validate(nonceCommand).valid).to.be.equal(true)
    delete nonceCommand.address
    expect(nonceHandler.validate(nonceCommand).valid).to.be.equal(false)

    // -----------------------------------------
    // EncryptHandler
    const encryptHandler: EncryptHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.ENCRYPT)
    const encryptCommand: EncryptCommand = {
      blob: '1425252525',
      command: PROTOCOL_COMMANDS.ENCRYPT
    }
    expect(encryptHandler.validate(encryptCommand).valid).to.be.equal(true)
    delete encryptCommand.blob
    expect(encryptHandler.validate(encryptCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // EncryptFileHandler
    const encryptFileHandler: EncryptFileHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.ENCRYPT_FILE)
    const encryptFileCommand: EncryptFileCommand = {
      rawData: Buffer.from('12345'),
      command: PROTOCOL_COMMANDS.ENCRYPT_FILE
    }
    expect(encryptFileHandler.validate(encryptFileCommand).valid).to.be.equal(true)
    delete encryptFileCommand.rawData
    expect(encryptFileHandler.validate(encryptFileCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // GetDDOHandler
    const getDDOHandler: GetDdoHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.GET_DDO)
    const getDDOCommand: GetDdoCommand = {
      id: 'did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123',
      command: PROTOCOL_COMMANDS.GET_DDO
    }
    expect(getDDOHandler.validate(getDDOCommand).valid).to.be.equal(true)
    getDDOCommand.id = '123456'
    expect(getDDOHandler.validate(getDDOCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // QueryHandler
    const queryHandler: QueryHandler = CoreHandlersRegistry.getInstance(node).getHandler(
      PROTOCOL_COMMANDS.QUERY
    )
    const queryCommand: QueryCommand = {
      query: { version: '123' },
      command: PROTOCOL_COMMANDS.QUERY
    }
    expect(queryHandler.validate(queryCommand).valid).to.be.equal(true)
    queryCommand.query = null
    expect(queryHandler.validate(queryCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // StatusHandler
    const statusHandler: StatusHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.STATUS)
    const statusCommand: StatusCommand = {
      command: PROTOCOL_COMMANDS.STATUS
    }
    expect(statusHandler.validate(statusCommand).valid).to.be.equal(true)
    // -----------------------------------------
    // FindDdoHandler
    const findDDOHandler: FindDdoHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.FIND_DDO) as FindDdoHandler
    const findDDOCommand: FindDDOCommand = {
      id: 'did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123',
      command: PROTOCOL_COMMANDS.FIND_DDO
    }
    expect(findDDOHandler.validate(findDDOCommand).valid).to.be.equal(true)
    delete findDDOCommand.id
    expect(findDDOHandler.validate(findDDOCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // FeesHandler
    const feesHandler: FeesHandler = CoreHandlersRegistry.getInstance(node).getHandler(
      PROTOCOL_COMMANDS.GET_FEES
    )
    const feesCommand: GetFeesCommand = {
      ddoId: 'did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123',
      serviceId: '1234567',
      command: PROTOCOL_COMMANDS.GET_FEES
    }
    expect(feesHandler.validate(feesCommand).valid).to.be.equal(true)
    feesCommand.consumerAddress = 'INVALID_1234567'
    expect(feesHandler.validate(feesCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // EchoHandler
    const echoHandler: EchoHandler = CoreHandlersRegistry.getInstance(node).getHandler(
      PROTOCOL_COMMANDS.ECHO
    )
    const echoCommand: EchoCommand = {
      command: PROTOCOL_COMMANDS.ECHO
    }
    expect(echoHandler.validate(echoCommand).valid).to.be.equal(true)
    // -----------------------------------------
    // ReindexHandler
    const reindexHandler: ReindexHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.REINDEX)
    const reindexCommand: ReindexCommand = {
      txId: '0xCce67694eD2848dd683c651Dab7Af823b7dd123',
      chainId: 8996,
      command: PROTOCOL_COMMANDS.REINDEX
    }
    expect(reindexHandler.validate(reindexCommand).valid).to.be.equal(true)
    reindexCommand.chainId = undefined
    expect(reindexHandler.validate(reindexCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // FileInfoHandler
    const fileInfoHandler: FileInfoHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.FILE_INFO)
    const fileInfoCommand: FileInfoCommand = {
      did: 'did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123',
      serviceId: '1234567',
      command: PROTOCOL_COMMANDS.FILE_INFO
    }
    expect(fileInfoHandler.validate(fileInfoCommand).valid).to.be.equal(true)
    delete fileInfoCommand.did
    fileInfoCommand.serviceId = null
    expect(fileInfoHandler.validate(fileInfoCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // ValidateDDOHandler
    const validateDDOHandler: ValidateDDOHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.VALIDATE_DDO)
    const validateDDOCommand: ValidateDDOCommand = {
      ddo: {
        id: 'did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123',
        '@context': [],
        version: '',
        nftAddress: '',
        chainId: 0,
        metadata: undefined,
        services: []
      },
      command: PROTOCOL_COMMANDS.VALIDATE_DDO
    }
    expect(validateDDOHandler.validate(validateDDOCommand).valid).to.be.equal(true)
    delete validateDDOCommand.ddo
    expect(validateDDOHandler.validate(validateDDOCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // ComputeGetEnvironmentsHandler
    const getEnvHandler: ComputeGetEnvironmentsHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS)
    const getEnvCommand: ComputeGetEnvironmentsCommand = {
      chainId: 8996,
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS
    }
    expect(getEnvHandler.validate(getEnvCommand).valid).to.be.equal(true)
    getEnvCommand.chainId = -1
    expect(getEnvHandler.validate(getEnvCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // ComputeStartHandler
    const startEnvHandler: ComputeStartHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.COMPUTE_START)
    const startEnvCommand: ComputeStartCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      consumerAddress: '',
      signature: '',
      nonce: '',
      environment: '',
      algorithm: undefined,
      dataset: undefined
    }
    expect(startEnvHandler.validate(startEnvCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // ComputeStopHandler
    const stopEnvHandler: ComputeStopHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.COMPUTE_STOP)
    const stopEnvCommand: ComputeStopCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_STOP,
      consumerAddress: '',
      signature: null,
      nonce: '',
      jobId: ''
    }
    expect(stopEnvHandler.validate(stopEnvCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // ComputeGetStatusHandler
    const statusEnvHandler: ComputeGetStatusHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.COMPUTE_GET_STATUS)
    const statusEnvCommand: ComputeGetStatusCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
      consumerAddress: 'abcdef',
      jobId: '23'
    }
    expect(statusEnvHandler.validate(statusEnvCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // ComputeGetResultHandler
    const resultEnvHandler: ComputeGetResultHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.COMPUTE_GET_RESULT)
    const resultEnvCommand: ComputeGetResultCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_RESULT,
      consumerAddress: 'abcdef',
      jobId: '23',
      signature: '',
      nonce: '',
      index: -1
    }
    expect(resultEnvHandler.validate(resultEnvCommand).valid).to.be.equal(false)

    // -----------------------------------------
    // ComputeInitializeHandler
    const initComputeHandler: ComputeInitializeHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.COMPUTE_INITIALIZE)
    const computeInitCommand: ComputeInitializeCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_INITIALIZE,
      consumerAddress: 'abcdef',
      datasets: null,
      algorithm: undefined,
      compute: undefined
    }
    expect(initComputeHandler.validate(computeInitCommand).valid).to.be.equal(false)
  })
})
