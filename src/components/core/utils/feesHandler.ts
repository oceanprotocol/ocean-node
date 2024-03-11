import type { ComputeEnvironment } from '../../../@types/C2D.js'
import {
  JsonRpcApiProvider,
  ethers,
  Contract,
  Interface,
  BigNumberish,
  parseUnits,
  ZeroAddress
} from 'ethers'
import { FeeTokens, ProviderFeeData, ProviderFeeValidation } from '../../../@types/Fees'
import { DDO } from '../../../@types/DDO/DDO'
import { Service } from '../../../@types/DDO/Service'

import { verifyMessage, getJsonRpcProvider } from '../../../utils/blockchain.js'
import { getConfiguration } from '../../../utils/config.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

import { getOceanArtifactsAdresses } from '../../../utils/address.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { fetchEventFromTransaction } from '../../../utils/util.js'
import { fetchTransactionReceipt } from './validateOrders.js'

async function calculateProviderFeeAmount(
  validUntil: number,
  computeEnv: ComputeEnvironment
  // asset?: DDO
): Promise<number> {
  const now = new Date().getTime() / 1000
  const seconds = validUntil - now
  let providerFeeAmount: number
  // we have different ways of computing providerFee
  if (computeEnv) {
    // it's a compute provider fee
    providerFeeAmount = (seconds * parseFloat(String(computeEnv.priceMin))) / 60
  } else {
    // it's a download provider fee
    // we should get asset file size, and do a proper fee managment according to time
    // something like estimated 3 downloads per day
    providerFeeAmount = (await getConfiguration()).feeStrategy.feeAmount.amount
  }
  return providerFeeAmount
}

export async function createProviderFee(
  asset: DDO,
  service: Service,
  validUntil: number,
  computeEnv: ComputeEnvironment,
  computeValidUntil: number
): Promise<ProviderFeeData> | undefined {
  // round for safety
  validUntil = Math.round(validUntil)
  computeValidUntil = Math.round(computeValidUntil)
  const providerData = {
    environment: computeEnv ? computeEnv.id : null,
    timestamp: computeValidUntil || 0,
    dt: service.datatokenAddress,
    id: service.id
  }
  const providerWallet = await getProviderWallet(String(asset.chainId))

  const providerFeeAddress: string = providerWallet.address
  let providerFeeAmount: number
  let providerFeeAmountFormatted: BigNumberish

  let providerFeeToken: string
  if (computeEnv) {
    providerFeeToken = computeEnv.feeToken
  } else {
    // it's download, take it from config
    providerFeeToken = await getProviderFeeToken(asset.chainId)
  }
  if (providerFeeToken === ZeroAddress) {
    providerFeeAmount = 0
  } else {
    providerFeeAmount = await calculateProviderFeeAmount(validUntil, computeEnv)
  }

  if (providerFeeToken && providerFeeToken !== ZeroAddress) {
    const provider = await getJsonRpcProvider(asset.chainId)

    const datatokenContract = new Contract(
      providerFeeToken,
      ERC20Template.abi,
      await provider.getSigner()
    )

    let decimals = 18
    try {
      decimals = await datatokenContract.decimals()
    } catch (e) {
      console.error(e)
    }

    providerFeeAmountFormatted = parseUnits(providerFeeAmount.toString(10), decimals)
  } else {
    providerFeeAmountFormatted = BigInt(0)
  }
  const messageHash = ethers.solidityPackedKeccak256(
    ['bytes', 'address', 'address', 'uint256', 'uint256'],
    [
      ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(providerData))),
      ethers.getAddress(providerFeeAddress),
      ethers.getAddress(providerFeeToken),
      providerFeeAmountFormatted,
      validUntil
    ]
  )

  const signed32Bytes = await providerWallet.signMessage(
    new Uint8Array(ethers.toBeArray(messageHash))
  ) // it already does the prefix = "\x19Ethereum Signed Message:\n32"
  // OR just ethCrypto.sign(pk, signable_hash)

  // *** NOTE: provider.py ***
  // signed = keys.ecdsa_sign(message_hash=signable_hash, private_key=pk)

  // For Solidity, we need the expanded-format of a signature
  const signatureSplitted = ethers.Signature.from(signed32Bytes)

  // # make it compatible with last openzepellin https://github.com/OpenZeppelin/openzeppelin-contracts/pull/1622
  const v = signatureSplitted.v <= 1 ? signatureSplitted.v + 27 : signatureSplitted.v
  const r = ethers.hexlify(signatureSplitted.r) // 32 bytes
  const s = ethers.hexlify(signatureSplitted.s)

  const providerFee: ProviderFeeData = {
    providerFeeAddress: ethers.getAddress(providerFeeAddress),
    providerFeeToken: ethers.getAddress(providerFeeToken),
    providerFeeAmount: providerFeeAmountFormatted,
    providerData: ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(providerData))),
    v,
    r, // 32 bytes => get it back: Buffer.from(providerFee.r).toString('hex'))
    s, // 32 bytes
    validUntil
  }
  return JSON.parse(
    JSON.stringify(
      providerFee,
      (key, value) => (typeof value === 'bigint' ? value.toString() : value) // return everything else unchanged
    )
  )
}
export async function verifyProviderFees(
  txId: string,
  userAddress: string,
  provider: JsonRpcApiProvider,
  service: Service,
  computeEnv?: string,
  validUntil?: number // only for computeEnv
): Promise<ProviderFeeValidation> {
  let errorMsg = null
  if (!txId) errorMsg = 'Invalid txId'
  const { chainId } = await provider.getNetwork()
  const providerWallet = await getProviderWallet(String(chainId))
  const contractInterface = new Interface(ERC20Template.abi)
  const txReceiptMined = await fetchTransactionReceipt(txId, provider)
  if (!txReceiptMined) {
    errorMsg = `Tx receipt cannot be processed, because tx id ${txId} was not mined.`
  }

  // const eventTimestamp = (await provider.getBlock(txReceiptMined.blockHash)).timestamp
  const now = Math.round(new Date().getTime() / 1000)
  const ProviderFeesEvent = fetchEventFromTransaction(
    txReceiptMined,
    'ProviderFee',
    contractInterface
  )
  // check provider address
  if (
    ProviderFeesEvent[0].args[0].toLowerCase() !== providerWallet.address.toLowerCase()
  ) {
    errorMsg = 'Provider address does not match'
  }
  const validUntilContract = parseInt(ProviderFeesEvent[0].args[7].toString())
  if (now >= validUntilContract && validUntilContract !== 0) {
    errorMsg = 'Provider fees expired.'
  }
  // check serviceId and datatokenAddress
  const utf = ethers.toUtf8String(ProviderFeesEvent[0].args[3])
  let providerData
  try {
    providerData = JSON.parse(utf)
  } catch (e) {
    console.error(e)
    // providerData was empty??
    providerData = {
      environment: null,
      timestamp: 0,
      dt: null,
      id: null
    }
  }
  if (providerData.id !== service.id) {
    errorMsg = 'ProviderFee service.id does not match with provided service id'
  }
  if (providerData.dt.toLowerCase() !== service.datatokenAddress.toLowerCase()) {
    errorMsg =
      'ProviderFee datatoken address does not match with service datatoken address'
  }
  const retMsg = {
    isValid: true,
    isComputeValid: false,
    message: '',
    validUntil: 0
  }
  if (computeEnv) {
    retMsg.isComputeValid = true
    if (providerData.environment !== computeEnv) {
      errorMsg =
        'ProviderFee computeEnv(' +
        providerData.environment +
        ') does not match with requested provider computeEnv(' +
        computeEnv +
        ')'
      retMsg.isComputeValid = false
    }
    if (validUntil > 0) {
      if (providerData.timestamp < validUntil) {
        errorMsg =
          'ProviderFee compute validity(' +
          providerData.timestamp +
          ') lower than needed ' +
          validUntil
        retMsg.isComputeValid = false
      }
    } else {
      retMsg.validUntil = providerData.timestamp
    }
  }
  if (errorMsg) {
    CORE_LOGGER.logMessage(errorMsg)
    retMsg.message = errorMsg
  }
  return retMsg
}

// TO DO - delete functions below, as they are used in the tests
// new provider create & verify  -> see above :)

// equiv to get_provider_fees
// *** NOTE: provider.py => get_provider_fees ***
export async function createFee(
  asset: DDO,
  validUntil: number,
  computeEnv: string,
  service: Service
  // provider: OceanProvider // this node provider
): Promise<ProviderFeeData> | undefined {
  // create providerData struct
  const providerData = {
    environment: computeEnv, //  null for us now
    timestamp: Date.now(),
    dt: service.datatokenAddress,
    id: service.id
  }

  // *** NOTE: provider.py ***
  // provider_data =  {
  //   "environment": compute_env,  //  null for us now
  //   "timestamp": datetime.now(timezone.utc).timestamp(),
  //   "dt": service.datatoken_address,
  //   "id": service.id,
  // }
  const providerWallet = await getProviderWallet(String(asset.chainId))
  const providerFeeAddress: string = providerWallet.address

  // from env FEE_TOKENS
  const providerFeeToken: string = await getProviderFeeToken(asset.chainId)

  // from env FEE_AMOUNT
  const providerFeeAmount: number = await getProviderFeeAmount() // TODO check decimals on contract?

  /** https://github.com/ethers-io/ethers.js/issues/468
 * 
 * Also, keep in mind that signMessage can take in a string, 
 * which is treated as a UTF-8 string, or an ArrayLike, which is treated like binary data. 
 * A hash as a string is a 66 character string, which is likely not what you want, 
 * you probable want the 32 byte array. So you probably want something more like:
 * 
   * // 66 byte string, which represents 32 bytes of data
  let messageHash = ethers.utils.solidityKeccak256( ...stuff here... );

  // 32 bytes of data in Uint8Array
  let messageHashBinary = ethers.utils.arrayify(messageHash);

  // To sign the 32 bytes of data, make sure you pass in the data
  let signature = await wallet.signMessage(messageHashBinary);
   */

  const messageHash = ethers.solidityPackedKeccak256(
    ['bytes', 'address', 'address', 'uint256', 'uint256'],
    [
      ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(providerData))),
      ethers.getAddress(providerFeeAddress),
      ethers.getAddress(providerFeeToken),
      providerFeeAmount,
      validUntil
    ]
  )

  // *** NOTE: provider.py ***
  // message_hash = Web3.solidityKeccak(
  //   ["bytes", "address", "address", "uint256", "uint256"],
  //   [
  //       Web3.toHex(Web3.toBytes(text=provider_data)),
  //       Web3.toChecksumAddress(provider_fee_address),
  //       Web3.toChecksumAddress(provider_fee_token),
  //       provider_fee_amount,
  //       valid_until,
  //   ],
  // )

  // console.log('messageHash: ' + messageHash)
  // 66 byte string, which represents 32 bytes of data
  // ethers.toUtf8Bytes(messageHash).length) // 66 byte string

  // 32 bytes of data in Uint8Array
  // console.log(
  //   'messageHash bytes length Uint8Array: ',
  //   ethers.toBeArray(messageHash).length
  // )

  // const signableHash = ethers.solidityPackedKeccak256(
  //   ['bytes'],
  //   [ethers.toUtf8Bytes(messageHash)]

  //   // OR ethers.utils.hashMessage(ethers.utils.concat([ hash, string, address ])
  //   // https://github.com/ethers-io/ethers.js/issues/468
  // )

  // *** NOTE: provider.py ***
  // pk = keys.PrivateKey(provider_wallet.key)
  //   prefix = "\x19Ethereum Signed Message:\n32"
  //   signable_hash = Web3.solidityKeccak(
  //       ["bytes", "bytes"], [Web3.toBytes(text=prefix), Web3.toBytes(message_hash)]
  //   )

  // Sign the string message
  // const signed32Bytes = await providerWallet.signMessage(ethers.toBeArray(signableHash)) // it already does the prefix = "\x19Ethereum Signed Message:\n32"
  // const signed32Bytes = await providerWallet.signMessage(ethers.hexlify(signableHash)) // it already does the prefix = "\x19Ethereum Signed Message:\n32"
  const signed32Bytes = await providerWallet.signMessage(
    new Uint8Array(ethers.toBeArray(messageHash))
  ) // it already does the prefix = "\x19Ethereum Signed Message:\n32"
  // OR just ethCrypto.sign(pk, signable_hash)

  // *** NOTE: provider.py ***
  // signed = keys.ecdsa_sign(message_hash=signable_hash, private_key=pk)

  // For Solidity, we need the expanded-format of a signature
  const signatureSplitted = ethers.Signature.from(signed32Bytes)
  // console.log(
  //   'verify message:',
  //   await verifyMessage(
  //     ethers.toBeArray(signableHash), // 32 bytes again
  //     providerWallet.address,
  //     signed32Bytes
  //   )
  // )

  // # make it compatible with last openzepellin https://github.com/OpenZeppelin/openzeppelin-contracts/pull/1622
  const v = signatureSplitted.v <= 1 ? signatureSplitted.v + 27 : signatureSplitted.v
  const r = ethers.hexlify(signatureSplitted.r) // 32 bytes
  const s = ethers.hexlify(signatureSplitted.s)
  // ethers.hexlify(ethers.toUtf8Bytes(signatureSplitted.s))

  // length 66
  // ethers.toUtf8Bytes(r).length
  // length 32
  // ethers.toBeArray(r).length

  const providerFee: ProviderFeeData = {
    providerFeeAddress: ethers.getAddress(providerFeeAddress),
    providerFeeToken: ethers.getAddress(providerFeeToken),
    providerFeeAmount,
    providerData: ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(providerData))),
    v,
    r, // 32 bytes => get it back: Buffer.from(providerFee.r).toString('hex'))
    s, // 32 bytes
    validUntil
  }

  // *** NOTE: provider.py ***
  // provider_fee = {
  //   "providerFeeAddress": provider_fee_address,
  //   "providerFeeToken": provider_fee_token,
  //   "providerFeeAmount": provider_fee_amount,
  //   "providerData": Web3.toHex(Web3.toBytes(text=provider_data)),
  //   # make it compatible with last openzepellin https://github.com/OpenZeppelin/openzeppelin-contracts/pull/1622
  //   "v": (signed.v + 27) if signed.v <= 1 else signed.v,
  //   "r": Web3.toHex(Web3.toBytes(signed.r).rjust(32, b"\0")),
  //   "s": Web3.toHex(Web3.toBytes(signed.s).rjust(32, b"\0")),
  //   "validUntil": valid_until,
  // }

  return providerFee

  // Example output: {
  // providerFeeAddress: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260',
  // providerFeeToken: '0xd8992Ed72C445c35Cb4A2be468568Ed1079357c8',
  // providerFeeAmount: 1,
  // providerData: '0x7b22656e7669726f6e6d656e74223a226e756c6c222c2274696d657374616d70223a313730313239363037303034352c226474223a22307864333166373464314435613833623839364164373436643936663738666436354230613636454266222c226964223a2231227d',
  // v: 28,
  // r: Uint8Array(32) [
  //    44, 122, 175, 12, 207, 253, 204, 162,
  //   244,  36, 184, 29, 204,  27,  51,  43,
  //    99, 245, 151, 28, 115,  46, 232, 250,
  //    47,  77,  48, 84, 148,   8, 129,  91
  // ],
  // s: Uint8Array(32) [
  //    50,  84,  82, 246,  84, 106,  73, 180,
  //   118, 160, 230,   0, 229, 175, 234,  42,
  //   222, 160, 107, 140, 141, 110,  89, 221,
  //    27, 162, 190, 146, 142,  84, 145, 244
  // ]
  // validUntil: 0
  // }
}

export async function checkFee(
  txId: string,
  providerFeesData: ProviderFeeData
  // message: string | Uint8Array // the message that was signed (fee structure) ?
): Promise<boolean> {
  // checkFee function: given a txID, checks:
  // the address that signed the fee signature = ocean-node address
  // Do not check if amount, tokens, etc are a match, because it can be an old order and config was changed in the meantime

  const wallet = await getProviderWallet()
  const nodeAddress = wallet.address

  // first check if these are a match
  if (nodeAddress !== providerFeesData.providerFeeAddress) {
    return false
  }

  const providerDataAsArray = ethers.toBeArray(providerFeesData.providerData)
  const providerDataStr = Buffer.from(providerDataAsArray).toString('utf8')
  const providerData = JSON.parse(providerDataStr)

  // done previously as ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(providerData))),
  // check signature stuff now

  const messageHash = ethers.solidityPackedKeccak256(
    ['bytes', 'address', 'address', 'uint256', 'uint256'],
    [
      ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(providerData))),
      ethers.getAddress(providerFeesData.providerFeeAddress), // signer address
      ethers.getAddress(providerFeesData.providerFeeToken), // TODO check decimals on contract?
      providerFeesData.providerFeeAmount,
      providerFeesData.validUntil
    ]
  )

  const signableHash = ethers.solidityPackedKeccak256(
    ['bytes'],
    [ethers.toUtf8Bytes(messageHash)]
  )

  const message = ethers.toBeArray(signableHash) // await wallet.signMessage()

  // and also check that we signed this message
  return await verifyMessage(message, nodeAddress, txId)
  // before was only return await verifyMessage(message, nodeAddress, txId)
}

// These core functions are provider related functions, maybe they will be on Provider
// this might be different between chains
/**
 * Get the provider wallet
 * @param chainId the chain id (not used now)
 * @returns the wallet
 */
export async function getProviderWallet(chainId?: string): Promise<ethers.Wallet> {
  const wallet: ethers.Wallet = new ethers.Wallet(
    Buffer.from((await getConfiguration()).keys.privateKey).toString('hex')
  )
  return wallet
}
export async function getProviderWalletAddress(): Promise<string> {
  return (await getProviderWallet()).address
}

export async function getProviderKey(): Promise<string> {
  return Buffer.from((await getConfiguration()).keys.privateKey).toString('hex')
}

/**
 * Get the fee token
 * @param chainId the chain id
 * @returns the token address
 */
export async function getProviderFeeToken(chainId: number): Promise<string> {
  const result = (await getConfiguration()).feeStrategy.feeTokens.filter(
    (token: FeeTokens) => Number(token.chain) === chainId
  )
  if (result.length === 0 && chainId === 8996) {
    const localOceanToken = getOceanArtifactsAdresses().development.Ocean
    return localOceanToken || ethers.ZeroAddress
  }
  return result.length ? result[0].token : ethers.ZeroAddress
}

/**
 * get the fee amount (in MB or other units)
 * @returns amount
 */
export async function getProviderFeeAmount(): Promise<number> {
  return (await getConfiguration()).feeStrategy.feeAmount.amount
}
// https://github.com/oceanprotocol/contracts/blob/main/contracts/templates/ERC20Template.sol#L65-L74
// https://github.com/oceanprotocol/contracts/blob/main/contracts/templates/ERC20Template.sol#L447-L508
// https://github.com/oceanprotocol/contracts/blob/main/contracts/templates/ERC20Template.sol#L522
// https://github.com/oceanprotocol/contracts/blob/main/contracts/templates/ERC20Template.sol#L589-L608
