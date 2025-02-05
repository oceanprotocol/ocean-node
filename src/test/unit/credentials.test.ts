import { expect } from 'chai'
import { checkCredentials } from '../../utils/credentials.js'
import { Credentials } from '../../@types/DDO/Credentials.js'
import { Contract, ethers, Signer } from 'ethers'
import AccessListFactory from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessListFactory.sol/AccessListFactory.json' assert { type: 'json' }
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import {
  buildEnvOverrideConfig,
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { Blockchain } from '../../utils/blockchain.js'
import { getConfiguration } from '../../utils/config.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { homedir } from 'os'

let envOverrides: OverrideEnvConfig[]
let config: OceanNodeConfig
let rpcs: RPCS
let network: SupportedNetwork
let blockchain: Blockchain
let contractAcessList: Contract
let signer: Signer
/**
 * Returns a contract instance for the given address
 * @param {string} address - The address of the contract
 * @param {AbiItem[]} [abi] - The ABI of the contract
 * @returns {Contract} - The contract instance
 */
export function getContract(address: string, abi: any, signer: Signer): Contract {
  const contract = new ethers.Contract(address, abi, signer)
  return contract
}

export function getEventFromTx(txReceipt: { logs: any[] }, eventName: string) {
  return txReceipt?.logs?.filter((log) => {
    return log.fragment?.name === eventName
  })[0]
}
/**
 * Create new Access List Contract
 * @param {Signer} signer The signer of the transaction.
 * @param {string} contractFactoryAddress The AccessListFactory address.
 * @param {any} contractFactoryAbi The AccessListFactory ABI.
 * @param {string} nameAccessList The name for access list.
 * @param {string} symbolAccessList The symbol for access list.
 * @param {boolean} transferable Default false, to be soulbound.
 * @param {string} owner Owner of the access list.
 * @param {string[]} user Users of the access lists as addresses.
 * @param {string[]} tokenURI Token URIs list.
 * @return {Promise<string| null>} The transaction hash or null if no transaction
 */
export async function deployAccessListContract(
  signer: Signer,
  contractFactoryAddress: string,
  contractFactoryAbi: any,
  nameAccessList: string,
  symbolAccessList: string,
  transferable: boolean = false,
  owner: string,
  user: string[],
  tokenURI: string[]
): Promise<string | null> {
  if (!nameAccessList || !symbolAccessList) {
    throw new Error(`Access list symbol and name are required`)
  }

  const contract = getContract(contractFactoryAddress, contractFactoryAbi, signer)

  try {
    const tx = await contract.deployAccessListContract(
      nameAccessList,
      symbolAccessList,
      transferable,
      owner,
      user,
      tokenURI
    )

    if (!tx) {
      const e = 'Tx for deploying new access list was not processed on chain.'
      console.error(e)
      throw e
    }
    const trxReceipt = await tx.wait(1)
    const events = getEventFromTx(trxReceipt, 'NewAccessList')
    return events.args[0]
  } catch (e) {
    console.error(`Creation of AccessList failed: ${e}`)
    return null
  }
}

describe('credentials', () => {
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.ADDRESS_FILE],
      [
        '{ "8996":{ "rpc":"http://172.0.0.1:8545", "chainId": 8996, "network": "development", "chunkSize": 100 }}',
        `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
      ]
    )
    envOverrides = await setupEnvironment(null, envOverrides)
    config = await getConfiguration(true)

    rpcs = config.supportedNetworks
    network = rpcs[String(DEVELOPMENT_CHAIN_ID)]
    blockchain = new Blockchain(
      network.rpc,
      network.network,
      network.chainId,
      network.fallbackRPCs
    )
  })
  it('should deploy accessList contract', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    let network = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!network) {
      network = getOceanArtifactsAdresses().development
    }

    signer = blockchain.getSigner()
    const txAddress = await deployAccessListContract(
      signer,
      network.AccessListFactory,
      AccessListFactory.abi,
      'AllowList',
      'ALLOW',
      false,
      await signer.getAddress(),
      [await signer.getAddress()],
      ['https://oceanprotocol.com/nft/']
    )

    contractAcessList = getContract(txAddress, AccessList.abi, signer)
    const balance = await contractAcessList.balanceOf(await signer.getAddress())
    expect(Number(balance)).to.equal(1)
  })

  it('should have balance from accessList contract', async function () {
    const balance = await contractAcessList.balanceOf(await signer.getAddress())
    expect(Number(balance)).to.equal(1)
  })
  it('should allow access with undefined or empty credentials', () => {
    const credentialsUndefined: Credentials = undefined
    const consumerAddress = '0x123'
    const accessGranted1 = checkCredentials(credentialsUndefined, consumerAddress)
    expect(accessGranted1).to.equal(true)
    const credentialsEmapty = {} as Credentials
    const accessGranted2 = checkCredentials(credentialsEmapty, consumerAddress)
    expect(accessGranted2).to.equal(true)
  })
  it('should allow access with empty allow and deny lists', () => {
    const credentials: Credentials = {
      allow: [],
      deny: []
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should allow access with empty values in deny lists', () => {
    const credentials: Credentials = {
      deny: [
        {
          type: 'address',
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should deny access with empty values in allow lists', () => {
    const credentials: Credentials = {
      allow: [
        {
          type: 'address',
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })
  it('should allow access with address in allow list', () => {
    const credentials: Credentials = {
      allow: [
        {
          type: 'address',
          values: ['0x123']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should allow access with address not in deny list', () => {
    const credentials: Credentials = {
      deny: [
        {
          type: 'address',
          values: ['0x456']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should deny access with address in deny list', () => {
    const credentials: Credentials = {
      allow: [
        {
          type: 'address',
          values: []
        }
      ],
      deny: [
        {
          type: 'address',
          values: ['0x123']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })
  it('should deny access with address not in allow list', () => {
    const credentials: Credentials = {
      allow: [
        {
          type: 'address',
          values: ['0x456']
        }
      ],
      deny: [
        {
          type: 'address',
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
