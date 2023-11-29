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
  const txReceipt = await provider.getTransactionReceipt(txId)

  const contractInterface = new Interface(IERC20Template.abi)
  const orderStartedLogs = parseEventLogs<OrderStartedEvent>(
    txReceipt.logs,
    'OrderStarted',
    contractInterface
  )
  const orderReusedLogs = parseEventLogs<OrderReusedEvent>(
    txReceipt.logs,
    'OrderReused',
    contractInterface
  )

  // 2. Validate user address
  if (userAddress.toLowerCase() !== txReceipt.from.toLowerCase()) {
    throw new Error('User address does not match the sender of the transaction.')
  }

  // 3. Validate other conditions...

  // After all checks pass
  return true

  return {
    isValid: true,
    message: 'Transaction is valid.'
  }
}
