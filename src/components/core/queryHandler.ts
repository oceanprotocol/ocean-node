import { Handler } from './handler.js'
import { QueryCommand, getSchemaVersions } from '../../utils/index.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { DDO } from '../../@types/DDO/DDO.js'

export class QueryHandler extends Handler {
  async handle(task: QueryCommand): Promise<P2PCommandResponse> {
    try {
      let aggregatedResults: DDO[] = []
      const versions = await getSchemaVersions()

      for (const version of versions) {
        // Modify this line to query the specific collection based on version
        const result = await this.getP2PNode()
          .getDatabase()
          .ddo.searchByVersion(version, task.query)
        if (result && result.length) {
          aggregatedResults = aggregatedResults.concat(result)
        }
      }

      if (aggregatedResults.length === 0) {
        aggregatedResults = []
      }

      return {
        stream: Readable.from(JSON.stringify(aggregatedResults)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
