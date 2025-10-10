import { expect } from 'chai'
import { PROTOCOL_COMMANDS, SUPPORTED_PROTOCOL_COMMANDS } from '../../utils/index.js'
import { CoreHandlersRegistry } from '../../components/core/handler/coreHandlersRegistry.js'
import { BaseHandler } from '../../components/core/handler/handler.js'
import { OceanNode } from '../../OceanNode.js'
import {
  ComputeGetEnvironmentsCommand,
  ComputeGetResultCommand,
  ComputeGetStatusCommand,
  ComputeInitializeCommand,
  PaidComputeStartCommand,
  ComputeStopCommand,
  DecryptDDOCommand,
  DownloadCommand,
  EncryptCommand,
  EncryptFileCommand,
  FileInfoCommand,
  FindDDOCommand,
  GetDdoCommand,
  GetFeesCommand,
  NonceCommand,
  QueryCommand,
  StatusCommand,
  ValidateDDOCommand,
  GetJobsCommand
} from '../../@types/commands.js'
import { NonceHandler } from '../../components/core/handler/nonceHandler.js'
import { DownloadHandler } from '../../components/core/handler/downloadHandler.js'
import {
  EncryptFileHandler,
  EncryptHandler
} from '../../components/core/handler/encryptHandler.js'
import {
  FindDdoHandler,
  GetDdoHandler,
  ValidateDDOHandler
} from '../../components/core/handler/ddoHandler.js'
import { QueryHandler } from '../../components/core/handler/queryHandler.js'
import { StatusHandler } from '../../components/core/handler/statusHandler.js'
import { FeesHandler } from '../../components/core/handler/feesHandler.js'
import { FileInfoHandler } from '../../components/core/handler/fileInfoHandler.js'
import { ComputeGetEnvironmentsHandler } from '../../components/core/compute/environments.js'
import { PaidComputeStartHandler } from '../../components/core/compute/startCompute.js'
import { ComputeStopHandler } from '../../components/core/compute/stopCompute.js'
import { ComputeGetStatusHandler } from '../../components/core/compute/getStatus.js'
import { ComputeGetResultHandler } from '../../components/core/compute/getResults.js'
import { ComputeInitializeHandler } from '../../components/core/compute/initialize.js'
import { StopNodeHandler } from '../../components/core/admin/stopNodeHandler.js'
import { ReindexTxHandler } from '../../components/core/admin/reindexTxHandler.js'
import { ReindexChainHandler } from '../../components/core/admin/reindexChainHandler.js'
import { CollectFeesHandler } from '../../components/core/admin/collectFeesHandler.js'
import { GetJobsHandler } from '../../components/core/handler/getJobs.js'

describe('Commands and handlers', () => {
  it('Check that all supported commands have registered handlers', () => {
    // To make sure we do not forget to register handlers
    const node: OceanNode = OceanNode.getInstance()
    for (const command of SUPPORTED_PROTOCOL_COMMANDS) {
      expect(CoreHandlersRegistry.getInstance(node).getHandler(command)).to.be.instanceof(
        BaseHandler
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
    downloadCommand.documentId = undefined
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
    // Stop Node Handler for Admin
    const stopNodeHandler: StopNodeHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.STOP_NODE) as StopNodeHandler
    expect(stopNodeHandler).to.be.not.equal(null)
    // -----------------------------------------
    // Reindex Tx Handler
    const reindexTxHandler: ReindexTxHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.REINDEX_TX) as ReindexTxHandler
    expect(reindexTxHandler).to.be.not.equal(null)
    // -----------------------------------------
    // Reindex Chain Handler
    const reindexChainHandler: ReindexChainHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.REINDEX_CHAIN) as ReindexChainHandler
    expect(reindexChainHandler).to.be.not.equal(null)
    // -----------------------------------------
    // CollectFeesHandler
    const collectFeesHandler: CollectFeesHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.COLLECT_FEES) as CollectFeesHandler
    expect(collectFeesHandler).to.be.not.equal(null)
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
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS
    }
    expect(getEnvHandler.validate(getEnvCommand).valid).to.be.equal(true)
    // -----------------------------------------
    // ComputeStartHandler
    const startEnvHandler: PaidComputeStartHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.COMPUTE_START)
    const startEnvCommand: PaidComputeStartCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      consumerAddress: '',
      signature: '',
      nonce: '',
      environment: '',
      algorithm: undefined,
      datasets: undefined,
      payment: undefined
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
      payment: undefined,
      environment: undefined,
      maxJobDuration: 60
    }
    expect(initComputeHandler.validate(computeInitCommand).valid).to.be.equal(false)
    // -----------------------------------------
    // JobsHandler
    const jobsHandler: GetJobsHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.JOBS)
    const getJobsCommand: GetJobsCommand = {
      command: PROTOCOL_COMMANDS.JOBS
    }
    expect(jobsHandler.validate(getJobsCommand).valid).to.be.equal(true)
    // -----------------------------------------
  })
})
