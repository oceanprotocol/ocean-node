import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import { AccessListContract } from '../@types/OceanNode.js'
import { ethers, Signer } from 'ethers'
import { CORE_LOGGER } from './logging/common.js'
import {
  Credential,
  CREDENTIAL_TYPES,
  Credentials,
  KNOWN_CREDENTIALS_TYPES
} from '../@types/DDO/Credentials.js'
import { getNFTContract } from '../components/Indexer/utils.js'
import { isDefined } from './util.js'

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
  if (credential?.type?.toLowerCase() !== CREDENTIAL_TYPES.ADDRESS) {
    return false
  }
  if (credential.values.length > 0) {
    const credentialValues = credential.values.map((v) => String(v)?.toLowerCase())
    return credentialValues.includes(consumerCredentials.values[0])
  }

  return false
}

function isAddressMatchAll(credential: Credential): boolean {
  if (credential?.type?.toLowerCase() !== CREDENTIAL_TYPES.ADDRESS) {
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
export function checkCredentials(
  credentials: Credentials,
  consumerAddress: string,
  chainId?: number
) {
  const consumerCredentials: Credential = {
    type: CREDENTIAL_TYPES.ADDRESS, // 'address',
    values: [String(consumerAddress)?.toLowerCase()]
  }

  const accessGranted = false
  // check deny access
  // https://github.com/oceanprotocol/ocean-node/issues/810
  // for deny rules: if value does not exist or it's empty -> there is no deny list. if value list has at least one element, check it
  if (Array.isArray(credentials?.deny) && credentials.deny.length > 0) {
    for (const cred of credentials.deny) {
      const { type } = cred
      if (type === CREDENTIAL_TYPES.ADDRESS) {
        const accessDeny = isAddressCredentialMatch(cred, consumerCredentials)
        // credential is on deny list, so it should be blocked access
        if (accessDeny) {
          return false
        }
        // credential not found, so it really depends if we have a match on the allow list instead
      }
      // else TODO later
      // support also for access list type here
      // https://github.com/oceanprotocol/ocean-node/issues/840
      // else if (type === CREDENTIAL_TYPES.ACCESS_LIST && chainId) {
      // }
    }
  }
  // check allow access
  // for allow rules: if value does not exist or it's empty -> no one has access. if value list has at least one element, check it
  if (Array.isArray(credentials?.allow) && credentials.allow.length > 0) {
    for (const cred of credentials.allow) {
      const { type } = cred
      if (type === CREDENTIAL_TYPES.ADDRESS) {
        const accessAllow = isAddressCredentialMatch(cred, consumerCredentials)
        if (accessAllow || isAddressMatchAll(cred)) {
          return true
        }
      }
      // else if (type === CREDENTIAL_TYPES.ACCESS_LIST && chainId) {
      // }
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
