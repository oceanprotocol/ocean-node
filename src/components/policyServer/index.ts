// import { CORE_LOGGER } from '../../utils/logging/common.js'
import { PolicyServerResult } from '../../@types/policyServer.js'
import { DDO } from '../../@types/DDO/DDO.js'

export class PolicyServer {
  serverUrl: string

  public constructor() {
    this.serverUrl = process.env.POLICY_SERVER_URL
  }

  private async askServer(command: any): Promise<PolicyServerResult> {
    if (!this.serverUrl) return { success: true, message: '' }
    const response = await fetch(this.serverUrl, {
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'POST',
      body: JSON.stringify(command)
    })

    if (response.status === 200) {
      return { success: true, message: '' }
    }
    return { success: false, message: await response.text() }
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

  async checkInitialize(
    documentId: string,
    ddo: DDO,
    serviceId: string,
    consumerAddress: string,
    policyServer: any
  ): Promise<PolicyServerResult> {
    const command = {
      action: 'initialize',
      documentId,
      ddo,
      serviceId,
      consumerAddress,
      policyServer
    }
    return await this.askServer(command)
  }

  async checkDownload(
    documentId: string,
    ddo: DDO,
    serviceId: string,
    fileIndex: number,
    transferTxId: string,
    consumerAddress: string,
    policyServer: any
  ): Promise<PolicyServerResult> {
    const command = {
      action: 'download',
      documentId,
      ddo,
      serviceId,
      fileIndex,
      transferTxId,
      consumerAddress,
      policyServer
    }
    return await this.askServer(command)
  }
}
