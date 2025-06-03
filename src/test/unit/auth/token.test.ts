import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { getConfiguration, getMessageHash } from '../../../utils/index.js'
import { expect } from 'chai'
import { Database } from '../../../components/database/index.js'
import { Wallet } from 'ethers'
import { Auth } from '../../../components/Auth/index.js'

describe('Auth Token Tests', () => {
    let wallet: Wallet
    let mockDatabase: Database
    let config: OceanNodeConfig

    before(async () => {
        config = await getConfiguration(true)
        mockDatabase = await new Database(config.dbConfig)
        wallet = new Wallet(process.env.PRIVATE_KEY)
    })

    const createToken = async (auth: Auth, address: string, validUntil: number) => {
        const msg = auth.getSignatureMessage()
        const messageHash = await getMessageHash(msg);
        const signature = await wallet.signMessage(messageHash);
        const token = await auth.createToken(signature, address, validUntil);
        return token;
    }

    it('should create and validate a token', async () => {
        const auth = new Auth(mockDatabase)
        const token = await createToken(auth, wallet.address, null)
        expect(token).to.be.a('string')

        const validationResult = await auth.validateToken(token)
        expect(validationResult).to.not.be.null
        expect(validationResult?.address).to.equal(wallet.address)
    })


    it('should validate authentication with token', async () => {
        const auth = new Auth(mockDatabase)
        const token = await createToken(auth, wallet.address, null)
        const result = await auth.validateAuthenticationOrToken(wallet.address, undefined, token)
        expect(result.valid).to.be.true
    })

    it('should validate authentication with signature', async () => {
        const auth = new Auth(mockDatabase)
        const message = auth.getSignatureMessage()
        const messageHash = await getMessageHash(message)
        const signature = await wallet.signMessage(messageHash)

        const result = await auth.validateAuthenticationOrToken(
            wallet.address,
            signature,
            undefined,
            message
        )
        expect(result.valid).to.be.true
    })

    it('should fail validation with invalid token', async () => {
        const auth = new Auth(mockDatabase)
        const result = await auth.validateAuthenticationOrToken(
            wallet.address,
            undefined,
            'invalid-token'
        )
        expect(result.valid).to.be.false
    })

    it('should fail validation with invalid signature', async () => {
        const auth = new Auth(mockDatabase)
        const message = 'Test message'
        const invalidSignature = '0x' + '0'.repeat(130)

        const result = await auth.validateAuthenticationOrToken(
            wallet.address,
            invalidSignature,
            undefined,
            message
        )
        expect(result.valid).to.be.false
    })

    it('should respect token expiry', async () => {
        const auth = new Auth(mockDatabase)
        const validUntil = new Date(Date.now() - 1000) // 1 second ago
        const token = await createToken(auth, wallet.address, validUntil.getTime())

        const validationResult = await auth.validateToken(token)
        expect(validationResult).to.be.null
    })
}) 