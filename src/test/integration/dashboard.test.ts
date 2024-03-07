import { assert } from 'chai'
import { JsonRpcProvider, sha256, toUtf8Bytes, Signer } from 'ethers'
import { RPCS } from '../../@types/blockchain.js'
import {
  ENVIRONMENT_VARIABLES,
  getConfiguration,
  PROTOCOL_COMMANDS
} from '../../utils/index.js'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { validateSignature } from '../../utils/auth.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { AdminHandler } from '../../components/core/dashboard/adminHandler.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'stream'

describe('Should run the authentication node flow.', async () => {
  let previousConfiguration: OverrideEnvConfig[]

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const provider = new JsonRpcProvider('http://127.0.0.1:8545')

  const config = await getConfiguration(true) // Force reload the configuration
  const dbconn = await new Database(config.dbConfig)
  const oceanNode = await OceanNode.getInstance(dbconn)

  // let network = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
  // if (!network) {
  //   network = getOceanArtifactsAdresses().development
  // }

  const publisherAccount = (await provider.getSigner(0)) as Signer
  const consumerAccount = (await provider.getSigner(1)) as Signer
  const consumerAddress = await consumerAccount.getAddress()
  const publisherAddress = await publisherAccount.getAddress()

  before(async () => {
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.DB_URL,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ALLOWED_ADMINS
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          'http://localhost:8108/?apiKey=xyz',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify([publisherAddress, consumerAddress])
        ]
      )
    )
  })

  it('should get admin list', async () => {
    const getAdminListCommand = {
      command: PROTOCOL_COMMANDS.GET_ADMIN_LIST,
      node: config.keys.peerId.toString()
    }
    const response = await new AdminHandler(oceanNode).handle(getAdminListCommand)
    assert(response.status.httpStatus === 200, 'http status not 200')
    const resp = await streamToObject(response.stream as Readable)
    const adminList = JSON.parse(resp)
    assert(adminList.length === 2, 'incorrect length')
    assert(adminList[0] === publisherAddress, 'incorrect admin address [0]')
    assert(adminList[1] === consumerAddress, 'incorrect admin address [1]')
  })
  it('signature should match', async () => {
    const currentDate = new Date()
    const expiryTimestamp = new Date(
      currentDate.getFullYear() + 1,
      currentDate.getMonth(),
      currentDate.getDate()
    ).getTime()

    const message = sha256(toUtf8Bytes(expiryTimestamp.toString()))

    // Sign the original message directly
    const signature = await (await provider.getSigner()).signMessage(message)

    assert(
      validateSignature(expiryTimestamp, signature) === true,
      'signatures do not match'
    )
  })
  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
