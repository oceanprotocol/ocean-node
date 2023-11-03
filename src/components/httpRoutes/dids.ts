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
import { OceanP2P } from '../P2P/index.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { BadRequestException } from '../../utils/errorHandling.js'

@Controller('dids')
@UsePipes()
export class DidsController {
  constructor(
    @Inject(OceanP2P)
    private readonly oceanNode: OceanP2P
  ) {}

  logger: CustomNodeLogger = getCustomLoggerForModule(LOGGER_MODULE_NAMES.HTTP)

  @Post('advertiseDid')
  @HttpCode(200)
  async advertiseDid(@Query('did') did: string) {
    try {
      if (!did) {
        throw new BadRequestException('The did query parameter is required.')
      }
      return await this.oceanNode.advertiseDid(did as string)
    } catch (error) {
      throw error
    }
  }

  @Post('getProvidersForDid')
  @HttpCode(200)
  async getProvidersForDid(@Query('did') did: string) {
    try {
      if (!did) {
        throw new BadRequestException('The did query parameter is required.')
      }
      return await this.oceanNode.getProvidersForDid(did as string)
    } catch (error) {
      throw error
    }
  }
}
