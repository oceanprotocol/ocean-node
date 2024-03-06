import { assert } from 'chai'
import { JsonRpcProvider, sha256, toUtf8Bytes } from 'ethers'
import { RPCS } from '../../@types/blockchain.js'
import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../utils/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import axios, { AxiosResponse } from 'axios'
import { validateSignature } from '../../utils/auth.js'

describe('Should run the authentication node flow.', () => {
  let config: OceanNodeConfig
  let previousConfiguration: OverrideEnvConfig[]

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const provider = new JsonRpcProvider('http://127.0.0.1:8545')

  // const publisherAccount = (await provider.getSigner(0)) as Signer
  // const consumerAccount = (await provider.getSigner(1)) as Signer
  // const consumerAddress = await consumerAccount.getAddress()
  // const publisherAddress = await publisherAccount.getAddress()

  before(async () => {
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.HTTP_API_PORT,
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.DB_URL,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ALLOWED_ADMINS
        ],
        [
          8081,
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          'http://localhost:8108/?apiKey=xyz',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify([
            '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
          ])
        ]
      )
    )
    config = await getConfiguration(true)
  })

  it('should authenticate as admin', async () => {
    const response: AxiosResponse = await axios.get(
      `http://localhost:${config.httpPort}/adminList`
    )
    assert(response.status === 200, 'http status not 200')
    assert(response.data.response === true)
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
