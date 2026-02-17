import { Blockchain, getDatatokenDecimals } from '../../../utils/blockchain.js'
import { ethers, parseUnits, formatUnits, BigNumberish } from 'ethers'
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' with { type: 'json' }
import { EscrowAuthorization, EscrowLock } from '../../../@types/Escrow.js'
import { getOceanArtifactsAdressesByChainId } from '../../../utils/address.js'
import { RPCS } from '../../../@types/blockchain.js'
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
  /** Cache for token decimals to avoid repeated blockchain calls */
  private decimalsCache: Map<string, number> = new Map()

  constructor(
    supportedNetworks: RPCS,
    claimDurationTimeout: number,
    blockchainRegistry: BlockchainRegistry
  ) {
    this.networks = supportedNetworks
    this.claimDurationTimeout = claimDurationTimeout
    this.blockchainRegistry = blockchainRegistry
  }

  // eslint-disable-next-line require-await
  getEscrowContractAddressForChain(chainId: number): string | null {
    const addresses = getOceanArtifactsAdressesByChainId(chainId)
    if (addresses && addresses.Escrow) return addresses.Escrow
    return null
  }

  getMinLockTime(maxJobDuration: number) {
    return Math.ceil(maxJobDuration + this.claimDurationTimeout)
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
    const roundedCost = cost.toFixed(decimals)
    return parseUnits(roundedCost, decimals).toString()
  }

  async getNumberFromWei(wei: string, chain: number, token: string) {
    const decimals = await this.getDecimals(chain, token)
    return parseFloat(formatUnits(wei, decimals))
  }

  // eslint-disable-next-line require-await
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
    expiry: BigNumberish
  ): Promise<string | null> {
    const jobId = create256Hash(job)
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    const contract = this.getContract(chain, signer)
    if (!contract) throw new Error(`Failed to initialize escrow contract`)
    const wei = await this.getPaymentAmountInWei(amount, chain, token)
    const userBalance = await this.getUserAvailableFunds(chain, payer, token)
    if (BigInt(userBalance.toString()) < BigInt(wei)) {
      // not enough funds
      throw new Error(`User ${payer} does not have enough funds`)
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
    if (
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
    try {
      const gas = await contract.createLock.estimateGas(jobId, token, payer, wei, expiry)
      const gasOptions = await blockchain.getGasOptions(gas, 1.2)
      const tx = await contract.createLock(jobId, token, payer, wei, expiry, gasOptions)
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
    proof: string
  ): Promise<string | null> {
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    const contract = this.getContract(chain, signer)
    const wei = await this.getPaymentAmountInWei(amount, chain, token)
    const jobId = create256Hash(job)
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
            ethers.toUtf8Bytes(proof)
          )
          const gasOptions = await blockchain.getGasOptions(gas, 1.2)
          const tx = await contract.claimLockAndWithdraw(
            jobId,
            token,
            payer,
            wei,
            ethers.toUtf8Bytes(proof),
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
    proofs: string[]
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
    try {
      const gas = await contract.claimLocksAndWithdraw.estimateGas(
        jobIds,
        tokens,
        payers,
        weis,
        ethProofs
      )
      const gasOptions = await blockchain.getGasOptions(gas, 1.2)
      const tx = await contract.claimLocksAndWithdraw(
        jobIds,
        tokens,
        payers,
        weis,
        ethProofs,
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
    payers: string[]
  ): Promise<string | null> {
    const blockchain = this.getBlockchain(chain)
    const signer = await blockchain.getSigner()
    if (jobs.length !== tokens.length || jobs.length !== payers.length) {
      throw new Error('Invalid input: all arrays must have the same length')
    }
    const jobIds: string[] = []
    const payersAddresses: string[] = []
    for (let i = 0; i < jobs.length; i++) {
      const jobId = create256Hash(jobs[i])
      jobIds.push(jobId)
      payersAddresses.push(await signer.getAddress())
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
