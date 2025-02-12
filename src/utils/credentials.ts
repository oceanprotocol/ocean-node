import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import { AccessListContract } from '../@types/OceanNode.js'
import { ethers, Signer } from 'ethers'
import { CORE_LOGGER } from './logging/common.js'
import {
  Credential,
  Credentials,
  KNOWN_CREDENTIALS_TYPES
} from '../@types/DDO/Credentials.js'
import { getNFTContract } from '../components/Indexer/utils.js'
import { isDefined } from './util.js'

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
    KNOWN_CREDENTIALS_TYPES.includes(credentialType.toLowerCase())
  )
}
