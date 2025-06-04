import { JsonRpcProvider, Signer, Wallet } from 'ethers'
import { Database } from '../../components/database/index.js'
import { Auth } from '../../components/Auth/index.js'
import { getConfiguration, getMessageHash } from '../../utils/index.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment,
  getMockSupportedNetworks
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import axios from 'axios'
import { OceanNode } from '../../OceanNode.js'
import { CreateAuthTokenHandler } from '../../components/core/handler/authHandler.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'stream'

describe('Auth Token Integration Tests', () => {
  let config: OceanNodeConfig
  let database: Database
  let auth: Auth
  let provider: JsonRpcProvider
  let consumerAccount: Signer
  let previousConfiguration: OverrideEnvConfig[]
  let oceanNode: OceanNode

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const url = 'http://localhost:8000/api/services/auth'
  const validateDdoUrl = 'http://localhost:8000/api/aquarius/assets/ddo/validate'


  before(async () => {
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.INDEXER_NETWORKS],
        [JSON.stringify(mockSupportedNetworks), JSON.stringify([8996])]
      )
    )

    config = await getConfiguration(true)
    database = await new Database(config.dbConfig)
    auth = new Auth(database.authToken)
    oceanNode = await OceanNode.getInstance(config, database)

    provider = new JsonRpcProvider(mockSupportedNetworks['8996'].rpc)

    const consumerPrivateKey =
      '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
    consumerAccount = new Wallet(consumerPrivateKey, provider)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })

  const ddoValiationRequest = async (token: string) => {
    try {
      const validateResponse = await axios.post(
        `${validateDdoUrl}`,
        {
          ddo: {
            id: 'did:op:f00896cc6f5f9f2c17be06dd28bd6be085e1406bb55274cbd2b65b7271e7b104',
            '@context': [],
            version: '4.1.0',
            nftAddress: '0x3357cCd4e75536422b61F6aeda3ad38545b9b01F',
            chainId: 11155111,
            metadata: {
              created: new Date().toISOString(),
              updated: new Date().toISOString(),
              type: 'dataset',
              name: 'Test DDO',
              description: 'Test DDO',
              tags: [],
              author: 'Test Author',
              license: 'https://market.oceanprotocol.com/terms',
              additionalInformation: {
                termsAndConditions: true
              }
            },
            services: [
              {
                id: 'ccb398c50d6abd5b456e8d7242bd856a1767a890b537c2f8c10ba8b8a10e6025',
                type: 'compute',
                files: '0x0',
                datatokenAddress: '0x0Cf4BE72EAD0583deD382589aFcbF34F3E860Bdc',
                serviceEndpoint: '',
                timeout: 86400
              }
            ]
          }
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream'
          }
        }
      )

      return validateResponse
    } catch (error) {
      console.log(`Error validating DDO: ${error}`)
      return { status: error.response.status, data: error.response.data }
    }
  }

  describe('Token Management Tests', () => {
    it('should create and validate token', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const consumerAddress = await consumerAccount.getAddress()
      const message = auth.getSignatureMessage()
      const messageHash = getMessageHash(message)
      const signature = await consumerAccount.signMessage(messageHash)

      const handlerResponse = await new CreateAuthTokenHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
        address: consumerAddress,
        signature
      })

      console.log({ handlerResponse })

      const token = await streamToObject(handlerResponse.stream as Readable)

      console.log({ token })



      // const testEndpointResponse = await ddoValiationRequest(createResponse.data.token)
      // expect(testEndpointResponse.status).to.equal(200)
    })

    //   it('should handle token expiry', async function () {
    //     this.timeout(DEFAULT_TEST_TIMEOUT)

    //     const consumerAddress = await consumerAccount.getAddress()
    //     const message = auth.getSignatureMessage()
    //     const messageHash = getMessageHash(message)
    //     const signature = await consumerAccount.signMessage(messageHash)

    //     // Create token with 1 second expiry
    //     const validUntil = Date.now() + 1000
    //     const createResponse = await axios.post(`${url}/token`, {
    //       signature,
    //       address: consumerAddress,
    //       validUntil
    //     })
    //     expect(createResponse.status).to.equal(200)

    //     // Wait for token to expire
    //     await new Promise((resolve) => setTimeout(resolve, 2000))

    //     const testEndpointResponse = await ddoValiationRequest(createResponse.data.token)
    //     expect(testEndpointResponse.status).to.equal(401)
    //   })

    //   it('should invalidate token', async function () {
    //     this.timeout(DEFAULT_TEST_TIMEOUT)

    //     const consumerAddress = await consumerAccount.getAddress()
    //     const message = auth.getSignatureMessage()
    //     const messageHash = getMessageHash(message)
    //     const signature = await consumerAccount.signMessage(messageHash)

    //     const createResponse = await axios.post(`${url}/token`, {
    //       signature,
    //       address: consumerAddress
    //     })
    //     const { token } = createResponse.data

    //     await axios.post(`${url}/token/invalidate`, {
    //       signature,
    //       address: consumerAddress,
    //       token
    //     })

    //     const testEndpointResponse = await ddoValiationRequest(token)
    //     expect(testEndpointResponse.status).to.equal(401)
    //   })

    //   describe('Error Cases', () => {
    //     it('should handle invalid signatures', async function () {
    //       this.timeout(DEFAULT_TEST_TIMEOUT)

    //       const consumerAddress = await consumerAccount.getAddress()

    //       try {
    //         await axios.post(`${url}/token`, {
    //           signature: '0xinvalid',
    //           address: consumerAddress
    //         })
    //         expect.fail('Should have thrown error for invalid signature')
    //       } catch (error) {
    //         expect(error.response.status).to.equal(400)
    //       }
    //     })

    //     it('should handle invalid tokens', async function () {
    //       this.timeout(DEFAULT_TEST_TIMEOUT)

    //       const testEndpointResponse = await ddoValiationRequest('invalid-token')
    //       expect(testEndpointResponse.status).to.equal(401)
    //     })

    //     it('should handle missing parameters', async function () {
    //       this.timeout(DEFAULT_TEST_TIMEOUT)

    //       // Missing signature
    //       try {
    //         await axios.post(`${url}/token`, {
    //           address: await consumerAccount.getAddress()
    //         })
    //         expect.fail('Should have thrown error for missing signature')
    //       } catch (error) {
    //         expect(error.response.status).to.equal(400)
    //       }

    //       // Missing address
    //       try {
    //         const message = auth.getSignatureMessage()
    //         const messageHash = getMessageHash(message)
    //         const signature = await consumerAccount.signMessage(messageHash)

    //         await axios.post(`${url}/token`, {
    //           signature
    //         })
    //         expect.fail('Should have thrown error for missing address')
    //       } catch (error) {
    //         expect(error.response.status).to.equal(400)
    //       }
    //     })
    //   })
    // })
  })
})
