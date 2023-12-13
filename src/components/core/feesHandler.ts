import { ethers } from 'ethers'
import { FeeTokens, ProviderFeeData } from '../../@types/Fees'
import { Command, ICommandHandler, GetFeesCommand } from '../../utils/constants.js'
import { DDO } from '../../@types/DDO/DDO'
import { Service } from '../../@types/DDO/Service'
import { AssetUtils } from '../../utils/asset.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../@types'
import { OceanP2P } from '../P2P/index'
import { Readable } from 'stream'
import {
  CustomNodeLogger,
  GENERIC_EMOJIS,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { verifyMessage } from '../../utils/blockchain.js'
import { getConfig } from '../../utils/config.js'

let config: OceanNodeConfig
// Lazy load configuration
async function getConfiguration(): Promise<OceanNodeConfig> {
  if (!config) {
    config = await getConfig()
  }
  return config
}
// this should be actually part of provider, so lets put this as module name
const logger: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.PROVIDER,
  LOG_LEVELS_STR.LEVEL_INFO, // Info level
  [defaultConsoleTransport] // console only Transport
)
/**
 * We could turn other core Command handlers into something like this:
 */
export abstract class CommandHandler implements ICommandHandler {
  private p2pNode?: OceanP2P
  public constructor(node?: OceanP2P) {
    this.p2pNode = node || undefined
  }

  // handle directCommands
  abstract handleCommand(command: Command): Promise<P2PCommandResponse>
}
export class FeesHandler extends CommandHandler {
  async handleCommand(command: Command): Promise<P2PCommandResponse> {
    try {
      const task = command as GetFeesCommand
      logger.logMessage(
        `Try to calculate fees for DDO with id: ${task.ddo.id} and serviceId: ${task.serviceId}`,
        true
      )

      const fees = await calculateFee(task.ddo, task.serviceId)
      if (fees) {
        return {
          stream: Readable.from(JSON.stringify(fees, null, 4)),
          status: { httpStatus: 200 }
        }
      } else {
        const error = `Unable to calculate fees (null) for DDO with id: ${task.ddo.id} and serviceId: ${task.serviceId}`
        logger.logMessageWithEmoji(
          error,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error
          }
        }
      }
    } catch (error) {
      logger.logMessageWithEmoji(
        error.message,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
  }
}

// equiv to get_provider_fees
// *** NOTE: provider.py => get_provider_fees ***
export async function createFee(
  asset: DDO,
  validUntil: number,
  computeEnv: string,
  service: Service
  // provider: OceanProvider // this node provider
): Promise<ProviderFeeData> | undefined {
  console.log('createFee', createFee)
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

  const signableHash = ethers.solidityPackedKeccak256(
    ['bytes'],
    [ethers.toUtf8Bytes(messageHash)]

    // OR ethers.utils.hashMessage(ethers.utils.concat([ hash, string, address ])
    // https://github.com/ethers-io/ethers.js/issues/468
  )

  // *** NOTE: provider.py ***
  // pk = keys.PrivateKey(provider_wallet.key)
  //   prefix = "\x19Ethereum Signed Message:\n32"
  //   signable_hash = Web3.solidityKeccak(
  //       ["bytes", "bytes"], [Web3.toBytes(text=prefix), Web3.toBytes(message_hash)]
  //   )

  // Sign the string message
  const signed32Bytes = await providerWallet.signMessage(ethers.toBeArray(signableHash)) // it already does the prefix = "\x19Ethereum Signed Message:\n32"
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
  const r = ethers.toBeArray(signatureSplitted.r) // 32 bytes
  const s = ethers.toBeArray(signatureSplitted.s)
  // ethers.hexlify(ethers.toUtf8Bytes(signatureSplitted.s))

  // length 66
  // ethers.toUtf8Bytes(r).length
  // length 32
  // ethers.toBeArray(r).length

  const providerFee: ProviderFeeData = {
    providerFeeAddress,
    providerFeeToken,
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
  // amount, tokens, etc are a match

  const wallet = await getProviderWallet()
  const nodeAddress = wallet.address
  const feeAmount = await getProviderFeeAmount()

  // first check if these are a match
  if (
    nodeAddress !== providerFeesData.providerFeeAddress ||
    providerFeesData.providerFeeAmount !== feeAmount
  ) {
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

export async function calculateFee(
  ddo: DDO,
  serviceId: string
): Promise<ProviderFeeData | undefined> {
  console.log('calculateFee serviceId', serviceId)
  console.log('calculateFee ddo', ddo)
  const service: Service = AssetUtils.getServiceById(ddo, serviceId)
  if (!service) {
    console.log('No service for ddo', ddo)
    return undefined
  }
  // create fee structure
  const fee: ProviderFeeData | undefined = await createFee(ddo, 0, 'null', service)
  console.log('calculateFee fee', fee)
  // - this will use fileInfo command to get the length of the file
  // - will analyze the DDO and get validity, so we can know who many times/until then user can download this asset
  // - compute required cost using FEE_AMOUNT and FEE_TOKENS
  return fee
}

/**
 * Core function to get the fees structure
 * @param task the command task (ddo, serviceId)
 * @returns fees structure
 */
export async function getFees(task: GetFeesCommand): Promise<P2PCommandResponse> {
  // Get the fees structure,
  const handler = new FeesHandler()
  return await handler.handleCommand(task)
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
