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

export function findCredential(
  credentials: Credential[],
  consumerCredentials: Credential
): Credential | undefined {
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

export function isAddressCredentialMatch(
  credential: Credential,
  consumerCredentials: Credential
): boolean {
  if (credential?.type?.toLowerCase() !== CREDENTIALS_TYPES.ADDRESS) {
    return false
  }
  if (credential.values.length > 0) {
    const credentialValues = credential.values.map((v) => String(v)?.toLowerCase())
    return credentialValues.includes(consumerCredentials.values[0])
  }

  return false
}

function isAddressMatchAll(credential: Credential): boolean {
  if (credential?.type?.toLowerCase() !== CREDENTIALS_TYPES.ADDRESS) {
    return false
  }
  if (credential.values.length > 0) {
    const filteredValues: string[] = credential.values.filter((value: string) => {
      return value?.toLowerCase() === '*' // address
    })
    return filteredValues.length > 0
  }
  return false
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

/**
 * This method checks credentials
 * @param credentials credentials
 * @param consumerAddress consumer address
 */
export async function checkCredentials(
  credentials: Credentials,
  consumerAddress: string,
  chainId?: number
): Promise<boolean> {
  const consumerCredentials: Credential = {
    type: CREDENTIALS_TYPES.ADDRESS,
    values: [String(consumerAddress)?.toLowerCase()]
  }

  // if no address-based credentials are defined (both allow and deny lists are empty), access to the asset is restricted to everybody;
  // to allow access to everybody, the symbol * will be used in the allow list;
  // if a web3 address is present on both deny and allow lists, the deny list takes precedence
  // and access to the asset is denied for the respective address.
  const accessGranted = false
  // check deny access
  // https://github.com/oceanprotocol/ocean-node/issues/810
  // for deny rules: if value does not exist or it's empty -> there is no deny list. if value list has at least one element, check it

  if (Array.isArray(credentials?.deny) && credentials.deny.length > 0) {
    let denyCount = 0
    for (const cred of credentials.deny) {
      const { type } = cred
      if (type === CREDENTIALS_TYPES.ADDRESS) {
        const accessDeny = isAddressCredentialMatch(cred, consumerCredentials)
        // credential is on deny list, so it should be blocked access
        if (accessDeny) {
          if (!isDefined(credentials.match_deny) || credentials.match_deny === 'any') {
            return false
          }
        }
        denyCount++
        // credential not found, so it really depends if we have a match on the allow list instead
      }
    }
    if (credentials.match_deny === 'all' && denyCount === credentials.deny.length) {
      return false
    }
  }
  // check allow access
  // for allow rules: if value does not exist or it's empty -> no one has access. if value list has at least one element, check it
  if (Array.isArray(credentials?.allow) && credentials.allow.length > 0) {
    let matchCount = 0
    for (const cred of credentials.allow) {
      const { type } = cred
      if (type === CREDENTIALS_TYPES.ADDRESS) {
        const accessAllow = isAddressCredentialMatch(cred, consumerCredentials)
        if (accessAllow || isAddressMatchAll(cred)) {
          // if no match_allow or 'any', its fine
          if (!isDefined(credentials.match_allow) || credentials.match_allow === 'any') {
            return true
          }
          // otherwise, match 'all', in this case the amount of matches should be the same of the amount of rules
          matchCount++
        }
      } else if (type === CREDENTIALS_TYPES.ACCESS_LIST && chainId) {
        const config = await getConfiguration()
        const supportedNetwork = config.supportedNetworks[String(chainId)]
        if (supportedNetwork) {
          const blockChain = getBlockchainHandler(supportedNetwork)
          for (const accessListContractAddress of cred.values) {
            const balanceOk = await findAccessListCredentials(
              blockChain.getSigner(),
              accessListContractAddress,
              consumerAddress
            )
            if (balanceOk) return true
          }
        }
      }
      // extend function to ACCESS_LIST (https://github.com/oceanprotocol/ocean-node/issues/804)
    }
    if (credentials.match_allow === 'all' && matchCount === credentials.allow.length) {
      return true
    }
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
