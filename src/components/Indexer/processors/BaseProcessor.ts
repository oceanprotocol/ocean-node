import { VersionedDDO, DeprecatedDDO } from '@oceanprotocol/ddo-js'
import axios from 'axios'
import {
  ZeroAddress,
  Signer,
  ethers,
  Interface,
  toUtf8Bytes,
  hexlify,
  getBytes,
  toUtf8String,
  FallbackProvider
} from 'ethers'
import { Readable } from 'winston-transport'
import { DecryptDDOCommand, NonceCommand } from '../../../@types/commands.js'
import { OceanNode } from '../../../OceanNode.js'
import { EVENT_HASHES, PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { timestampToDateTime } from '../../../utils/conversions.js'
import { create256Hash } from '../../../utils/crypt.js'
import { getDatabase } from '../../../utils/database.js'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { URLUtils } from '../../../utils/url.js'
import { streamToString, streamToUint8Array } from '../../../utils/util.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' with { type: 'json' }
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' with { type: 'json' }
import { fetchTransactionReceipt } from '../../core/utils/validateOrders.js'
import { withRetrial } from '../utils.js'

export abstract class BaseEventProcessor {
  protected networkId: number

  constructor(chainId: number) {
    this.networkId = chainId
  }

  protected isValidDtAddressFromServices(services: any[]): boolean {
    for (const service of services) {
      if (
        service.datatokenAddress === '0x0' ||
        service.datatokenAddress === ZeroAddress
      ) {
        return false
      }
    }
    return true
  }

  protected async getTokenInfo(services: any[], signer: Signer): Promise<any[]> {
    const datatokens: any[] = []

    for (const service of services) {
      const datatoken = new ethers.Contract(
        service.datatokenAddress,
        ERC20Template.abi,
        signer
      )
      let name: string
      let symbol: string
      if (
        service.datatokenAddress === '0x0' ||
        service.datatokenAddress === ZeroAddress
      ) {
        name = `Datatoken${services.indexOf(service)}`
        symbol = `DT${services.indexOf(service)}`
      } else {
        name = await datatoken.name()
        INDEXER_LOGGER.logMessage(`name.datatoken: ${name}`)
        symbol = await datatoken.symbol()
        INDEXER_LOGGER.logMessage(`symbol.datatoken: ${symbol}`)
      }

      datatokens.push({
        address: service.datatokenAddress,
        name,
        symbol,
        serviceId: service.id
      })
    }

    return datatokens
  }

  protected async getEventData(
    provider: FallbackProvider,
    transactionHash: string,
    abi: any,
    eventType: string
  ): Promise<ethers.LogDescription> {
    const iface = new Interface(abi)
    let receipt: ethers.TransactionReceipt
    try {
      receipt = await fetchTransactionReceipt(transactionHash, provider)
    } catch (e) {
      INDEXER_LOGGER.error(`Error retrieving receipt: ${e.message}`)
    }
    if (receipt) {
      let eventHash: string
      for (const [key, value] of Object.entries(EVENT_HASHES)) {
        if (value.type === eventType) {
          eventHash = key
          break
        }
      }
      if (eventHash === '') {
        INDEXER_LOGGER.error(`Event hash couldn't be found!`)
        return null
      }

      let eventObj: any
      for (const log of receipt.logs) {
        if (log.topics[0] === eventHash) {
          eventObj = {
            topics: log.topics,
            data: log.data
          }
          break
        }
      }

      if (!eventObj) {
        INDEXER_LOGGER.error(
          `Event object couldn't be retrieved! Event hash not present in logs topics`
        )
        return null
      }

      return iface.parseLog(eventObj)
    } else {
      INDEXER_LOGGER.error('Receipt could not be fetched')
    }
  }

  protected async getNFTInfo(
    nftAddress: string,
    signer: Signer,
    owner: string,
    timestamp: number
  ): Promise<any> {
    const nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, signer)
    const state = parseInt((await nftContract.getMetaData())[2])
    const id = parseInt(await nftContract.getId())
    const tokenURI = await nftContract.tokenURI(id)
    return {
      state,
      address: nftAddress,
      name: await nftContract.name(),
      symbol: await nftContract.symbol(),
      owner,
      created: timestampToDateTime(timestamp),
      tokenURI
    }
  }

  protected async createOrUpdateDDO(ddo: VersionedDDO, method: string): Promise<any> {
    try {
      const { ddo: ddoDatabase, ddoState } = await getDatabase()
      if (ddo instanceof DeprecatedDDO) {
        const { id, nftAddress } = ddo.getDDOFields()
        await Promise.all([ddoDatabase.delete(id), ddoState.delete(id)])
        const saveDDO = await ddoDatabase.create(ddo.getDDOData())
        await ddoState.create(this.networkId, saveDDO.id, nftAddress, undefined, true)

        return saveDDO
      }

      const saveDDO = await ddoDatabase.update({ ...ddo.getDDOData() })
      await ddoState.update(
        this.networkId,
        saveDDO.id,
        saveDDO.nftAddress,
        saveDDO.indexedMetadata?.event?.tx,
        true
      )
      INDEXER_LOGGER.logMessage(
        `Saved or updated DDO  : ${saveDDO.id} from network: ${this.networkId} triggered by: ${method}`
      )
      return saveDDO
    } catch (err) {
      const { ddoState } = await getDatabase()
      const { id, nftAddress } = ddo.getDDOFields()
      const tx =
        ddo instanceof DeprecatedDDO
          ? undefined
          : ddo.getAssetFields().indexedMetadata?.event?.txid

      await ddoState.update(this.networkId, id, nftAddress, tx, true, err.message)
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error found on ${this.networkId} triggered by: ${method} while creating or updating DDO: ${err}`,
        true
      )
    }
  }

  protected checkDdoHash(decryptedDocument: any, documentHashFromContract: any): boolean {
    const utf8Bytes = toUtf8Bytes(JSON.stringify(decryptedDocument))
    const expectedMetadata = hexlify(utf8Bytes)
    if (create256Hash(expectedMetadata.toString()) !== documentHashFromContract) {
      INDEXER_LOGGER.error(`DDO checksum does not match.`)
      return false
    }
    return true
  }

  private async getNonce(decryptorURL: string, address: string) {
    try {
      if (URLUtils.isValidUrl(decryptorURL)) {
        INDEXER_LOGGER.logMessage(
          `decryptDDO: Making HTTP request for nonce. DecryptorURL: ${decryptorURL}`
        )
        const nonceResponse = await axios.get(
          `${decryptorURL}/api/services/nonce?userAddress=${address}`,
          { timeout: 20000 }
        )
        return nonceResponse.status === 200 && nonceResponse.data
          ? String(parseInt(nonceResponse.data.nonce) + 1)
          : Date.now().toString()
      } else {
        return Date.now().toString()
      }
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `decryptDDO: Error getting nonce, using timestamp: ${err.message}`
      )
      return Date.now().toString()
    }
  }

  protected async decryptDDO(
    decryptorURL: string,
    flag: string,
    eventCreator: string,
    contractAddress: string,
    chainId: number,
    txId: string,
    metadataHash: string,
    metadata: any
  ): Promise<any> {
    let ddo
    // Log the flag value
    INDEXER_LOGGER.logMessage(`decryptDDO: flag=${flag}`)
    if ((parseInt(flag) & 2) !== 0) {
      INDEXER_LOGGER.logMessage(
        `Decrypting DDO  from network: ${this.networkId} created by: ${eventCreator} encrypted by: ${decryptorURL}`
      )

      const oceanNode = OceanNode.getInstance()
      const keyManager = oceanNode.getKeyManager()
      const nodeId = keyManager.getPeerId().toString()
      const wallet = keyManager.getEthWallet()
      const ethAddress = wallet.address

      const useTxIdOrContractAddress = txId || contractAddress

      if (URLUtils.isValidUrl(decryptorURL)) {
        try {
          const response = await withRetrial(async () => {
            const nonce: string = await this.getNonce(decryptorURL, ethAddress)
            INDEXER_LOGGER.logMessage(
              `decryptDDO: Fetched fresh nonce ${nonce} for decrypt attempt`
            )

            const message = String(
              useTxIdOrContractAddress + ethAddress + chainId.toString() + nonce
            )
            const signature = await keyManager.signMessage(message)

            const payload = {
              transactionId: txId,
              chainId,
              decrypterAddress: ethAddress,
              dataNftAddress: contractAddress,
              signature,
              nonce
            }
            try {
              const res = await axios({
                method: 'post',
                url: `${decryptorURL}/api/services/decrypt`,
                data: payload,
                timeout: 30000,
                validateStatus: (status) => {
                  return (
                    (status >= 200 && status < 300) || status === 400 || status === 403
                  )
                }
              })

              INDEXER_LOGGER.log(
                LOG_LEVELS_STR.LEVEL_INFO,
                `Decrypt request successful. Status: ${res.status}, ${res.statusText}`
              )

              if (res.status === 400 || res.status === 403) {
                // Return error response, to avoid retry for unnecessary errors
                INDEXER_LOGGER.log(
                  LOG_LEVELS_STR.LEVEL_ERROR,
                  `bProvider exception on decrypt DDO. Status: ${res.status}, ${res.statusText}`
                )
                return res
              }

              if (res.status !== 200 && res.status !== 201) {
                const message = `bProvider exception on decrypt DDO. Status: ${res.status}, ${res.statusText}`
                INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
                throw new Error(message) // Retry 5XX errors
              }
              return res
            } catch (err: any) {
              // Retry ONLY on ECONNREFUSED
              if (
                err.code === 'ECONNREFUSED' ||
                (err.message && err.message.includes('ECONNREFUSED'))
              ) {
                INDEXER_LOGGER.log(
                  LOG_LEVELS_STR.LEVEL_ERROR,
                  `Decrypt request failed with ECONNREFUSED, retrying...`,
                  true
                )
                throw err
              }

              throw err
            }
          })

          if (response.status === 400 || response.status === 403) {
            throw new Error(`Provider validation failed: ${response.statusText}`)
          }

          let responseHash
          if (response.data instanceof Object) {
            responseHash = create256Hash(JSON.stringify(response.data))
            ddo = response.data
          } else {
            ddo = JSON.parse(response.data)
            responseHash = create256Hash(ddo)
          }
          if (responseHash !== metadataHash) {
            const msg = `Hash check failed: response=${ddo}, decrypted ddo hash=${responseHash}\n metadata hash=${metadataHash}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, msg)
            throw new Error(msg)
          }
        } catch (err) {
          const message = `Provider exception on decrypt DDO. Status: ${err.message}`
          INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
          throw new Error(message)
        }
      } else {
        // const node = OceanNode.getInstance(config, await getDatabase())
        if (nodeId === decryptorURL) {
          // Fetch nonce and signature from local node
          let nonceP2p: string
          const getNonceTask: NonceCommand = {
            address: ethAddress,
            command: PROTOCOL_COMMANDS.NONCE
          }
          try {
            const response = await oceanNode
              .getCoreHandlers()
              .getHandler(PROTOCOL_COMMANDS.NONCE)
              .handle(getNonceTask)
            nonceP2p = await streamToString(response.stream as Readable)
          } catch (error) {
            const message = `Node exception on getting nonce from local nodeId ${nodeId}. Status: ${error.message}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
            throw new Error(message)
          }
          INDEXER_LOGGER.debug(
            `decryptDDO: Fetched fresh nonce ${nonceP2p} for decrypt attempt from local nodeId ${nodeId}`
          )

          const message = String(
            useTxIdOrContractAddress + ethAddress + chainId.toString() + nonceP2p
          )
          const signature = await keyManager.signMessage(message)

          const decryptDDOTask: DecryptDDOCommand = {
            command: PROTOCOL_COMMANDS.DECRYPT_DDO,
            transactionId: txId,
            decrypterAddress: ethAddress,
            chainId,
            encryptedDocument: metadata,
            documentHash: metadataHash,
            dataNftAddress: contractAddress,
            signature,
            nonce: nonceP2p
          }
          try {
            const response = await oceanNode
              .getCoreHandlers()
              .getHandler(PROTOCOL_COMMANDS.DECRYPT_DDO)
              .handle(decryptDDOTask)
            ddo = JSON.parse(await streamToString(response.stream as Readable))
          } catch (error) {
            const message = `Node exception on decrypt DDO from local nodeId ${nodeId}. Status: ${error.message}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
            throw new Error(message)
          }
        } else {
          // it's a remote node
          try {
            const p2pNode = await oceanNode.getP2PNode()
            const getNonceTask: NonceCommand = {
              address: ethAddress,
              command: PROTOCOL_COMMANDS.NONCE
            }
            let response = await p2pNode.sendTo(
              decryptorURL,
              JSON.stringify(getNonceTask)
            )

            if (response.status.httpStatus !== 200) {
              const logMessage = `Node exception on get nonce from remote nodeId ${nodeId}. Status: ${response.status.httpStatus} ${response.status.error}`
              INDEXER_LOGGER.warn(logMessage)
              throw new Error(logMessage)
            }

            if (!response.stream) {
              const logMessage = `No stream for get nonce from remote nodeId ${nodeId}. Status: ${response.status.httpStatus} ${response.status.error}`
              INDEXER_LOGGER.warn(logMessage)
              throw new Error(logMessage)
            }

            // Convert stream to Uint8Array
            const remoteNonce = await streamToString(response.stream as Readable)
            INDEXER_LOGGER.debug(
              `decryptDDO: Fetched fresh nonce ${remoteNonce} from remote node ${decryptorURL} for decrypt attempt`
            )

            const messageToSign = String(
              useTxIdOrContractAddress + ethAddress + chainId.toString() + remoteNonce
            )
            const signature = await keyManager.signMessage(messageToSign)

            const message = {
              command: PROTOCOL_COMMANDS.DECRYPT_DDO,
              transactionId: txId,
              decrypterAddress: ethAddress,
              chainId,
              encryptedDocument: metadata,
              documentHash: metadataHash,
              dataNftAddress: contractAddress,
              signature,
              nonce: remoteNonce
            }

            response = await p2pNode.sendTo(decryptorURL, JSON.stringify(message))

            if (response.status.httpStatus !== 200) {
              const logMessage = `Node exception on decryptDDO from remote nodeId ${nodeId}. Status: ${response.status.httpStatus} ${response.status.error}`
              INDEXER_LOGGER.warn(logMessage)
              throw new Error(logMessage)
            }

            if (!response.stream) {
              const logMessage = `No stream for decryptDDO from remote nodeId ${nodeId}. Status: ${response.status.httpStatus} ${response.status.error}`
              INDEXER_LOGGER.warn(logMessage)
              throw new Error(logMessage)
            }

            // Convert stream to Uint8Array
            const data = await streamToUint8Array(response.stream as Readable)
            ddo = JSON.parse(uint8ArrayToString(data))
          } catch (error) {
            const message = `Exception from remote nodeId ${nodeId}. Status: ${error.message}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
            throw new Error(message)
          }
        }
      }
    } else {
      INDEXER_LOGGER.debug(
        `Decompressing DDO  from network: ${this.networkId} created by: ${eventCreator} ecnrypted by: ${decryptorURL}`
      )
      const byteArray = getBytes(metadata)
      const utf8String = toUtf8String(byteArray)
      ddo = JSON.parse(utf8String)
    }

    return ddo
  }

  public abstract processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider,
    eventName?: string
  ): Promise<any>
}
