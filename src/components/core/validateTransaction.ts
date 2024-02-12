import { JsonRpcProvider, Contract, Interface, TransactionReceipt } from 'ethers'
import { fetchEventFromTransaction } from '../../utils/util.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { CORE_LOGGER } from '../../utils/logging/common.js'

interface ValidateTransactionResponse {
  isValid: boolean
  message: string
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchTransactionReceipt(
  txId: string,
  provider: JsonRpcProvider,
  retries: number = 3
): Promise<TransactionReceipt> {
  let txReceiptMined
  while (retries > 0) {
    try {
      const txReceipt = await provider.getTransactionReceipt(txId)
      if (txReceipt) {
        txReceiptMined = txReceipt
        return txReceiptMined
      } else {
        await delay(3000)
        retries--
      }
    } catch (error) {
      const errorMsg = `Error fetching transaction receipt: ${error}`
      CORE_LOGGER.logMessage(errorMsg)
      return null
    }
  }
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
  const contractInterface = new Interface(ERC20Template.abi)
  let txReceiptMined = await fetchTransactionReceipt(txId, provider)

  if (txReceiptMined) {
    const errorMsg = `Tx receipt cannot be processed, because tx id ${txId} was not mined.`
    CORE_LOGGER.logMessage(errorMsg)
    return {
      isValid: false,
      message: errorMsg
    }
  }
  CORE_LOGGER.logMessage(`tx receipt #1: ${txReceiptMined}`)

  if (userAddress.toLowerCase() !== txReceiptMined.from.toLowerCase()) {
    return {
      isValid: false,
      message: 'User address does not match the sender of the transaction.'
    }
  }

  const orderReusedEvent = fetchEventFromTransaction(
    txReceiptMined,
    'OrderReused',
    contractInterface
  )

  if (orderReusedEvent && orderReusedEvent?.length > 0) {
    const reusedTxId = orderReusedEvent[0].args[0]
    txReceiptMined = await fetchTransactionReceipt(reusedTxId, provider)
    if (txReceiptMined) {
      const errorMsg = `Tx receipt cannot be processed, because tx id ${txId} was not mined.`
      CORE_LOGGER.logMessage(errorMsg)
      return {
        isValid: false,
        message: errorMsg
      }
    }
    CORE_LOGGER.logMessage(`tx receipt #2: ${txReceiptMined}`)
  }

  const OrderStartedEvent = fetchEventFromTransaction(
    txReceiptMined,
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

  const eventTimestamp = (await provider.getBlock(txReceiptMined.blockHash)).timestamp

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
