import { Module } from '@nestjs/common'
import {
  CommandController,
  DidsController,
  OceanPeersController
} from './components/httpRoutes'
import { OceanP2P } from './components/P2P'

@Module({
  imports: [],
  controllers: [CommandController, DidsController, OceanPeersController],
  providers: [OceanP2P]
})
export class AppModule {}
