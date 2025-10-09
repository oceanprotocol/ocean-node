import { Readable } from "stream";
import { GetJobsCommand } from "../../../@types/commands.js";
import { CORE_LOGGER } from "../../../utils/logging/common.js";
import { buildInvalidRequestMessage } from "../../httpRoutes/validateCommands.js";
import { CommandHandler } from "./handler.js";
import { P2PCommandResponse } from "../../../@types/OceanNode.js";


export class GetJobsHandler extends CommandHandler {
    validate(command: GetJobsCommand) {
        if(command.fromTimestamp && typeof command.fromTimestamp !== 'string') {
            return buildInvalidRequestMessage('Parameter : "fromTimestamp" is not a valid string')
        }
        return {valid: true}
    }


    async handle(task: GetJobsCommand): Promise<P2PCommandResponse> {
        const validationResponse = await this.verifyParamsAndRateLimits(task);
        if(this.shouldDenyTaskHandling(validationResponse)) {
            return validationResponse
        }

        try {
            const {c2d} = this.getOceanNode().getDatabase()
            if(!c2d) {
                throw new Error('C2D database not initialized')
            }

            const jobs = await c2d.getAllFinishedJobs();
            return {
                stream: Readable.from(JSON.stringify(jobs)),
                status: {
                    httpStatus: 200,
                    error: null
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            CORE_LOGGER.error('Error retrieving node jobs: ' + message)
            return {
                status: {
                    httpStatus: 500,
                    error: message
                },
                stream: null
            }
        }
    }
}