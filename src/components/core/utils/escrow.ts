import { Blockchain, getDatatokenDecimals } from '../../../utils/blockchain.js'
import { ethers, parseUnits, formatUnits, BigNumberish } from 'ethers'
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' assert { type: 'json' }
import { EscrowAuthorization, EscrowLock } from '../../../@types/Escrow.js'
import { getOceanArtifactsAdressesByChainId } from '../../../utils/address.js'
import { RPCS } from '../../../@types/blockchain.js'

export class Escrow {
  private networks: RPCS
  private claimDurationTimeout: number
  constructor(supportedNetworks: RPCS, claimDurationTimeout: number) {
    this.networks = supportedNetworks
    this.claimDurationTimeout = claimDurationTimeout
  }

  // eslint-disable-next-line require-await
  async getEscrowContractAddressForChain(chainId: number): Promise<string | null> {
    const addresses = getOceanArtifactsAdressesByChainId(chainId)
    if (addresses && addresses.Escrow) return addresses.Escrow
    return null
  }

  getMinLockTime(maxJobDuration: number) {
    return maxJobDuration + this.claimDurationTimeout
  }

  async getPaymentAmountInWei(cost: number, chain: number, token: string) {
    const { rpc, network, chainId, fallbackRPCs } = this.networks[chain]
    const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
    const provider = blockchain.getProvider()
    const decimals = await getDatatokenDecimals(token, provider)
    return parseUnits(cost.toString(10), decimals).toString()
  }

  async getNumberFromWei(wei: string, chain: number, token: string) {
    const { rpc, network, chainId, fallbackRPCs } = this.networks[chain]
    const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
    const provider = blockchain.getProvider()
    const decimals = await getDatatokenDecimals(token, provider)
    return parseFloat(formatUnits(wei, decimals))
  }

  // eslint-disable-next-line require-await
  async getContract(
    chainId: number,
    signer: ethers.Signer
  ): Promise<ethers.Contract | null> {
    const address = await this.getEscrowContractAddressForChain(chainId)
    if (!address) return null
    return new ethers.Contract(address, EscrowJson.abi, signer)
  }

  async getUserAvailableFunds(
    chain: number,
    payer: string,
    token: string
  ): Promise<BigNumberish> {
    const { rpc, network, chainId, fallbackRPCs } = this.networks[chain]
    const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
    const signer = blockchain.getSigner()
    const contract = await this.getContract(chainId, signer)
    try {
      const funds = await contract.getUserFunds(payer, token)
      return funds.available
    } catch (e) {
      return null
    }
  }

  async getLocks(
    chain: number,
    token: string,
    payer: string,
    payee: string
  ): Promise<EscrowLock[]> {
    const { rpc, network, chainId, fallbackRPCs } = this.networks[chain]
    const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
    const signer = blockchain.getSigner()
    const contract = await this.getContract(chainId, signer)
    try {
      return await contract.getLocks(token, payer, payee)
    } catch (e) {
      return null
    }
  }

  async getAuthorizations(
    chain: number,
    token: string,
    payer: string,
    payee: string
  ): Promise<EscrowAuthorization[]> {
    const { rpc, network, chainId, fallbackRPCs } = this.networks[chain]
    const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
    const signer = blockchain.getSigner()
    const contract = await this.getContract(chainId, signer)
    try {
      return await contract.getAuthorizations(token, payer, payee)
    } catch (e) {
      return null
    }
  }

  async createLock(
    chain: number,
    jobId: BigNumberish,
    token: string,
    payer: string,
    amount: number,
    expiry: BigNumberish
  ): Promise<string | null> {
    const { rpc, network, chainId, fallbackRPCs } = this.networks[chain]
    const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
    const signer = blockchain.getSigner()
    const contract = await this.getContract(chainId, signer)
    if (!contract) throw new Error(`Failed to initialize escrow contract`)
    const wei = await this.getPaymentAmountInWei(amount, chain, token)
    const userBalance = await this.getUserAvailableFunds(chain, payer, token)
    if (BigInt(userBalance) < BigInt(wei)) {
      // not enough funds
      throw new Error(`User ${payer} does not have enough funds`)
    }

    const auths = await this.getAuthorizations(
      chain,
      token,
      payer,
      await signer.getAddress()
    )
    if (!auths || auths.length !== 1) {
      throw new Error(`No escrow auths found`)
    }
    if (
      BigInt(auths[0].currentLockedAmount) + BigInt(amount) >
      BigInt(auths[0].maxLockedAmount)
    ) {
      throw new Error(`No valid escrow auths found(will go over limit)`)
    }
    if (BigInt(auths[0].maxLockSeconds) < BigInt(expiry)) {
      throw new Error(`No valid escrow auths found(maxLockSeconds too low)`)
    }
    if (BigInt(auths[0].currentLocks) + BigInt(1) > BigInt(auths[0].maxLockCounts)) {
      throw new Error(`No valid escrow auths found(too many active locks)`)
    }
    try {
      const tx = await contract.createLock(jobId, token, payer, wei, expiry)
      return tx.hash
    } catch (e) {
      return null
    }
  }

  async claimLock(
    chain: number,
    jobId: BigNumberish,
    token: string,
    payer: string,
    amount: number,
    proof: string
  ): Promise<string | null> {
    const { rpc, network, chainId, fallbackRPCs } = this.networks[chain]
    const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
    const signer = blockchain.getSigner()
    const contract = await this.getContract(chainId, signer)
    const wei = await this.getPaymentAmountInWei(amount, chain, token)
    if (!contract) return null
    try {
      const locks = await this.getLocks(chain, token, payer, await signer.getAddress())
      for (const lock of locks) {
        if (BigInt(lock.jobId) === BigInt(jobId)) {
          const tx = await contract.claimLock(
            jobId,
            token,
            payer,
            wei,
            ethers.toUtf8Bytes(proof)
          )
          return tx.hash
        }
      }
      return null
    } catch (e) {
      return null
    }
  }

  async cancelExpiredLocks(
    chain: number,
    jobId: BigNumberish,
    token: string,
    payer: string
  ): Promise<string | null> {
    const { rpc, network, chainId, fallbackRPCs } = this.networks[chain]
    const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
    const signer = blockchain.getSigner()
    const contract = await this.getContract(chainId, signer)
    if (!contract) return null
    try {
      const locks = await this.getLocks(chain, token, payer, await signer.getAddress())
      for (const lock of locks) {
        if (BigInt(lock.jobId) === BigInt(jobId)) {
          const tx = await contract.cancelExpiredLocks(
            jobId,
            token,
            payer,
            await signer.getAddress()
          )

          return tx.hash
        }
      }
      return null
    } catch (e) {
      return null
    }
  }
}
