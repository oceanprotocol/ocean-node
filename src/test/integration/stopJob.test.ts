import { expect } from 'chai'
import { Signer, JsonRpcProvider } from 'ethers'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { StopJobHandler } from '../../components/core/admin/stopJob.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { getConfiguration } from '../../utils/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { createHashForSignature, safeSign } from '../utils/signature.js'

describe('**********         Admin StopJob Handler Integration Tests', () => {
  let config: OceanNodeConfig
  let database: Database
  let adminAccount: Signer
  let nonAdminAccount: Signer
  let previousConfiguration: OverrideEnvConfig[]
  let oceanNode: OceanNode

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  before(async () => {
    const provider = new JsonRpcProvider('http://127.0.0.1:8545')
    adminAccount = (await provider.getSigner(0)) as Signer
    nonAdminAccount = (await provider.getSigner(1)) as Signer
    const adminAddress = await adminAccount.getAddress()

    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.ALLOWED_ADMINS
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([8996]),
          JSON.stringify([adminAddress])
        ]
      )
    )

    config = await getConfiguration(true)
    database = await Database.init(config.dbConfig)
    oceanNode = OceanNode.getInstance(
      config,
      database,
      null,
      null,
      null,
      null,
      null,
      true
    )
  })

  after(async () => {
    await oceanNode.tearDownAll()
    await tearDownEnvironment(previousConfiguration)
  })

  const getAdminSignature = async (nonce: string, command: string): Promise<string> => {
    const messageHashBytes = createHashForSignature(
      await adminAccount.getAddress(),
      nonce,
      command
    )
    return safeSign(adminAccount, messageHashBytes)
  }

  const getNonAdminSignature = async (
    nonce: string,
    command: string
  ): Promise<string> => {
    const messageHashBytes = createHashForSignature(
      await nonAdminAccount.getAddress(),
      nonce,
      command
    )
    return safeSign(nonAdminAccount, messageHashBytes)
  }

  it('should reject request with missing jobId', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT)

    const nonce = Date.now().toString()
    const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.STOP_JOB)

    const response = await new StopJobHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.STOP_JOB,
      nonce,
      address: await adminAccount.getAddress(),
      signature,
      jobId: undefined as unknown as string
    })

    expect(response.status.httpStatus).to.equal(400)
  })

  it('should reject request signed by non-admin', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT)

    const nonce = Date.now().toString()
    const signature = await getNonAdminSignature(nonce, PROTOCOL_COMMANDS.STOP_JOB)

    const response = await new StopJobHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.STOP_JOB,
      nonce,
      address: await nonAdminAccount.getAddress(),
      signature,
      jobId: 'abc123-some-job-id'
    })

    expect(response.status.httpStatus).to.not.equal(200)
  })

  it('should reject jobId with no dash separator', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT)

    const nonce = Date.now().toString()
    const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.STOP_JOB)

    const response = await new StopJobHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.STOP_JOB,
      nonce,
      address: await adminAccount.getAddress(),
      signature,
      jobId: 'invalidJobIdWithNoDash'
    })

    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.include('Invalid jobId format')
  })

  it('should return error when no C2D engines are configured', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT)

    const nonce = Date.now().toString()
    const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.STOP_JOB)

    // Valid composite jobId format, but no engines are configured in the test environment
    const response = await new StopJobHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.STOP_JOB,
      nonce,
      address: await adminAccount.getAddress(),
      signature,
      jobId: 'abc123-some-job-id'
    })

    expect(response.status.httpStatus).to.equal(500)
    expect(response.status.error).to.include('No C2D engines configured')
  })
})
