import {
  Controller,
  Post,
  Body,
  HttpCode,
  Query,
  Inject,
  UsePipes,
  Res
} from '@nestjs/common'
import { Response } from 'express'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import {
  LOGGER_MODULE_NAMES,
  CustomNodeLogger,
  getCustomLoggerForModule,
  getDefaultLevel
} from '../../utils/logging/Logger.js'
import { OceanP2P } from '../P2P/index.js'
import { BadRequestException } from '../../utils/errorHandling.js'
import { P2PCommandResponse } from '../../@types/index.js'

// just use the default logger with default transports
// Bellow is just an example usage
const logger: CustomNodeLogger = getCustomLoggerForModule(LOGGER_MODULE_NAMES.HTTP)

@Controller('commands')
@UsePipes()
export class CommandController {
  constructor(
    @Inject(OceanP2P)
    private readonly oceanNode: OceanP2P
  ) {}

  @Post('broadcast')
  @HttpCode(200)
  async broadcast(@Query('message') message: any) {
    try {
      if (!message) {
        throw new BadRequestException('The message query parameter is required.')
      }

      logger.log(getDefaultLevel(), `broadcastCommand received ${message}`, true)

      return await this.oceanNode.broadcast(message)
    } catch (error) {
      throw error
    }
  }

  @Post('direct')
  @HttpCode(200)
  async direct(@Body() body: any, @Res() res: Response) {
    if (!body.command || !body.node) {
      throw new BadRequestException('The message query parameter is required.')
    }

    const sink = async function (source: any) {
      let first = true
      for await (const chunk of source) {
        if (first) {
          first = false
          try {
            const str = uint8ArrayToString(chunk.subarray())
            const decoded = JSON.parse(str)
            res.set('Content-Type', 'application/json')
            res.status(decoded.httpStatus)
            if ('headers' in decoded) {
              res.header(decoded.headers)
            }
            if (decoded.httpStatus !== 200) {
              res.write(decoded.error)
              res.end()
              break
            }
          } catch (e) {
            res.status(500)
            res.write(uint8ArrayToString(chunk.subarray()))
            res.end()
          }
        } else {
          const str = uint8ArrayToString(chunk.subarray())
          res.write(str)
        }
      }
    }
    const status: P2PCommandResponse = await this.oceanNode.sendTo(
      body.node as string,
      JSON.stringify(body),
      sink
    )
    if (status.stream == null) {
      res.status(status.status.httpStatus)
      res.write(status.status.error)
      res.end()
    }
  }
}
