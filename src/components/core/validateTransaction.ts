import { JsonRpcProvider, Contract, Interface } from 'ethers'
import { fetchEventFromTransaction } from '../../utils/util.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }

console.log('Imports loaded')

interface ValidateTransactionResponse {
  isValid: boolean
  message: string
}

export async function validateOrderTransaction(
  txId: string,
  userAddress: string,
  provider: JsonRpcProvider,
  dataNftAddress: string,
  datatokenAddress: string,
  serviceIndex: string,
  serviceTimeout: number
): Promise<ValidateTransactionResponse> {
  const contractInterface = new Interface(ERC20Template.abi)

  let txReceipt = await provider.getTransactionReceipt(txId)

  if (userAddress.toLowerCase() !== txReceipt.from.toLowerCase()) {
    return {
      isValid: false,
      message: 'User address does not match the sender of the transaction.'
    }
  }

  const orderReusedEvent = fetchEventFromTransaction(
    txReceipt,
    'OrderReused',
    contractInterface
  )

  if (orderReusedEvent && orderReusedEvent?.length > 0) {
    const reusedTxId = orderReusedEvent[0].args[0]
    txReceipt = await provider.getTransactionReceipt(reusedTxId)
  }

  const OrderStartedEvent = fetchEventFromTransaction(
    txReceipt,
    'OrderStarted',
    contractInterface
  )

  const eventServiceIndex = OrderStartedEvent[0].args[3]

  if (BigInt(serviceIndex) !== eventServiceIndex) {
    return {
      isValid: false,
      message: 'Invalid service index.'
    }
  }

  const ERC721Contract = new Contract(dataNftAddress, ERC721Template.abi, provider)

  const isDatatokenDeployed = await ERC721Contract.isDeployed(datatokenAddress)

  if (!isDatatokenDeployed) {
    return {
      isValid: false,
      message: 'Datatoken was not deployed by this DataNFT.'
    }
  }

  const eventTimestamp = (await provider.getBlock(txReceipt.blockHash)).timestamp

  const currentTimestamp = Math.floor(Date.now() / 1000)

  const timeElapsed = currentTimestamp - eventTimestamp

  if (serviceTimeout !== 0 && timeElapsed > serviceTimeout) {
    return {
      isValid: false,
      message: 'The order has expired.'
    }
  }

  return {
    isValid: true,
    message: 'Transaction is valid.'
  }
}
