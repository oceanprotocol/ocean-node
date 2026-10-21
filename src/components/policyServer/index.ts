import { DDO } from '@oceanprotocol/ddo-js'
import { PolicyServerResult } from '../../@types/policyServer.js'
import { isDefined } from '../../utils/util.js'
import { BaseFileObject } from '../../@types/fileObject.js'
import { OceanNode } from '../../OceanNode.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { errorSummary, redactUrls } from '../../utils/logging/redact.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'

const POLICY_SERVER_UNREACHABLE = 'policy-server-unreachable'

export class PolicyServer {
  serverUrl: string
  private apikey: string

  public constructor() {
    this.serverUrl = process.env.POLICY_SERVER_URL
    this.apikey = process.env.POLICY_SERVER_API_KEY
  }

  private attachNodeAddress(command: Record<string, any>): Record<string, any> {
    const node = OceanNode.getInstance()
    const keyManager = node.getKeyManager()
    const nodeAddress = keyManager.getEthWallet().address
    return {
      ...command,
      nodeAddress
    }
  }

  private async askServer(command: any): Promise<PolicyServerResult> {
    if (!this.serverUrl) return { success: true, message: '', httpStatus: 404 }
    let response
    const commandWithNodeAddress = this.attachNodeAddress(command)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (this.apikey) {
      headers['X-API-Key'] = this.apikey
    }
    try {
      response = await fetch(this.serverUrl, {
        headers,
        method: 'POST',
        body: JSON.stringify(commandWithNodeAddress)
      })
    } catch (e) {
      CORE_LOGGER.throttled(
        POLICY_SERVER_UNREACHABLE,
        LOG_LEVELS_STR.LEVEL_WARN,
        `Policy server ${redactUrls(this.serverUrl)} unreachable: ${errorSummary(e)}`
      )
      const errorText =
        e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)
      return {
        success: false,
        message: errorText || 'Policy server request failed',
        httpStatus: 400
      }
    }
    CORE_LOGGER.resetThrottle(POLICY_SERVER_UNREACHABLE)
    if (response.status === 200) {
      return {
        success: true,
        message: await response.text(),
        httpStatus: response.status
      }
    }
    return { success: false, message: await response.text(), httpStatus: response.status }
  }

  async checknewDDO(
    rawDDO: DDO,
    chainId: number,
    txId: string,
    eventRaw: any
  ): Promise<PolicyServerResult> {
    const command = {
      action: 'newDDO',
      rawDDO,
      chainId,
      txId,
      eventRaw
    }
    return await this.askServer(command)
  }

  async checkUpdateDDO(
    rawDDO: DDO,
    chainId: number,
    txId: string,
    eventRaw: any
  ): Promise<PolicyServerResult> {
    const command = {
      action: 'updateDDO',
      rawDDO,
      chainId,
      txId,
      eventRaw
    }
    return await this.askServer(command)
  }

  async validateDDO(
    rawDDO: DDO,
    publisherAddress: string,
    policyServer: any
  ): Promise<PolicyServerResult> {
    const command = {
      action: 'validateDDO',
      rawDDO,
      publisherAddress,
      policyServer
    }
    return await this.askServer(command)
  }

  async checkEncrypt(
    consumerAddress: string,
    policyServer: any
  ): Promise<PolicyServerResult> {
    const command = {
      action: 'encrypt',
      consumerAddress,
      policyServer
    }
    return await this.askServer(command)
  }

  async checkEncryptFile(
    consumerAddress: string,
    policyServer: any,
    files?: BaseFileObject
  ): Promise<PolicyServerResult> {
    const command = {
      action: 'encryptFile',
      consumerAddress,
      policyServer,
      files
    }
    return await this.askServer(command)
  }

  async checkDownload(
    documentId: string,
    ddo: DDO,
    serviceId: string,
    consumerAddress: string,
    policyServer: any
  ): Promise<PolicyServerResult> {
    const command = {
      action: 'download',
      documentId,
      ddo,
      serviceId,
      consumerAddress,
      policyServer
    }
    return await this.askServer(command)
  }

  async checkStartCompute(
    documentId: string,
    ddo: DDO,
    serviceId: string,
    consumerAddress: string,
    policyServer: any
  ): Promise<PolicyServerResult> {
    const command = {
      action: 'startCompute',
      documentId,
      ddo,
      serviceId,
      consumerAddress,
      policyServer
    }
    return await this.askServer(command)
  }

  async initializePSVerification(
    documentId: string,
    ddo: DDO,
    serviceId: string,
    consumerAddress: string,
    policyServer: any
  ): Promise<PolicyServerResult> {
    const command = {
      action: 'initiate',
      documentId,
      serviceId,
      ddo,
      consumerAddress,
      policyServer
    }
    return await this.askServer(command)
  }

  async passThrough(request: any): Promise<PolicyServerResult> {
    return await this.askServer(request)
  }

  public isConfigured(): boolean {
    return isDefined(this.serverUrl)
  }
}
