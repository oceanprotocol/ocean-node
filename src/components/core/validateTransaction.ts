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
  serviceIndex: number,
  serviceTimeout: number
): Promise<ValidateTransactionResponse> {
  console.log('Entering validateOrderTransaction', {
    txId,
    userAddress,
    provider,
    dataNftAddress,
    datatokenAddress,
    serviceIndex,
    serviceTimeout
  })

  const contractInterface = new Interface(ERC20Template.abi)

  // const provider = new JsonRpcProvider(rpc)
  console.log('Provider created', provider)

  let txReceipt = await provider.getTransactionReceipt(txId)
  console.log('Transaction receipt fetched', txReceipt)

  if (userAddress.toLowerCase() !== txReceipt.from.toLowerCase()) {
    console.log('User address does not match the sender of the transaction')
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
  console.log('OrderReused event', orderReusedEvent)

  if (orderReusedEvent && orderReusedEvent?.length > 0) {
    const reusedTxId = orderReusedEvent[0].args[0]
    console.log('Fetching transaction receipt for reusedTxId', reusedTxId)
    txReceipt = await provider.getTransactionReceipt(reusedTxId)
    console.log('Reused transaction receipt', txReceipt)
  }

  const OrderStartedEvent = fetchEventFromTransaction(
    txReceipt,
    'OrderStarted',
    contractInterface
  )
  console.log('OrderStarted event', OrderStartedEvent)

  const eventServiceIndex = OrderStartedEvent[0].args[3]
  console.log('Event service index', eventServiceIndex)

  if (BigInt(serviceIndex) !== eventServiceIndex) {
    console.log('Invalid service index')
    return {
      isValid: false,
      message: 'Invalid service index.'
    }
  }

  const ERC721Contract = new Contract(dataNftAddress, ERC721Template.abi, provider)
  console.log('ERC721 contract created', ERC721Contract)

  const isDatatokenDeployed = await ERC721Contract.isDeployed(datatokenAddress)
  console.log('Datatoken deployment status', isDatatokenDeployed)

  if (!isDatatokenDeployed) {
    console.log('Datatoken was not deployed by this DataNFT')
    return {
      isValid: false,
      message: 'Datatoken was not deployed by this DataNFT.'
    }
  }

  const eventTimestamp = (await provider.getBlock(txReceipt.blockHash)).timestamp
  console.log('Event timestamp', eventTimestamp)

  const currentTimestamp = Math.floor(Date.now() / 1000)
  console.log('Current timestamp', currentTimestamp)

  const timeElapsed = currentTimestamp - eventTimestamp
  console.log('Time elapsed', timeElapsed)

  if (serviceTimeout !== 0 && timeElapsed > serviceTimeout) {
    console.log('The order has expired')
    return {
      isValid: false,
      message: 'The order has expired.'
    }
  }

  console.log('Transaction is valid')
  return {
    isValid: true,
    message: 'Transaction is valid.'
  }
}
