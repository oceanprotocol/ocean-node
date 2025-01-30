import { Blockchain, getDatatokenDecimals } from '../../../utils/blockchain.js'
import { ethers, parseUnits, BigNumberish } from 'ethers'
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' assert { type: 'json' }
// import { EscrowAuthorization, EscrowLock } from '../../../@types/Escrow.js'
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

  // eslint-disable-next-line require-await
  async getContract(
    chainId: number,
    signer: ethers.Signer
  ): Promise<ethers.Contract | null> {
    const address = await this.getEscrowContractAddressForChain(chainId)
    if (!address) return null
    return new ethers.Contract(address, EscrowJson.abi, signer)
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
    const wei = this.getPaymentAmountInWei(amount, chain, token)
    if (!contract) return null
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
    const wei = this.getPaymentAmountInWei(amount, chain, token)
    if (!contract) return null
    try {
      const tx = await contract.claimLock(
        jobId,
        token,
        payer,
        wei,
        ethers.toUtf8Bytes(proof)
      )
      return tx.hash
    } catch (e) {
      return null
    }
  }

  async cancelExpiredLocks(
    chain: number,
    jobId: BigNumberish,
    token: BigNumberish,
    payer: string
  ): Promise<string | null> {
    const { rpc, network, chainId, fallbackRPCs } = this.networks[chain]
    const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
    const signer = blockchain.getSigner()
    const contract = await this.getContract(chainId, signer)
    if (!contract) return null
    try {
      const tx = await contract.cancelExpiredLocks(
        jobId,
        token,
        payer,
        await signer.getAddress()
      )
      return tx.hash
    } catch (e) {
      return null
    }
  }
}
