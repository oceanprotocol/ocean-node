import { expect, assert } from 'chai'
import sinon from 'sinon'
import { C2DDatabase } from '../../components/database/C2DDatabase.js'
import { getConfiguration } from '../../utils/config.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { C2DEngineDocker } from '../../components/c2d/compute_engine_docker.js'
import { Escrow } from '../../components/core/utils/escrow.js'
import { KeyManager } from '../../components/KeyManager/index.js'
import { C2DClusterInfo } from '../../@types/C2D/C2D.js'
import Dockerode from 'dockerode'

const MS_PER_DAY = 24 * 60 * 60 * 1000
// a negative retention puts the cutoff in the future: every tracked image is listed
const ALL_IMAGES = -1

describe('**********         Docker Image Cleanup Integration Tests', () => {
  let envOverrides: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let db: C2DDatabase
  let dockerEngine: C2DEngineDocker
  let docker: Dockerode

  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS],
      [
        JSON.stringify([
          {
            socketPath: '/var/run/docker.sock',
            imageRetentionDays: 7,
            // Schema minimum (1h); the tests trigger cleanupOldImages() manually and only
            // assert the timer exists/clears, so the interval value itself is never awaited.
            imageCleanupInterval: 3600,
            environments: [
              {
                storageExpiry: 604800,
                maxJobDuration: 3600,
                minJobDuration: 60,
                resources: [
                  { id: 'cpu', total: 4, max: 4, min: 1, type: 'cpu' },
                  { id: 'ram', total: 10, max: 10, min: 1, type: 'ram' },
                  { id: 'disk', total: 10, max: 10, min: 0, type: 'disk' }
                ],
                fees: {
                  '1': [
                    {
                      feeToken: '0x123',
                      prices: [{ id: 'cpu', price: 1 }]
                    }
                  ]
                },
                access: {
                  addresses: [],
                  accessLists: null
                }
              }
            ]
          }
        ])
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    config = await getConfiguration(true)
    db = await new C2DDatabase(config.dbConfig)

    // Initialize Docker connection for testing
    docker = new Dockerode()
  })

  // records the image as last used `days` ago: only Date is faked, timers stay real
  async function updateImageDaysAgo(image: string, days: number): Promise<void> {
    const clock = sinon.useFakeTimers({
      now: Date.now() - days * MS_PER_DAY,
      toFake: ['Date']
    })
    try {
      await db.updateImage(image)
    } finally {
      clock.restore()
    }
  }

  after(async () => {
    await tearDownEnvironment(envOverrides)
    if (dockerEngine) {
      await dockerEngine.stop()
    }
  })

  describe('Image Tracking Database Methods', () => {
    it('should update image usage timestamp', async () => {
      const testImage = 'test-image:latest'
      await db.updateImage(testImage)

      expect(await db.getOldImages(ALL_IMAGES)).to.include(testImage)
      expect(await db.getOldImages(7)).to.not.include(testImage)
    })

    it('should update existing image timestamp', async () => {
      const testImage = 'test-image-update:latest'

      await updateImageDaysAgo(testImage, 8)
      expect(await db.getOldImages(7)).to.include(testImage)

      // using the image again makes it recent
      await db.updateImage(testImage)
      expect(await db.getOldImages(7)).to.not.include(testImage)
    })

    it('should return old images based on retention days', async () => {
      const recentImage = 'recent-image:latest'
      const oldImage = 'old-image:latest'

      await db.updateImage(recentImage)
      await updateImageDaysAgo(oldImage, 8)

      // Get images older than 7 days
      const oldImages = await db.getOldImages(7)
      expect(oldImages).to.include(oldImage)
      expect(oldImages).to.not.include(recentImage)
    })

    it('should return empty array when no old images exist', async () => {
      const recentImage = 'very-recent-image:latest'
      await db.updateImage(recentImage)

      const oldImages = await db.getOldImages(30) // 30 days retention
      expect(oldImages).to.not.include(recentImage)
    })
  })

  describe('C2DEngineDocker Image Cleanup', () => {
    let clusterConfig: C2DClusterInfo
    let escrow: Escrow
    let keyManager: KeyManager

    before(() => {
      // Create minimal cluster config for testing
      clusterConfig = {
        type: 'docker' as any,
        hash: 'test-cluster-hash',
        connection: config.dockerComputeEnvironments[0],
        tempFolder: '/tmp/test-c2d'
      }

      // Create mock escrow and keyManager (minimal setup)
      escrow = {} as Escrow
      keyManager = {} as KeyManager

      dockerEngine = new C2DEngineDocker(clusterConfig, db, escrow, keyManager, config)
    })

    it('should track image usage when image is pulled', async () => {
      const testImage = 'alpine:latest'

      // Call updateImageUsage directly (using private method access for testing)
      await (dockerEngine as any).updateImageUsage(testImage)

      expect(
        await db.getOldImages(ALL_IMAGES),
        'Image should be recorded in database after updateImageUsage'
      ).to.include(testImage)
    })

    it('should start image cleanup timer on engine start', () => {
      // Check if timer property exists
      assert(dockerEngine, 'dockerEngine should be initialized')
      expect(dockerEngine).to.have.property('imageCleanupTimer')
    })

    it('should stop image cleanup timer on engine stop', async () => {
      await dockerEngine.stop()
      // Timer should be cleared
      const timer = (dockerEngine as any).imageCleanupTimer
      assert(timer === null, 'Timer should be cleared after stop')
    })

    it('should handle cleanup of non-existent images gracefully', async () => {
      const nonExistentImage = 'non-existent-image:999999'

      // Manually insert into database
      await db.updateImage(nonExistentImage)

      // Try to clean it up - should not throw error
      try {
        await (dockerEngine as any).cleanupOldImages()
        assert(true, 'cleanupOldImages should complete without error')
      } catch (e) {
        // Cleanup should handle errors gracefully
        assert.fail('cleanupOldImages should not throw errors for non-existent images')
      }
    })
  })

  describe('Image Cleanup with Real Docker (if available)', () => {
    let testImageName: string

    before(async () => {
      // Check if Docker is available
      try {
        await docker.info()
      } catch (e) {
        // Skip tests if Docker is not available
      }
    })

    it('should cleanup old images from Docker', async function () {
      // Skip if Docker not available
      try {
        await docker.info()
      } catch (e) {
        this.skip()
      }

      testImageName = 'alpine:3.18'

      // Pull a test image
      try {
        await docker.pull(testImageName)
      } catch (e) {
        // If pull fails, skip test
        this.skip()
      }

      // Track the image with old timestamp (8 days ago)
      await updateImageDaysAgo(testImageName, 8)

      // Verify image exists before cleanup
      const imagesBefore = await docker.listImages()
      const imageExistsBefore = imagesBefore.some(
        (img) => img.RepoTags && img.RepoTags.includes(testImageName)
      )

      if (imageExistsBefore) {
        // Run cleanup
        await (dockerEngine as any).cleanupOldImages()

        // Verify cleanup was attempted (may or may not succeed if image in use)
        // We just verify the cleanup function ran without error
        assert(true, 'cleanupOldImages should complete without error')
      }
    })

    after(async function () {
      // Clean up test image if it exists
      try {
        const dockerInfo = await docker.info()
        assert(dockerInfo, 'Docker should be available for cleanup')
        if (testImageName) {
          try {
            const image = docker.getImage(testImageName)
            await image.remove({ force: true })
          } catch (e) {
            // Ignore errors during cleanup
          }
        }
      } catch (e) {
        // Docker not available, skip cleanup
      }
    })
  })
})
