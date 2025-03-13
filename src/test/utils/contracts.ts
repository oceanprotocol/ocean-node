import { Contract, ethers, JsonRpcProvider, Signer } from 'ethers'
import { AccessListContract } from '../../@types'
import {
  getOceanArtifactsAdressesByChainId,
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses
} from '../../utils/address.js'
import AccessListFactory from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessListFactory.sol/AccessListFactory.json' assert { type: 'json' }
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }

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

export async function deployAndGetAccessListConfig(
  owner: Signer
): Promise<AccessListContract | null> {
  const provider = new JsonRpcProvider('http://127.0.0.1:8545')
  let networkArtifacts = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
  if (!networkArtifacts) {
    networkArtifacts = getOceanArtifactsAdresses().development
  }

  const wallets = [
    (await provider.getSigner(0)) as Signer,
    (await provider.getSigner(1)) as Signer,
    (await provider.getSigner(2)) as Signer,
    (await provider.getSigner(3)) as Signer
  ]
  const txAddress = await deployAccessListContract(
    owner, // owner is first account
    networkArtifacts.AccessListFactory,
    AccessListFactory.abi,
    'AllowList',
    'ALLOW',
    false,
    await owner.getAddress(),
    [
      await wallets[0].getAddress(),
      await wallets[1].getAddress(),
      await wallets[2].getAddress(),
      await wallets[3].getAddress()
    ],
    ['https://oceanprotocol.com/nft/']
  )
  console.log('txAddress: ', txAddress)

  const contractAcessList = getContract(txAddress, AccessList.abi, owner)
  console.log('contractAcessList:', contractAcessList)
  if (contractAcessList) {
    const result = {}
    const key: string = `${DEVELOPMENT_CHAIN_ID}`
    Object.defineProperty(result, key, {
      value: [txAddress],
      writable: true
    })

    return result as AccessListContract
  }
  return null
}
