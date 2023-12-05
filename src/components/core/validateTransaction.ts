import { Provider, Contract, Interface } from 'ethers'
import { getEventFromTx, fetchEventFromTransaction } from '../../utils/util.js'
import { OrderStartedEvent, OrderReusedEvent } from '../../@types/contracts.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }

interface ValidateTransactionResponse {
  isValid: boolean
  message: string
}

export async function validateOrderTransaction(
  txId: string,
  userAddress: string,
  provider: Provider,
  dataNftAddress: string,
  datatokenAddress: string,
  serviceIndex: number
): Promise<ValidateTransactionResponse> {
  const datatokenContract = new Contract(datatokenAddress, ERC20Template.abi, provider)
  const contractInterface = new Interface(ERC20Template.abi)
  console.log(
    'validateOrderTransaction',
    txId,
    userAddress,
    dataNftAddress,
    datatokenAddress
  )
  // 1. Fetch the transaction receipt and parse for OrderStarted and OrderReused events
  let txReceipt = await provider.getTransactionReceipt(txId)
  console.log('txReceipt', txReceipt)

  // 2. Validate user address
  if (userAddress.toLowerCase() !== txReceipt.from.toLowerCase()) {
    throw new Error('User address does not match the sender of the transaction.')
  }

  // 3. Fetch the event logs
  // Check for OrderReused events
  const orderReusedEvent = fetchEventFromTransaction(
    txReceipt,
    'OrderReused',
    contractInterface
  )
  console.log('orderReusedEvent', orderReusedEvent)

  // If OrderReused event found, fetch the associated OrderStarted transaction
  if (orderReusedEvent && orderReusedEvent?.length > 0) {
    const reusedTxId = orderReusedEvent[0].args[0]
    console.log('reusedTxId', reusedTxId)
    txReceipt = await provider.getTransactionReceipt(reusedTxId)
  }

  // Filter logs for "OrderStarted" event
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

  // Check if the datatoken is deployed using ERC721 contract
  const ERC721Contract = new Contract(dataNftAddress, ERC721Template.abi, provider)

  const isDatatokenDeployed = await ERC721Contract.isDeployed(datatokenAddress)

  if (!isDatatokenDeployed) {
    return {
      isValid: false,
      message: 'Datatoken was not deployed by this DataNFT.'
    }
  }

  return {
    isValid: true,
    message: 'Transaction is valid.'
  }
}
