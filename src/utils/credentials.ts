import { Contract, ethers, EventLog, Signer } from 'ethers'
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import { AccessListContract } from '../@types/OceanNode.js'
import { CORE_LOGGER } from './logging/common.js'
import {
  Credential,
  Credentials,
  CREDENTIALS_TYPES,
  KNOWN_CREDENTIALS_TYPES
} from '@oceanprotocol/ddo-js'
import { getNFTContract } from '../components/Indexer/utils.js'
import { isDefined } from './util.js'
import { getConfiguration } from './config.js'
import { getBlockchainHandler } from './blockchain.js'

import { getOceanArtifactsAdressesByChainId } from './address.js'

function isValidCredentialsList(credentials: Credential[]): boolean {
  return Array.isArray(credentials) && credentials.length > 0
}

function isAddressCredentialMatch(
  credential: Credential,
  consumerCredentials: Credential
): boolean {
  if (credential?.type?.toLowerCase() !== CREDENTIALS_TYPES.ADDRESS) {
    return false
  }

  const credentialValues = credential.values.map((v) => String(v)?.toLowerCase())
  return credentialValues.includes(consumerCredentials.values[0])
}

function checkAddressCredential(
  cred: Credential,
  consumerCredentials: Credential,
  credentials: Credentials
): boolean {
  const accessAllow = isAddressCredentialMatch(cred, consumerCredentials)
  if (accessAllow || isAddressMatchAll(cred)) {
    return !credentials.match_allow || credentials.match_allow === 'any'
  }
  return false
}

async function checkAccessListCredential(
  cred: Credential,
  consumerCredentials: Credential,
  chainId?: number
): Promise<boolean> {
  if (cred.type !== CREDENTIALS_TYPES.ACCESS_LIST || !chainId) {
    return false
  }

  const config = await getConfiguration()
  const supportedNetwork = config.supportedNetworks[String(chainId)]
  if (!supportedNetwork) {
    return false
  }

  const blockChain = getBlockchainHandler(supportedNetwork)
  for (const accessListAddress of cred.values) {
    if (
      await findAccessListCredentials(
        blockChain.getSigner(),
        accessListAddress,
        consumerCredentials.values[0]
      )
    ) {
      return true
    }
  }
  return false
}

function checkDenyList(
  credentials: Credentials,
  consumerCredentials: Credential
): boolean {
  if (!isValidCredentialsList(credentials.deny)) {
    return false
  }

  let denyCount = 0
  for (const cred of credentials.deny) {
    if (cred.type === CREDENTIALS_TYPES.ADDRESS) {
      const accessDeny = isAddressCredentialMatch(cred, consumerCredentials)
      if (accessDeny) {
        if (!credentials.match_deny || credentials.match_deny === 'any') {
          return true
        }
        denyCount++
      }
    }
  }

  return credentials.match_deny === 'all' && denyCount === credentials.deny.length
}

async function checkAllowList(
  credentials: Credentials,
  consumerCredentials: Credential,
  chainId?: number
): Promise<boolean> {
  if (!isValidCredentialsList(credentials.allow)) {
    return false
  }

  let matchCount = 0
  for (const cred of credentials.allow) {
    if (cred.type === CREDENTIALS_TYPES.ADDRESS) {
      if (checkAddressCredential(cred, consumerCredentials, credentials)) {
        return true
      }
      matchCount++
    } else if (await checkAccessListCredential(cred, consumerCredentials, chainId)) {
      return true
    }
  }

  return credentials.match_allow === 'all' && matchCount === credentials.allow.length
}

function isAddressMatchAll(credential: Credential): boolean {
  if (credential?.type?.toLowerCase() !== CREDENTIALS_TYPES.ADDRESS) {
    return false
  }

  return credential.values.some((value) => value?.toLowerCase() === '*')
}

export function hasAddressMatchAllRule(credentials: Credential[]): boolean {
  const creds = credentials.find((credential: Credential) => {
    if (Array.isArray(credential?.values)) {
      return isAddressMatchAll(credential)
    }
    return false
  })
  return isDefined(creds)
}

export async function checkCredentials(
  credentials: Credentials,
  consumerAddress: string,
  chainId?: number
): Promise<boolean> {
  if (!credentials || (!credentials?.allow && !credentials?.deny)) {
    return false
  }

  const consumerCredentials: Credential = {
    type: CREDENTIALS_TYPES.ADDRESS,
    values: [String(consumerAddress)?.toLowerCase()]
  }

  const isDenied = checkDenyList(credentials, consumerCredentials)
  if (isDenied) {
    return false
  }

  const isAllowed = await checkAllowList(credentials, consumerCredentials, chainId)
  return isAllowed
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
  if (!accessList) {
    return true
  }
  const chainsListed = Object.keys(accessList)
  // check the access lists for this chain
  if (chainsListed.length > 0 && chainsListed.includes(chainId)) {
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
  try {
    const nftContract: ethers.Contract = getNFTContract(signer, contractAddress)
    if (!nftContract) {
      return false
    }
    return await findAccountFromAccessList(nftContract, address)
  } catch (e) {
    CORE_LOGGER.error(
      `Unable to read accessList contract from address ${contractAddress}: ${e.message}`
    )
    return false
  }
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
