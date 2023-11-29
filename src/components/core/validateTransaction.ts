import { Blockchain } from '../../utils/blockchain.js'
import { parseEventLogs } from '../../utils/events.js'
import { OrderStartedEvent, OrderReusedEvent } from '../../@types/contracts.js'
import IERC20Template from '@oceanprotocol/contracts/artifacts/contracts/interfaces/IERC20Template.sol/IERC20Template.json'
import { Interface } from '@ethersproject/abi'

interface ValidateTransactionResponse {
  isValid: boolean
  message: string
}

export async function validateOrderTransaction(
  txId: string,
  userAddress: string,
  blockchain: Blockchain
): Promise<ValidateTransactionResponse> {
  // Use the provider from the Blockchain class
  const provider = blockchain.getProvider()

  // 1. Fetch the transaction receipt and parse for OrderStarted and OrderReused events
  let txReceipt = await provider.getTransactionReceipt(txId)

  // 2. Validate user address
  if (userAddress.toLowerCase() !== txReceipt.from.toLowerCase()) {
    throw new Error('User address does not match the sender of the transaction.')
  }

  // 3. Fetch the event logs
  const contractInterface = new Interface(IERC20Template.abi)
  // Check for OrderReused events
  const orderReusedLogs = parseEventLogs<OrderReusedEvent>(
    txReceipt.logs,
    'OrderReused',
    contractInterface
  )

  // If OrderReused event found, fetch the associated OrderStarted transaction
  if (orderReusedLogs.length > 0) {
    const reusedTxId = orderReusedLogs[0].orderTxId
    txReceipt = await provider.getTransactionReceipt(reusedTxId)
  }

  // Now get OrderStarted event logs
  const orderStartedLogs = parseEventLogs<OrderStartedEvent>(
    txReceipt.logs,
    'OrderStarted',
    contractInterface
  )

  // 3. Validate other conditions...

  return {
    isValid: true,
    message: 'Transaction is valid.'
  }
}
