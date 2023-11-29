import { Log } from 'ethers'
import { Interface } from '@ethersproject/abi'

export function parseEventLogs<T>(
  logs: readonly Log[],
  eventName: string,
  contractInterface: Interface
): T[] {
  return logs
    .filter((log) => log.topics[0] === contractInterface.getEventTopic(eventName))
    .map((log) => {
      const logOutput = {
        topics: [...log.topics],
        data: log.data
      }
      return contractInterface.parseLog(logOutput).args as unknown as T
    })
}
