// import { P2PCommandResponse } from '../../../@types/index.js'
// import { IndexingCommand, StartStopIndexingCommand } from '../../../@types/commands.js'
// import { ReadableString } from '../../P2P/handleProtocolCommands.js'
// import {
//   buildInvalidParametersResponse,
//   buildInvalidRequestMessage,
//   validateCommandParameters,
//   ValidateParams
// } from '../../httpRoutes/validateCommands.js'
// import { AdminHandler } from './adminHandler.js'
// import { OceanIndexer } from '../../Indexer/index.js'

// export class IndexingThreadHandler extends AdminHandler {
//   validate(command: StartStopIndexingCommand): ValidateParams {
//     if (!validateCommandParameters(command, ['chainId'])) {
//       return buildInvalidRequestMessage(
//         `Missing chainId field for command: "${command}".`
//       )
//     }
//     return super.validate(command)
//   }

//   // eslint-disable-next-line require-await
//   async handle(task: StartStopIndexingCommand): Promise<P2PCommandResponse> {
//     const validation = this.validate(task)
//     if (!validation.valid) {
//       return buildInvalidParametersResponse(validation)
//     }
//     if (task.action === IndexingCommand.START_THREAD) {
//       return {
//         status: {
//           httpStatus: 200,
//           error: null
//         },
//         stream: new ReadableString('OK')
//       }
//     } else if (task.action === IndexingCommand.STOP_THREAD) {
//       const indexer: OceanIndexer = this.getOceanNode().getIndexer()
//       if (task.chainId) {
//         indexer.stopThread(task.chainId.toString())
//       } else {
//         indexer.stopAllThreads()
//       }
//     }
//     return {
//       status: {
//         httpStatus: 200,
//         error: null
//       },
//       stream: new ReadableString('OK')
//     }
//   }
// }
