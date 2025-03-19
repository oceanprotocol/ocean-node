import { Contract, ethers, EventLog, Signer } from 'ethers'
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import { AccessListContract } from '../@types/OceanNode.js'
import { CORE_LOGGER } from './logging/common.js'
import {
  Credential,
  Credentials,
  KNOWN_CREDENTIALS_TYPES
} from '../@types/DDO/Credentials.js'
import { getNFTContract } from '../components/Indexer/utils.js'
import { isDefined } from './util.js'
import { getOceanArtifactsAdressesByChainId } from './address.js'

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

export function hasAddressMatchAllRule(credentials: Credential[]): boolean {
  const creds = credentials.find((credential: Credential) => {
    if (Array.isArray(credential?.values)) {
      if (credential.values.length > 0 && credential.type) {
        const filteredValues: string[] = credential.values.filter((value: string) => {
          return value?.toLowerCase() === '*' // address
        })
        return (
          filteredValues.length > 0 &&
          credential.type.toLowerCase() === KNOWN_CREDENTIALS_TYPES[0]
        )
      }
    }
    return false
  })
  return isDefined(creds)
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

  const accessGranted = true
  // check deny access
  if (Array.isArray(credentials?.deny) && credentials.deny.length > 0) {
    const accessDeny = findCredential(credentials.deny, consumerCredentials)
    // credential is on deny list, so it should be blocked access
    if (accessDeny) {
      return false
    }
    // credential not found, so it really depends if we have a match
  }
  // check allow access
  if (Array.isArray(credentials?.allow) && credentials.allow.length > 0) {
    const accessAllow = findCredential(credentials.allow, consumerCredentials)
    if (accessAllow || hasAddressMatchAllRule(credentials.allow)) {
      return true
    }
    return false
  }
  return accessGranted
}

export function areKnownCredentialTypes(credentials: Credentials): boolean {
  if (isDefined(credentials)) {
    if (isDefined(credentials.allow) && credentials.allow.length > 0) {
      for (const credential of credentials.allow) {
        if (!isKnownCredentialType(credential.type)) {
          return false
        }
      }
    }

    if (isDefined(credentials.deny) && credentials.deny.length > 0) {
      for (const credential of credentials.deny) {
        if (!isKnownCredentialType(credential.type)) {
          return false
        }
      }
    }
  }
  return true
}

/**
 * @param accessList the access list contract address
 * @param chainId the chain id to check
 * @returns true if the config exists, false otherwise
 */
export function existsAccessListConfigurationForChain(
  accessList: AccessListContract,
  chainId: string
) {
  if (!accessList) return false
  const chainsListed = Object.keys(accessList)
  // check the access lists for this chain
  return chainsListed.length > 0 && chainsListed.includes(chainId)
}

// utility function that can be used on multiple access lists
/**
 * @param accessList the access list contract address
 * @param chainId the chain id to check
 * @param addressToCheck the account address to check on the access list
 * @param signer signer for the contract part
 * @returns true if the account has balanceOf > 0 OR if the accessList is empty OR does not contain info for this chain, false otherwise
 */
export async function checkCredentialOnAccessList(
  accessList: AccessListContract,
  chainId: string,
  addressToCheck: string,
  signer: Signer
): Promise<boolean> {
  const existsAccessList = existsAccessListConfigurationForChain(accessList, chainId)
  if (!existsAccessList) {
    return true
  }
  // check the access lists for this chain
  if (existsAccessList) {
    let isAuthorized = false
    for (const accessListAddress of accessList[chainId]) {
      const accessListContract = new ethers.Contract(
        accessListAddress,
        AccessList.abi,
        signer
      )
      // if has at least 1 token than is is authorized
      const balance = await accessListContract.balanceOf(addressToCheck)
      if (Number(balance) > 0) {
        isAuthorized = true
        break
      }
    }
    if (!isAuthorized) {
      CORE_LOGGER.error(
        `Account ${addressToCheck} is NOT part of the given access list group.`
      )
    }
    return isAuthorized
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
    KNOWN_CREDENTIALS_TYPES.findIndex((type) => {
      return type.toLowerCase() === credentialType.toLowerCase()
    }) > -1
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
