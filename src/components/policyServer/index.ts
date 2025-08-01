import { DDO } from '@oceanprotocol/ddo-js'
import { PolicyServerResult } from '../../@types/policyServer.js'
import { isDefined } from '../../utils/util.js'

export class PolicyServer {
  serverUrl: string

  public constructor() {
    this.serverUrl = process.env.POLICY_SERVER_URL
  }

  private async askServer(command: any): Promise<PolicyServerResult> {
    if (!this.serverUrl) return { success: true, message: '', httpStatus: 404 }
    let response
    try {
      response = await fetch(this.serverUrl, {
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify(command)
      })
    } catch (e) {
      return {
        success: true,
        message: '',
        httpStatus: 400
      }
    }
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
