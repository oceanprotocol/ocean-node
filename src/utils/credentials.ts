import { Signer } from 'ethers'
import { AccessListContract } from '../@types/OceanNode.js'
import { CORE_LOGGER } from './logging/common.js'
import { Credential, Credentials, MATCH_RULES } from '@oceanprotocol/ddo-js'
import { CREDENTIALS_TYPES } from '../@types/DDO/Credentials.js'
import { checkAddressOnAccessList } from './accessList.js'
import { isDefined } from './util.js'

/**
 * Main credential checking function with blockchain support for accessList checks
 *
 * @param consumerAddress The consumer address to check
 * @param credentials The credentials object containing allow/deny rules
 * @param blockchain Blockchain instance to get signer for on-chain checks
 * @returns Promise<boolean> - true if access is granted, false otherwise
 *
 * Logic:
 * 1. If credentials are undefined/empty, allow access
 * 2. Check DENY list first with match_deny strategy (default 'any'):
 *    - If match_deny='any' and ANY rule matches, DENY access
 *    - If match_deny='all' and ALL rules match, DENY access
 *    - Unknown types with match_deny='all' are ignored
 * 3. Check ALLOW list with match_allow strategy (default 'all'):
 *    - If match_allow='any' and ANY rule matches, ALLOW access
 *    - If match_allow='all' and ALL rules match, ALLOW access
 *    - Unknown types with match_allow='all' cause DENY
 * 4. If no allow list specified, ALLOW access
 */
export async function checkCredentials(
  consumerAddress: string,
  credentials: Credentials,
  signer: Signer
): Promise<boolean> {
  // If credentials are undefined or empty, allow access
  if (!isDefined(credentials)) {
    return true
  }

  const normalizedAddress = consumerAddress.toLowerCase()
  // Get matching strategies (with defaults)
  const matchDeny: MATCH_RULES = credentials.match_deny || 'any'
  const matchAllow: MATCH_RULES = credentials.match_allow || 'all'

  // ========================================
  // STEP 1: Check DENY list (checked first)
  // ========================================
  if (isDefined(credentials.deny) && credentials.deny.length > 0) {
    const denyResult = await evaluateCredentialList(
      credentials.deny,
      normalizedAddress,
      signer,
      matchDeny,
      'deny'
    )

    // If evaluation says to deny, return false
    if (denyResult.shouldDeny) {
      CORE_LOGGER.logMessage(
        `Access denied: Consumer address ${consumerAddress} matched deny rule(s)`
      )
      return false
    }
  }

  // ========================================
  // STEP 2: Check ALLOW list
  // ========================================
  if (isDefined(credentials.allow) && credentials.allow.length > 0) {
    const allowResult = await evaluateCredentialList(
      credentials.allow,
      normalizedAddress,
      signer,
      matchAllow,
      'allow'
    )

    return allowResult.shouldAllow
  }

  // No allow list specified, grant access by default
  return true
}

/**
 * Evaluates a list of credentials (either allow or deny)
 */
async function evaluateCredentialList(
  credentialList: Credential[],
  consumerAddress: string,
  signer: Signer,
  matchRule: MATCH_RULES,
  listType: 'allow' | 'deny'
): Promise<{ shouldAllow: boolean; shouldDeny: boolean }> {
  const matchResults: boolean[] = []
  for (const credential of credentialList) {
    const matchResult = await checkSingleCredential(credential, consumerAddress, signer)

    if (matchResult === null) {
      // Unknown or unsupported credential type

      if (listType === 'allow' && matchRule === 'all') {
        // Unknown type in allow list with match_all='all' -> DENY
        CORE_LOGGER.warn(
          `Unknown credential type '${credential.type}' in allow list with match_allow='all'. Access denied.`
        )
        return { shouldAllow: false, shouldDeny: false }
      }
      // For deny list with match_all='all', unknown types are ignored
      // For 'any' match, unknown types don't contribute to matching
    } else {
      matchResults.push(matchResult)
    }
  }

  // No valid credential checks were performed
  if (matchResults.length === 0) {
    if (listType === 'allow') {
      // No valid allow rules means deny
      return { shouldAllow: false, shouldDeny: false }
    } else {
      // No valid deny rules means don't deny
      return { shouldAllow: false, shouldDeny: false }
    }
  }

  // Apply matching strategy
  if (listType === 'deny') {
    let shouldDeny = false
    if (matchRule === 'any') {
      // If ANY rule matches, deny
      shouldDeny = matchResults.some((r) => r === true)
    } else {
      // matchRule === 'all'
      // If ALL rules match, deny
      shouldDeny = matchResults.every((r) => r === true)
    }
    return { shouldAllow: false, shouldDeny }
  } else {
    // listType === 'allow'
    let shouldAllow = false
    if (matchRule === 'any') {
      // If ANY rule matches, allow
      shouldAllow = matchResults.some((r) => r === true)
    } else {
      // matchRule === 'all'
      // ALL rules must match
      shouldAllow = matchResults.every((r) => r === true)
    }
    return { shouldAllow, shouldDeny: false }
  }
}

/**
 * Checks if a consumer address matches a single credential rule
 *
 * @param credential The credential rule to check
 * @param consumerAddress The consumer address (already normalized)
 * @param signer Signer for blockchain checks
 * @returns Promise<boolean | null> - true if matches, false if doesn't match, null if unknown type
 */
export async function checkSingleCredential(
  credential: Credential,
  consumerAddress: string,
  signer: Signer | null
): Promise<boolean | null> {
  const credentialType = credential.type.toLowerCase()

  // ========================================
  // Handle ADDRESS-based credentials
  // ========================================
  if (credentialType === CREDENTIALS_TYPES.ADDRESS.toLowerCase()) {
    // Type assertion since we know it's address type
    const addressCredential = credential as any

    if (!isDefined(addressCredential.values) || addressCredential.values.length === 0) {
      return false
    }

    // Check for wildcard (*)
    const hasWildcard = addressCredential.values.some(
      (value: string) => value.toLowerCase() === '*'
    )
    if (hasWildcard) {
      return true
    }

    // Check if address is in the list
    const normalizedValues = addressCredential.values.map((v: string) => v.toLowerCase())
    return normalizedValues.includes(consumerAddress.toLowerCase())
  }

  // ========================================
  // Handle ACCESSLIST-based credentials
  // ========================================
  if (credentialType === CREDENTIALS_TYPES.ACCESS_LIST.toLowerCase()) {
    const accessListCredential = credential as any

    // AccessList credentials need a contract address to check
    if (!isDefined(accessListCredential.accessList)) {
      CORE_LOGGER.warn('AccessList credential missing accessList contract address')
      return false
    }

    try {
      // Check if the consumer address has tokens in the access list contract
      const hasAccess = await checkAddressOnAccessList(
        accessListCredential.accessList,
        consumerAddress,
        signer
      )
      return hasAccess
    } catch (error) {
      CORE_LOGGER.error(`Error checking accessList credential: ${error.message}`)
      return false
    }
  }

  // ========================================
  // Handle VERIFIABLE CREDENTIAL (future support)
  // ========================================
  if (credentialType === 'verifiablecredential') {
    CORE_LOGGER.warn('VerifiableCredential type is not yet supported')
    return null // Unknown/unsupported type
  }

  // ========================================
  // Unknown credential type
  // ========================================
  CORE_LOGGER.warn(`Unknown credential type: ${credential.type}`)
  return null
}

/**
 * Checks credential on multi-chain access list
 * @param accessList the access list contract addresses by chain
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
      const result = await checkAddressOnAccessList(
        accessListAddress,
        addressToCheck,
        signer
      )
      if (result) {
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

/**
 * Gets all addresses present on the contract access list (the ones with balanceOf >= 1)
 * @param contractAcessList The access list contract
 * @param chainId The chain ID
 * @param startBlock Optional start block
 * @param endBlock Optional end block
 * @returns Array of addresses that have access
 
export async function getAccountsFromAccessList(
  contractAcessList: Contract,
  chainId: number,
  startBlock?: number,
  endBlock?: number
): Promise<string[]> {
  const resultAccounts: string[] = []
  const networkArtifacts = getOceanArtifactsAdressesByChainId(chainId)
  // some basic extra checks
  if (!networkArtifacts || (startBlock && endBlock && endBlock < startBlock)) {
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
      if (log.args.length === 2 && Number(log.args[1]) >= 1) {
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
  */
