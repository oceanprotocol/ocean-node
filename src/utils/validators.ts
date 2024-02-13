import {ConsumerParameter} from "../@types/DDO/ConsumerParameter.js";
import {CORE_LOGGER} from "./logging/common.js";

function checkString(value: any) {
    return typeof value === 'string' || value instanceof String
}

function checkBoolean(value: any) {
    return typeof value === 'boolean' || value instanceof Boolean
}

function checkNumber(value: any) {
    return typeof value === 'number' || value instanceof Number
}

function checkObject(value: any) {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
    );
}

export function validateConsumerParameters(ddoConsumerParameters: ConsumerParameter[], userSentObject: any[]) {
    const validation = {
        valid: true,
        message: ''
    }

    try {
        if (!Array.isArray(userSentObject)) {
            throw new Error(`Value is not an array`)
        }

        for (const consumerParameter of ddoConsumerParameters) {
            for (const sentObject of userSentObject) {
                if (!checkObject(sentObject)) {
                    throw new Error(`Value is not an object`)
                }
                const sentObjectKey = consumerParameter.name
                if (sentObject[sentObjectKey] == undefined) {
                    if (consumerParameter.required) {
                        throw new Error(`value of key ${sentObjectKey} parameter is required`)
                    }
                    sentObject[sentObjectKey] = consumerParameter.default
                }
                const sentObjectValue = sentObject[sentObjectKey]
                switch (consumerParameter.type) {
                    case 'text':
                        if (!checkString(sentObjectValue)) {
                            throw new Error(`value ${sentObjectValue} of key ${sentObjectKey} parameter is not a text`)
                        }
                        break;
                    case 'number':
                        if (!checkNumber(sentObjectValue)) {
                            throw new Error(`value ${sentObjectValue} of key ${sentObjectKey} parameter is not a number`)
                        }
                        break;
                    case 'boolean':
                        if (!checkBoolean(sentObjectValue)) {
                            throw new Error(`value ${sentObjectValue} of key ${sentObjectKey} parameter is not a boolean`)
                        }
                        break;
                    case 'select':
                        const options: any[] = consumerParameter.options.map(option => Object.keys(option)[0])
                        if (!options.includes(sentObjectValue)) {
                            throw new Error(`value ${sentObjectValue} of key ${sentObjectKey} parameter is not a select`)
                        }
                        break;
                }
            }
        }
        return validation
    } catch (error) {
        CORE_LOGGER.error(error.message)
        validation.valid = false
        validation.message = error.message
        return validation
    }
}
