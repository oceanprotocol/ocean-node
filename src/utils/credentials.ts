import { Contract, ethers, EventLog, Signer } from 'ethers'
import {
  Credential,
  Credentials,
  KNOWN_CREDENTIALS_TYPES
} from '../@types/DDO/Credentials.js'
import { getNFTContract } from '../components/Indexer/utils.js'
import { isDefined } from './util.js'
import { getOceanArtifactsAdressesByChainId } from './address.js'
import { CORE_LOGGER } from './logging/common.js'

export function findCredential(
  credentials: Credential[],
  consumerCredentials: Credential
) {
  return credentials.find((credential) => {
    if (Array.isArray(credential?.values)) {
      if (credential.values.length > 0) {
        const credentialType = String(credential?.type)?.toLowerCase()
        const credentialValues = credential.values.map((v) => String(v)?.toLowerCase())
        return (
          credentialType === consumerCredentials.type &&
          credentialValues.includes(consumerCredentials.values[0])
        )
      }
    }
    return false
  })
}

/**
 * This method checks credentials
 * @param credentials credentials
 * @param consumerAddress consumer address
 */
export function checkCredentials(credentials: Credentials, consumerAddress: string) {
  const consumerCredentials: Credential = {
    type: 'address',
    values: [String(consumerAddress)?.toLowerCase()]
  }
  // check deny access
  if (Array.isArray(credentials?.deny) && credentials.deny.length > 0) {
    const accessDeny = findCredential(credentials.deny, consumerCredentials)
    if (accessDeny) {
      return false
    }
  }
  // check allow access
  if (Array.isArray(credentials?.allow) && credentials.allow.length > 0) {
    const accessAllow = findCredential(credentials.allow, consumerCredentials)
    if (!accessAllow) {
      return false
    }
  }
  return true
}
// from https://github.com/oceanprotocol/ocean-node/issues/808
// The idea is to use an nft contract and check if one address is on the list by calling 'balanceOf'
// (means user has at least one token)
export async function findAccessListCredentials(
  signer: Signer,
  contractAddress: string,
  address: string
): Promise<boolean> {
  const nftContract: ethers.Contract = getNFTContract(signer, contractAddress)
  if (!nftContract) {
    return false
  }
  return await findAccountFromAccessList(nftContract, address)
}

export async function findAccountFromAccessList(
  nftContract: ethers.Contract,
  walletAddress: string
): Promise<boolean> {
  try {
    const balance = await nftContract.balanceOf(walletAddress)
    return Number(balance) > 0
  } catch (err) {
    return false
  }
}

export function isKnownCredentialType(credentialType: string): boolean {
  return (
    isDefined(credentialType) &&
    KNOWN_CREDENTIALS_TYPES.includes(credentialType.toLowerCase())
  )
}

/**
 * Gets the addresses present on the contract access list (the ones with balanceOf > 1)
 * @param contractAcessList
 * @param chainId
 * @returns
 */
export async function getAccountsFromAccessList(
  contractAcessList: Contract,
  chainId: number,
  startBlock?: number,
  endBlock?: number
): Promise<string[]> {
  const resultAccounts: string[] = []
  const networkArtifacts = getOceanArtifactsAdressesByChainId(chainId)
  // some basic extra checks
  if (!networkArtifacts || (startBlock && endBlock && endBlock > startBlock)) {
    return resultAccounts
  }

  try {
    const eventLogs: Array<EventLog> = (await contractAcessList.queryFilter(
      'AddressAdded',
      startBlock || networkArtifacts.startBlock,
      endBlock || 'latest'
    )) as Array<EventLog>
    for (const log of eventLogs) {
      // check the account address
      if (log.args.length === 2 && Number(log.args[1] >= 1)) {
        const address: string = log.args[0]
        // still has it?
        const balance = await contractAcessList.balanceOf(address)
        if (Number(balance) >= 1) {
          resultAccounts.push(address)
        }
      }
    }
  } catch (e) {
    CORE_LOGGER.error(
      `Cannot get accounts from accessList ${contractAcessList}: \n${e.message}`
    )
  }
  return resultAccounts
}
