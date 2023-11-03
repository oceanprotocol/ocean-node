import {
  Controller,
  Post,
  Body,
  HttpCode,
  Query,
  Inject,
  UsePipes,
  Res,
  Get
} from '@nestjs/common'
import { OceanP2P } from '../P2P/index.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  getCustomLoggerForModule,
  getDefaultLevel
} from '../../utils/logging/Logger.js'
import { BadRequestException } from '../../utils/errorHandling.js'

@Controller('ocean-peers')
@UsePipes()
export class OceanPeersController {
  constructor(
    @Inject(OceanP2P)
    private readonly oceanNode: OceanP2P
  ) {}

  logger: CustomNodeLogger = getCustomLoggerForModule(LOGGER_MODULE_NAMES.HTTP)

  @Get()
  @HttpCode(200)
  async getOceanPeersRoute() {
    try {
      const peers = await this.oceanNode.getPeers()
      this.logger.log(getDefaultLevel(), `getOceanPeers: ${peers}`, true)
      return peers
    } catch (error) {
      throw error
    }
  }

  @Get('/p2p-peers')
  @HttpCode(200)
  async getP2PPeersRoute() {
    try {
      const peers = await this.oceanNode.getAllPeerStore()
      this.logger.log(getDefaultLevel(), `getOceanPeers: ${peers}`, true)
      return peers
    } catch (error) {
      throw error
    }
  }

  @Get('/p2p-peer/')
  @HttpCode(200)
  async getP2PPeerRoute(@Query('peerId') peerId: any) {
    try {
      if (!peerId) {
        throw new BadRequestException()
      }
      const peers = await this.oceanNode.getPeerDetails(String(peerId))
      this.logger.log(getDefaultLevel(), `getPeerDetails: ${peers}`, true)
      return peers
    } catch (error) {
      throw error
    }
  }
}
