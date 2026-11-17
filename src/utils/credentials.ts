import { Signer } from 'ethers'
import { AccessListContract } from '../@types/OceanNode.js'
import { CORE_LOGGER } from './logging/common.js'
import { errorSummary } from './logging/redact.js'
import {
  CredentialResolver,
  CredentialRule,
  CredentialRules,
  evaluateCredential,
  evaluateCredentials
} from '@oceanprotocol/ddo-js'
import { CREDENTIALS_TYPES } from '../@types/DDO/Credentials.js'
import { checkAddressOnAccessListWithSigner } from './accessList.js'
import { isDefined } from './util.js'

/**
 * Main credential checking function with blockchain support for accessList checks.
 * The allow/deny rules are evaluated by ddo.js `evaluateCredentials`; the node only
 * resolves rule types that need a chain call (see `resolveCredential`).
 *
 * @param consumerAddress The consumer address to check
 * @param credentials The credentials object containing allow/deny rules
 * @param signer Signer for on-chain accessList checks
 * @returns Promise<boolean> - true if access is granted, false otherwise
 *
 * Logic:
 * 1. If credentials are undefined/null, allow access
 * 2. Check DENY list first with match_deny strategy (default 'any'):
 *    - If match_deny='any' and ANY rule matches, DENY access
 *    - If match_deny='all' and ALL rules match, DENY access
 *    - Unknown types in the deny list are ignored
 * 3. Check ALLOW list with match_allow strategy (default 'all'):
 *    - If match_allow='any' and ANY rule matches, ALLOW access
 *    - If match_allow='all' and ALL rules match, ALLOW access
 *    - Unknown types with match_allow='all' cause DENY
 * 4. If no allow list specified, ALLOW access
 * 5. Malformed credentials (not an object, or allow/deny set but not an array) DENY
 */
export async function checkCredentials(
  consumerAddress: string,
  credentials: CredentialRules,
  signer: Signer
): Promise<boolean> {
  const allowed = await evaluateCredentials(
    consumerAddress,
    credentials,
    accessListResolver(signer)
  )
  if (!allowed) {
    CORE_LOGGER.debug(`Access denied by credentials for consumer ${consumerAddress}`)
  }
  return allowed
}

/**
 * Checks if a consumer address matches a single credential rule
 *
 * @param credential The credential rule to check
 * @param consumerAddress The consumer address
 * @param signer Signer for blockchain checks
 * @returns Promise<boolean | null> - true if matches, false if doesn't match, null if unknown type
 */
export function checkSingleCredential(
  credential: CredentialRule,
  consumerAddress: string,
  signer: Signer | null
): Promise<boolean | null> {
  return evaluateCredential(credential, consumerAddress, accessListResolver(signer))
}

/**
 * Resolves the rule types ddo.js cannot check itself. `address` rules never reach
 * here; ddo.js matches them.
 */
function accessListResolver(signer: Signer | null): CredentialResolver {
  return (credential, consumerAddress) =>
    resolveCredential(credential, consumerAddress, signer)
}

async function resolveCredential(
  credential: CredentialRule,
  consumerAddress: string,
  signer: Signer | null
): Promise<boolean | null> {
  const credentialType = credential.type.toLowerCase()

  // ========================================
  // Handle ACCESSLIST-based credentials
  // ========================================
  if (credentialType === CREDENTIALS_TYPES.ACCESS_LIST.toLowerCase()) {
    const accessListCredential = credential as any

    // AccessList credentials need a contract address to check
    if (!isDefined(accessListCredential.accessList)) {
      CORE_LOGGER.debug('AccessList credential missing accessList contract address')
      return false
    }

    try {
      // Check if the consumer address has tokens in the access list contract
      return await checkAddressOnAccessListWithSigner(
        accessListCredential.accessList,
        consumerAddress,
        signer
      )
    } catch (error) {
      CORE_LOGGER.error(
        `Error checking accessList credential ${accessListCredential.accessList}: ${errorSummary(error)}`
      )
      return false
    }
  }

  // ========================================
  // Handle VERIFIABLE CREDENTIAL (future support)
  // ========================================
  if (credentialType === 'verifiablecredential') {
    CORE_LOGGER.debug('VerifiableCredential type is not yet supported')
    return null // Unknown/unsupported type
  }

  // ========================================
  // Unknown credential type
  // ========================================
  CORE_LOGGER.debug(`Unknown credential type: ${credential.type}`)
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
      const result = await checkAddressOnAccessListWithSigner(
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
      CORE_LOGGER.debug(
        `Account ${addressToCheck} is not on any access list for chain ${chainId}`
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
