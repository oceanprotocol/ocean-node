import { Blockchain, getDatatokenDecimals } from '../../../utils/blockchain.js'
import { ethers, parseUnits, formatUnits, BigNumberish } from 'ethers'
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' with { type: 'json' }
import { EscrowAuthorization, EscrowLock } from '../../../@types/Escrow.js'
import { getOceanArtifactsAdressesByChainId } from '../../../utils/address.js'
import { RPCS } from '../../../@types/blockchain.js'
import { AccessListContract } from '../../../@types/OceanNode.js'
import { JobType } from '../../../utils/constants.js'
import { create256Hash } from '../../../utils/crypt.js'
import { sleep } from '../../../utils/util.js'
import { BlockchainRegistry } from '../../BlockchainRegistry/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

/** Cache key for token decimals: "chainId:tokenAddress" (token lowercased) */
const DECIMALS_CACHE_KEY = (chainId: number, token: string) =>
  `${chainId}:${token.toLowerCase()}`

export class Escrow {
  private networks: RPCS
  private claimDurationTimeout: number
  private blockchainRegistry: BlockchainRegistry
  /** Per-chain Subsidy Provider contract addresses, passed to the escrow at claim time. */
  private subsidyProviders: AccessListContract | null
  /** Cache for token decimals to avoid repeated blockchain calls */
  private decimalsCache: Map<string, number> = new Map()

  constructor(
    supportedNetworks: RPCS,
    claimDurationTimeout: number,
    blockchainRegistry: BlockchainRegistry,
    subsidyProviders: AccessListContract | null = null
  ) {
    this.networks = supportedNetworks
    this.claimDurationTimeout = claimDurationTimeout
    this.blockchainRegistry = blockchainRegistry
    this.subsidyProviders = subsidyProviders
  }

  /**
   * Subsidy Provider contract addresses configured for a given chain, or an empty list when none
   * are set. The empty list is the "plain claim" case the escrow expects (no third-party subsidy).
   */
  private getSubsidyProvidersForChain(chain: number): string[] {
    return this.subsidyProviders?.[String(chain)] ?? []
  }

  getEscrowContractAddressForChain(chainId: number): string | null {
    const addresses = getOceanArtifactsAdressesByChainId(chainId)
    if (addresses && addresses.Escrow) return addresses.Escrow
    return null
  }

  getMinLockTime(maxJobDuration: number) {
    return maxJobDuration + this.claimDurationTimeout
  }

  /**
   * Waits for a submitted transaction to be mined. Used when two transactions are sent
   * back-to-back from the node signer (e.g. the immediate createLock → claimLock sequence
   * in Service-on-Demand) so the second tx picks up the advanced account nonce and acts on
   * confirmed on-chain state.
   */
  async waitForTransaction(
    chain: number,
    txHash: string,
    confirmations: number = 1,
    timeoutMs: number = 60000
  ): Promise<void> {
    const blockchain = this.getBlockchain(chain)
    const provider = await blockchain.getProvider()
    await provider.waitForTransaction(txHash, confirmations, timeoutMs)
  }

  /**
   * Get a Blockchain instance for the given chainId from BlockchainRegistry.
   *
   * @param chainId - The chain ID to get a Blockchain instance for
   * @returns Blockchain instance
   * @throws Error if blockchain instance is not available
   */
  private getBlockchain(chainId: number): Blockchain {
    const blockchain = this.blockchainRegistry.getBlockchain(chainId)
    if (!blockchain) {
      throw new Error(`Blockchain instance not available for chain ${chainId}`)
    }
    return blockchain
  }

  /**
   * Get token decimals with cache to avoid repeated blockchain calls.
   */
  private async getDecimals(chain: number, token: string): Promise<number> {
    const key = DECIMALS_CACHE_KEY(chain, token)
    const cached = this.decimalsCache.get(key)
    if (cached !== undefined) {
      return cached
    }
    const blockchain = this.getBlockchain(chain)
    const provider = await blockchain.getProvider()
    const decimalBigNumber = await getDatatokenDecimals(token, provider)
    const decimals = parseInt(decimalBigNumber.toString())
    this.decimalsCache.set(key, decimals)
    return decimals
  }

  async getPaymentAmountInWei(cost: number, chain: number, token: string) {
    const decimals = await this.getDecimals(chain, token)
    const roundedCost = Number(cost.toFixed(decimals)).toString()
    return parseUnits(roundedCost, decimals).toString()
  }

  async getNumberFromWei(wei: string, chain: number, token: string) {
    const decimals = await this.getDecimals(chain, token)
    return parseFloat(formatUnits(wei, decimals))
  }

  getContract(chainId: number, signer: ethers.Signer): ethers.Contract | null {
    const address = this.getEscrowContractAddressForChain(chainId)
    if (!address) return null
    return new ethers.Contract(address, EscrowJson.abi, signer)
  }

  async getUserAvailableFunds(
    chain: number,
    payer: string,
    token: string
  ): Promise<BigInt> {
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    const contract = this.getContract(chain, signer)
    try {
      const funds = await contract.getUserFunds(payer, token)
      return funds.available
    } catch (e) {
      CORE_LOGGER.error('Failed to get user available funds: ' + e.message)
      return null
    }
  }

  async getLocks(
    chain: number,
    token: string,
    payer: string,
    payee: string
  ): Promise<EscrowLock[]> {
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    const contract = this.getContract(chain, signer)
    try {
      return await contract.getLocks(token, payer, payee)
    } catch (e) {
      CORE_LOGGER.error('Failed to get locks: ' + e.message)
      return null
    }
  }

  async getAuthorizations(
    chain: number,
    token: string,
    payer: string,
    payee: string
  ): Promise<EscrowAuthorization[]> {
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    const contract = this.getContract(chain, signer)
    try {
      return await contract.getAuthorizations(token, payer, payee)
    } catch (e) {
      CORE_LOGGER.error('Failed to get authorizations: ' + e.message)
      return null
    }
  }

  async createLock(
    chain: number,
    job: string,
    token: string,
    payer: string,
    amount: number,
    expiry: BigNumberish,
    jobType: JobType = JobType.NONE,
    subsidyOverride: string[] | null = null
  ): Promise<string | null> {
    const jobId = create256Hash(job)
    // Escrow v2 `createLock` takes `jobType` + `subsidyProviders` (lock-time / "prepaid"
    // sponsorship). The node hands the escrow the SAME provider list at lock time as it does at
    // claim time, resolved identically to `claimLock`: a user-supplied override wins, otherwise
    // the per-chain node config is used. `??` (not `||`) so a user-supplied empty list survives
    // as "no providers" (a plain payer-funded lock, identical to the pre-v2 behaviour).
    const subsidyProviders = subsidyOverride ?? this.getSubsidyProvidersForChain(chain)
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    const contract = this.getContract(chain, signer)
    if (!contract) throw new Error(`Failed to initialize escrow contract`)
    const wei = await this.getPaymentAmountInWei(amount, chain, token)

    // Escrow v2 stopgap: when the lock is (partly) sponsored, the payer only needs to cover the
    // UNsponsored portion `P = L - S` — a fully-sponsored lock needs 0 from the payer. We can't
    // know `S` node-side without quoting the providers, so for a sponsored lock we skip the
    // payer-funded pre-checks (available-funds + the `maxLockedAmount` cap) and let the on-chain
    // `createLock` reject authoritatively (e.g. "Payer does not have enough funds"). A plain
    // payer-funded lock (empty provider list) keeps the original fail-fast guards unchanged.
    // TODO(escrow-v2 follow-up): tighten this by quoting the providers' PREFUNDED subsidy
    // (`quoteSubsidyByMode`) to compute `P = L - S` and re-apply the guards against `P` — today
    // a node with a global SUBSIDY_PROVIDERS list skips the fast-fail even when providers end up
    // covering 0 (S=0), so an underfunded payer gets an on-chain revert instead of a clean error.
    const isSponsored = subsidyProviders.length > 0
    if (isSponsored) {
      CORE_LOGGER.debug(
        `createLock: sponsored lock (providers=${subsidyProviders.length}) — skipping payer-funded available-funds + maxLockedAmount guards; contract settles P = L - S authoritatively.`
      )
    }

    if (!isSponsored) {
      const userBalance = await this.getUserAvailableFunds(chain, payer, token)
      if (BigInt(userBalance.toString()) < BigInt(wei)) {
        // not enough funds
        throw new Error(`User ${payer} does not have enough funds`)
      }
    }

    const signerAddress = await signer.getAddress()

    let retries = 2
    let auths: EscrowAuthorization[] = []
    while (retries > 0) {
      auths = await this.getAuthorizations(chain, token, payer, signerAddress)
      if (!auths || auths.length !== 1) {
        CORE_LOGGER.error(
          `No escrow auths found for: chain=${chain}, token=${token}, payer=${payer}, nodeAddress=${signerAddress}. Found ${
            auths?.length || 0
          } authorizations. ${retries > 0 ? 'Retrying..' : ''}`
        )
      } else if (auths && auths.length === 1) {
        break
      }
      if (retries > 1) {
        await sleep(1000)
      }
      retries--
    }
    if (!auths || auths.length !== 1) {
      throw new Error(
        `No escrow auths found for: chain=${chain}, token=${token}, payer=${payer}, nodeAddress=${signerAddress}. Found ${
          auths?.length || 0
        } authorizations.`
      )
    }
    // Payer-funded cap check — skipped for sponsored locks (see the note above). In v2 both
    // `currentLockedAmount` and `maxLockedAmount` track only the payer portion `P`, so comparing
    // them against the gross `wei` would wrongly reject (a `maxLockedAmount == 0` "sponsored-only"
    // auth always would). The contract enforces the real cap on `P`.
    if (
      !isSponsored &&
      BigInt(auths[0].currentLockedAmount.toString()) + BigInt(wei) >
        BigInt(auths[0].maxLockedAmount.toString())
    ) {
      throw new Error(`No valid escrow auths found(will go over limit)`)
    }
    if (BigInt(auths[0].maxLockSeconds.toString()) < BigInt(expiry)) {
      throw new Error(`No valid escrow auths found(maxLockSeconds too low)`)
    }
    if (
      BigInt(auths[0].currentLocks.toString()) + BigInt(1) >
      BigInt(auths[0].maxLockCounts.toString())
    ) {
      throw new Error(`No valid escrow auths found(too many active locks)`)
    }
    // Auth expiry (Escrow v2): a non-zero `expiryTimestamp` is a unix ts after which the payee can
    // no longer create (or extend) locks, and a lock may not be created with an end beyond it (a
    // lock can never outlive its auth). The contract reverts with "Auth expired" in both cases, so
    // fail fast here instead of sending a doomed tx. `0`/undefined = indefinite (also the case on
    // a pre-v2 escrow whose auth tuple has no `expiryTimestamp`), so the check is a no-op there.
    // This gate applies to every lock, sponsored or not (claim/cancel are never expiry-gated).
    // This is an OPTIMISTIC pre-check: it uses the node's wall clock (`Date.now()`), whereas the
    // contract uses the mine-time `block.timestamp`, so the on-chain revert stays authoritative.
    // The bounds mirror the contract (`block.timestamp <= expiry` and `block.timestamp + duration
    // <= expiry`), so equality is allowed on both.
    const { expiryTimestamp } = auths[0]
    if (expiryTimestamp !== undefined && expiryTimestamp !== null) {
      const expiryTs = BigInt(expiryTimestamp.toString())
      if (expiryTs > 0n) {
        const nowSec = BigInt(Math.floor(Date.now() / 1000))
        if (nowSec > expiryTs) {
          throw new Error(`No valid escrow auths found(authorization expired)`)
        }
        // Lock end ≈ now + duration (the contract stamps startTime at mine time ≈ now).
        if (nowSec + BigInt(expiry) > expiryTs) {
          throw new Error(
            `No valid escrow auths found(lock would outlive authorization expiry)`
          )
        }
      }
    }
    try {
      const gas = await contract.createLock.estimateGas(
        jobId,
        token,
        payer,
        wei,
        expiry,
        jobType,
        subsidyProviders
      )
      const gasOptions = await blockchain.getGasOptions(gas, 1.2)
      const tx = await contract.createLock(
        jobId,
        token,
        payer,
        wei,
        expiry,
        jobType,
        subsidyProviders,
        gasOptions
      )
      return tx.hash
    } catch (e) {
      CORE_LOGGER.error('Failed to create lock: ' + e.message)
      throw new Error(String(e.message))
    }
  }

  async claimLock(
    chain: number,
    job: string,
    token: string,
    payer: string,
    amount: number,
    proof: string,
    jobType: JobType = JobType.NONE,
    subsidyOverride: string[] | null = null
  ): Promise<string | null> {
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    const contract = this.getContract(chain, signer)
    const wei = await this.getPaymentAmountInWei(amount, chain, token)
    const jobId = create256Hash(job)
    // `??` (not `||`) so a user-supplied empty list means "no providers" and only a missing
    // override (undefined/null) falls back to the per-chain node config.
    const subsidyProviders = subsidyOverride ?? this.getSubsidyProvidersForChain(chain)
    if (!contract) return null
    try {
      const locks = await this.getLocks(chain, token, payer, await signer.getAddress())
      for (const lock of locks) {
        if (BigInt(lock.jobId.toString()) === BigInt(jobId)) {
          const gas = await contract.claimLockAndWithdraw.estimateGas(
            jobId,
            token,
            payer,
            wei,
            ethers.toUtf8Bytes(proof),
            jobType,
            subsidyProviders
          )
          const gasOptions = await blockchain.getGasOptions(gas, 1.2)
          const tx = await contract.claimLockAndWithdraw(
            jobId,
            token,
            payer,
            wei,
            ethers.toUtf8Bytes(proof),
            jobType,
            subsidyProviders,
            gasOptions
          )
          return tx.hash
        }
      }
      return null
    } catch (e) {
      CORE_LOGGER.error('Failed to claim lock: ' + e.message)
      throw new Error(String(e.message))
    }
  }

  async cancelExpiredLock(
    chain: number,
    job: string,
    token: string,
    payer: string
  ): Promise<string | null> {
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    const jobId = create256Hash(job)
    const contract = this.getContract(chain, signer)

    if (!contract) return null
    try {
      const locks = await this.getLocks(chain, token, payer, await signer.getAddress())
      for (const lock of locks) {
        if (BigInt(lock.jobId.toString()) === BigInt(jobId)) {
          const gas = await contract.cancelExpiredLock.estimateGas(
            jobId,
            token,
            payer,
            await signer.getAddress()
          )
          const gasOptions = await blockchain.getGasOptions(gas, 1.2)
          const tx = await contract.cancelExpiredLock(
            jobId,
            token,
            payer,
            await signer.getAddress(),
            gasOptions
          )

          return tx.hash
        }
      }
      return null
    } catch (e) {
      CORE_LOGGER.error('Failed to cancel expired locks: ' + e.message)
      throw new Error(String(e.message))
    }
  }

  async claimLocks(
    chain: number,
    jobs: string[],
    tokens: string[],
    payers: string[],
    amounts: number[],
    proofs: string[],
    jobType: JobType = JobType.NONE,
    subsidyOverrides: (string[] | null)[] | null = null
  ): Promise<string | null> {
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    const contract = this.getContract(chain, signer)
    if (!contract) return null
    const weis: string[] = []
    const jobIds: string[] = []
    const ethProofs: Uint8Array[] = []
    if (
      jobs.length !== tokens.length ||
      jobs.length !== payers.length ||
      jobs.length !== amounts.length ||
      jobs.length !== proofs.length
    ) {
      throw new Error('Invalid input: all arrays must have the same length')
    }
    for (let i = 0; i < jobs.length; i++) {
      const wei = await this.getPaymentAmountInWei(amounts[i], chain, tokens[i])
      weis.push(wei)
      const jobId = create256Hash(jobs[i])
      jobIds.push(jobId)
      ethProofs.push(ethers.toUtf8Bytes(proofs[i]))
    }
    // Parallel arrays the plural claim ABI expects: one jobType per job (all the same here) and
    // one subsidy-provider list per job. Each job may carry its own user-supplied override; where
    // it doesn't (undefined/null), the per-chain node config is used. `??` (not `||`) so a
    // user-supplied empty list survives as "no providers".
    const chainSubsidyProviders = this.getSubsidyProvidersForChain(chain)
    const jobTypes: JobType[] = jobs.map(() => jobType)
    const subsidyProviders: string[][] = jobs.map(
      (_job, i) => subsidyOverrides?.[i] ?? chainSubsidyProviders
    )
    try {
      const gas = await contract.claimLocksAndWithdraw.estimateGas(
        jobIds,
        tokens,
        payers,
        weis,
        ethProofs,
        jobTypes,
        subsidyProviders
      )
      const gasOptions = await blockchain.getGasOptions(gas, 1.2)
      const tx = await contract.claimLocksAndWithdraw(
        jobIds,
        tokens,
        payers,
        weis,
        ethProofs,
        jobTypes,
        subsidyProviders,
        gasOptions
      )
      return tx.hash
    } catch (e) {
      CORE_LOGGER.error('Failed to claim lock: ' + e.message)
      throw new Error(String(e.message))
    }
  }

  async cancelExpiredLocks(
    chain: number,
    jobs: string[],
    tokens: string[],
    payers: string[],
    generateHash: boolean = true
  ): Promise<string | null> {
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    const ourAddress = await signer.getAddress()
    if (jobs.length !== tokens.length || jobs.length !== payers.length) {
      throw new Error('Invalid input: all arrays must have the same length')
    }
    const jobIds: string[] = []
    const payersAddresses: string[] = []
    for (let i = 0; i < jobs.length; i++) {
      let jobId
      if (generateHash) jobId = create256Hash(jobs[i])
      else jobId = jobs[i]
      jobIds.push(jobId)
      payersAddresses.push(ourAddress)
    }
    const contract = this.getContract(chain, signer)

    if (!contract) return null
    try {
      const gas = await contract.cancelExpiredLocks.estimateGas(
        jobIds,
        tokens,
        payers,
        payersAddresses
      )
      const gasOptions = await blockchain.getGasOptions(gas, 1.2)
      const tx = await contract.cancelExpiredLocks(
        jobIds,
        tokens,
        payers,
        payersAddresses,
        gasOptions
      )

      return tx.hash
    } catch (e) {
      CORE_LOGGER.error('Failed to cancel expired locks: ' + e.message)
      throw new Error(String(e.message))
    }
  }
}
