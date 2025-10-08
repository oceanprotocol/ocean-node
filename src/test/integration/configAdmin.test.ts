import { Wallet } from 'ethers'
import { Database } from '../../components/database/index.js'
import { getConfiguration, loadConfigFromFile } from '../../utils/index.js'
import {
    DEFAULT_TEST_TIMEOUT,
    OverrideEnvConfig,
    TEST_ENV_CONFIG_FILE,
    buildEnvOverrideConfig,
    setupEnvironment,
    tearDownEnvironment,
    getMockSupportedNetworks
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import { OceanNode } from '../../OceanNode.js'
import { FetchConfigHandler } from '../../components/core/admin/fetchConfigHandler.js'
import { PushConfigHandler } from '../../components/core/admin/pushConfigHandler.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'stream'
import { expect } from 'chai'
import fs from 'fs'
import path from 'path'

describe('Config Admin Endpoints Integration Tests', () => {
    let config: OceanNodeConfig
    let database: Database
    let adminAccount: Wallet
    let previousConfiguration: OverrideEnvConfig[]
    let oceanNode: OceanNode

    const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

    before(async () => {
        const adminPrivateKey =
            '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
        adminAccount = new Wallet(adminPrivateKey)
        const adminAddress = await adminAccount.getAddress()

        previousConfiguration = await setupEnvironment(
            TEST_ENV_CONFIG_FILE,
            buildEnvOverrideConfig(
                [
                    ENVIRONMENT_VARIABLES.RPCS,
                    ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
                    ENVIRONMENT_VARIABLES.ALLOWED_ADMINS
                ],
                [
                    JSON.stringify(mockSupportedNetworks),
                    JSON.stringify([8996]),
                    JSON.stringify([adminAddress])
                ]
            )
        )

        config = await getConfiguration(true)
        database = await Database.init(config.dbConfig)
        oceanNode = await OceanNode.getInstance(config, database)
    })

    after(async () => {
        // Clean up test backup directories if they exist
        const backupDir = path.join(process.cwd(), 'config_backups')
        if (fs.existsSync(backupDir)) {
            const files = fs.readdirSync(backupDir)
            for (const file of files) {
                if (file.startsWith('config.backup.')) {
                    const filePath = path.join(backupDir, file)
                    const stats = fs.statSync(filePath)
                    if (Date.now() - stats.mtimeMs < 3600000) {
                        fs.unlinkSync(filePath)
                    }
                }
            }
        }

        await tearDownEnvironment(previousConfiguration)
    })

    const getAdminSignature = async (expiryTimestamp: number): Promise<string> => {
        const message = expiryTimestamp.toString()
        return await adminAccount.signMessage(message)
    }

    describe('Fetch Config Tests', () => {
        it('should fetch current config with last backup info', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const expiryTimestamp = Date.now() + 60000
            const signature = await getAdminSignature(expiryTimestamp)

            const handlerResponse = await new FetchConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.FETCH_CONFIG,
                expiryTimestamp,
                signature
            })

            expect(handlerResponse.status.httpStatus).to.equal(200)

            const response = await streamToObject(handlerResponse.stream as Readable)
            expect(response).to.be.an('object')
            expect(response).to.have.property('config')
            expect(response).to.have.property('lastBackup')
            expect(response.config).to.be.an('object')
            expect(response.config).to.have.property('hasHttp')
            expect(response.config).to.have.property('hasP2P')
        })

        it('should reject fetch config with signature from non-admin', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const nonAdminPrivateKey =
                '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
            const nonAdminAccount = new Wallet(nonAdminPrivateKey)

            const expiryTimestamp = Date.now() + 60000
            const message = expiryTimestamp.toString()
            const invalidSignature = await nonAdminAccount.signMessage(message)

            const handlerResponse = await new FetchConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.FETCH_CONFIG,
                expiryTimestamp,
                signature: invalidSignature
            })

            expect(handlerResponse.status.httpStatus).to.not.equal(200)
        })

        it('should reject fetch config with expired timestamp', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const expiryTimestamp = Date.now() - 60000
            const signature = await getAdminSignature(expiryTimestamp)

            const handlerResponse = await new FetchConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.FETCH_CONFIG,
                expiryTimestamp,
                signature
            })

            expect(handlerResponse.status.httpStatus).to.not.equal(200)
        })
    })

    describe('Push Config Tests', () => {
        it('should push config changes and reload node', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const expiryTimestamp = Date.now() + 60000
            const signature = await getAdminSignature(expiryTimestamp)

            const newConfig = {
                rateLimit: 100,
                maxConnections: 200
            }

            const handlerResponse = await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp,
                signature,
                config: newConfig
            })

            expect(handlerResponse.status.httpStatus).to.equal(200)

            const response = await streamToObject(handlerResponse.stream as Readable)
            expect(response).to.have.property('message')
            expect(response).to.have.property('config')
            expect(response.config.rateLimit).to.equal(100)
            expect(response.config.maxConnections).to.equal(200)

            const savedConfig = loadConfigFromFile()
            expect(savedConfig.rateLimit).to.equal(100)
            expect(savedConfig.maxConnections).to.equal(200)

            const restoreConfig = {
                rateLimit: 30,
                maxConnections: 30
            }

            await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp: Date.now() + 60000,
                signature: await getAdminSignature(Date.now() + 60000),
                config: restoreConfig
            })
        })

        it('should merge new config with existing config', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const expiryTimestamp = Date.now() + 60000
            const signature = await getAdminSignature(expiryTimestamp)

            const fetchResponse = await new FetchConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.FETCH_CONFIG,
                expiryTimestamp,
                signature
            })

            const { config: currentConfig } = await streamToObject(
                fetchResponse.stream as Readable
            )

            const partialConfig = {
                rateLimit: 75
            }

            const pushResponse = await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp: Date.now() + 60000,
                signature: await getAdminSignature(Date.now() + 60000),
                config: partialConfig
            })

            const { config: updatedConfig } = await streamToObject(
                pushResponse.stream as Readable
            )

            expect(updatedConfig.rateLimit).to.equal(75)
            expect(updatedConfig.maxConnections).to.equal(currentConfig.maxConnections)

            await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp: Date.now() + 60000,
                signature: await getAdminSignature(Date.now() + 60000),
                config: { rateLimit: currentConfig.rateLimit }
            })
        })

        it('should create backup before pushing config', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const expiryTimestamp = Date.now() + 60000
            const signature = await getAdminSignature(expiryTimestamp)

            const backupDir = path.join(process.cwd(), 'config_backups')
            const filesBefore = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0

            await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp,
                signature,
                config: { rateLimit: 85 }
            })

            const filesAfter = fs.readdirSync(backupDir).length
            expect(filesAfter).to.be.greaterThan(filesBefore)

            await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp: Date.now() + 60000,
                signature: await getAdminSignature(Date.now() + 60000),
                config: { rateLimit: 30 }
            })
        })

        it('should reject push config with signature from non-admin', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const nonAdminPrivateKey =
                '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
            const nonAdminAccount = new Wallet(nonAdminPrivateKey)

            const expiryTimestamp = Date.now() + 60000
            const message = expiryTimestamp.toString()
            const invalidSignature = await nonAdminAccount.signMessage(message)

            const handlerResponse = await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp,
                signature: invalidSignature,
                config: { rateLimit: 100 }
            })

            expect(handlerResponse.status.httpStatus).to.not.equal(200)
        })

        it('should reject push config with expired timestamp', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const expiryTimestamp = Date.now() - 60000
            const signature = await getAdminSignature(expiryTimestamp)

            const handlerResponse = await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp,
                signature,
                config: { rateLimit: 100 }
            })

            expect(handlerResponse.status.httpStatus).to.not.equal(200)
        })

        it('should reject push config with missing config parameter', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const expiryTimestamp = Date.now() + 60000
            const signature = await getAdminSignature(expiryTimestamp)

            const handlerResponse = await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp,
                signature,
                config: undefined
            })

            expect(handlerResponse.status.httpStatus).to.equal(400)
        })

        it('should reject push config with invalid config type', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const expiryTimestamp = Date.now() + 60000
            const signature = await getAdminSignature(expiryTimestamp)

            const handlerResponse = await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp,
                signature,
                config: 'invalid' as any
            })

            expect(handlerResponse.status.httpStatus).to.equal(400)
        })

        it('should reject push config with invalid field values (Zod validation)', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const expiryTimestamp = Date.now() + 60000
            const signature = await getAdminSignature(expiryTimestamp)

            const handlerResponse = await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp,
                signature,
                config: { rateLimit: 'not-a-number' as any }
            })

            expect(handlerResponse.status.httpStatus).to.equal(400)
            expect(handlerResponse.status.error).to.not.equal(undefined)
            expect(handlerResponse.stream).to.equal(null)
        })
    })

    describe('Config Reload Tests', () => {
        it('should reload node configuration after push', async function () {
            this.timeout(DEFAULT_TEST_TIMEOUT)

            const expiryTimestamp = Date.now() + 60000
            const signature = await getAdminSignature(expiryTimestamp)

            const configBefore = await getConfiguration()

            await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp,
                signature,
                config: { rateLimit: 999 }
            })

            const configAfter = await getConfiguration()

            expect(configAfter.rateLimit).to.equal(999)
            expect(configAfter.rateLimit).to.not.equal(configBefore.rateLimit)

            await new PushConfigHandler(oceanNode).handle({
                command: PROTOCOL_COMMANDS.PUSH_CONFIG,
                expiryTimestamp: Date.now() + 60000,
                signature: await getAdminSignature(Date.now() + 60000),
                config: { rateLimit: configBefore.rateLimit }
            })
        })
    })
})
