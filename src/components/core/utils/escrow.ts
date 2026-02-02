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

export class Escrow {
  private networks: RPCS
  private claimDurationTimeout: number
  private blockchainRegistry: BlockchainRegistry

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
    return maxJobDuration + this.claimDurationTimeout
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

  async getPaymentAmountInWei(cost: number, chain: number, token: string) {
    const blockchain = this.getBlockchain(chain)
    const provider = await blockchain.getProvider()

    const decimalgBigNumber = await getDatatokenDecimals(token, provider)
    const decimals = parseInt(decimalgBigNumber.toString())

    const roundedCost = Number(cost.toFixed(decimals)).toString()

    return parseUnits(roundedCost, decimals).toString()
  }

  async getNumberFromWei(wei: string, chain: number, token: string) {
    const blockchain = this.getBlockchain(chain)
    const provider = await blockchain.getProvider()
    const decimals = await getDatatokenDecimals(token, provider)
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

  async cancelExpiredLocks(
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
          const gas = await contract.cancelExpiredLocks.estimateGas(
            jobId,
            token,
            payer,
            await signer.getAddress()
          )
          const gasOptions = await blockchain.getGasOptions(gas, 1.2)
          const tx = await contract.cancelExpiredLocks(
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
}
