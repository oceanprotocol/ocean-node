import winston, { Logger } from 'winston';
import * as Transport from 'winston-transport';
//import { AbstractConfigSetLevels } from 'winston/lib/winston/config';

//all the types of modules/components
export const LOGGER_MODULE_NAMES = {
    HTTP: "http",
    P2P: "p2p",
    INDEXER: "indexer",
    PROVIDER: "provider",
    DATABASE: "database",
    ALL_COMBINED: "all" 
}

//Some constants for logging
export const LOG_LEVELS_NUM = {
    'error': 0,
    'warn': 1,
    'info': 2,
    'http': 3,
    'verbose': 4,
    'debug': 5,
    'silly': 6
};

export const LOG_LEVELS_STR = {
    LEVEl_ERROR: 'error',
    LEVEL_WARN: 'warn',
    LEVEL_INFO: 'info',
    LEVEL_HTTP: 'http',
    LEVEL_VERBOSE: 'verbose',
    LEVEL_DEBUG: 'debug',
    LEVEL_SILLY: 'silly'
};
    
export const LOG_COLORS = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'white',
    http: 'magenta' 
}

//if not set, then gets default 'development' level & colors
export const isDevelopment =(): boolean => {
    return process.env.NODE_ENV && (process.env.NODE_ENV.toLowerCase() === 'development');
}

export const getDefaultLevel = (): string => {
    return isDevelopment() ? 'debug' : 'info';
}

if(isDevelopment()) {
    winston.addColors(LOG_COLORS);
}


export const format: winston.Logform.Format = winston.format.combine (
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss'}),
    winston.format.printf((info: any) => `${info.timestamp} ${info.level}: ${info.message}`),
    winston.format.prettyPrint()
);

export const consoleColorFormatting: winston.Logform.Format | Record<string, any> = isDevelopment() 
? { format: winston.format.combine(format, winston.format.colorize({all: true}))} : {};


//combine different transports of the same type in one transport
export const developmentTransports: winston.transports.FileTransportInstance[] = isDevelopment() 
? [
    new winston.transports.File({
        filename: 'error.log',
        dirname: 'logs/',
        level: 'error',
        handleExceptions: true
    }),

    new winston.transports.File({
        filename: 'all.log',
        dirname: 'logs/',
        handleExceptions: true
    })
] : [];


export const defaultConsoleTransport = new winston.transports.Console({... consoleColorFormatting});

export const defaultTransports: (winston.transports.FileTransportInstance | winston.transports.ConsoleTransportInstance) []= [
    ...developmentTransports,
    defaultConsoleTransport
];

function getDefaultOptions(): winston.LoggerOptions {

    return {
        level: getDefaultLevel(),
        levels: LOG_LEVELS_NUM,
        format,
        transports: defaultTransports
    }
}

export function buildDefaultLogger(): Logger {

    const logger: winston.Logger = winston.createLogger(getDefaultOptions());

    return logger;

}

export interface CustomNodeLoggerOptions extends winston.LoggerOptions {

    moduleName: string; //one of LOGGER_MODULE_NAMES 

}

/**
 * options example:
 * {
        filename: 'error.log',
        dirname: 'logs/',
        level: 'error',
        handleExceptions: true
  },
 * 
 * @param options 
 * @returns 
 */
export function buildCustomFileTransport(moduleName: string, options?: winston.transports.FileTransportOptions): 
    winston.transports.FileTransportInstance {

    if(!moduleName) {
        moduleName = LOGGER_MODULE_NAMES.ALL_COMBINED;
    }

    if(!options) {

        options = {
            filename: moduleName + '.log',
            dirname: 'logs/',
            level: getDefaultLevel(),
            handleExceptions: true
        }
    }

    return new winston.transports.File({
        ... options
    });

}
    
export class CustomNodeLogger {
    

    //safe a ref to the logger
    logger: winston.Logger;
    //save a ref to options
    loggerOptions: CustomNodeLoggerOptions;
    
    constructor(options?: CustomNodeLoggerOptions) {

        if(!options)  {
            this.logger = buildDefaultLogger();
            this.loggerOptions = {... getDefaultOptions(), moduleName: LOGGER_MODULE_NAMES.ALL_COMBINED };
            this.logger.log(LOG_LEVELS_STR.LEVEL_INFO,"Info! Calling CustomNodeLogger without any logger options, will just use defaults...");
        } else {
            this.logger = winston.createLogger({... options});
            this.loggerOptions = options;
        }
        
 
    }


    removeTransport(winston: Transport) {

        this.logger.remove(winston);
    }

    addTransport(winston: Transport) {

        this.logger.add(winston);
    }

    getTransports(): Array<Transport> {
        return this.logger.transports;
    }

    getLogger(): winston.Logger {
        return this.logger;
    }

    //should correspond also to filename when logging to a file
    getModuleName(): string {
        return this.loggerOptions.moduleName;
    }

    getLoggerLevel(): string {
        return this.loggerOptions.level;
    }

    //wrapper function for logging with custom logger
    log(level: string = LOG_LEVELS_STR.LEVEL_INFO, message: string, includeModuleName: boolean = false) {
        this.getLogger().log(level, includeModuleName ? this.buildMessage(message) : message);
    }

    logMessage(message: string, includeModuleName: boolean = false) {
        let level = this.getLoggerLevel() || getDefaultLevel();
        this.getLogger().log(level, includeModuleName ? this.buildMessage(message) : message);
    }

    //prefix the message with the module/component name (optional)
    buildMessage(message: string) {
        const cpName = this.getModuleName();
        if(cpName) {
            message = '[' + cpName.toUpperCase() + '] => ' + message;
        }
        return message;
        
    }


}


//kind of a factory function for different modules
export function getCustomLoggerForModule(moduleOrComponentName?: string, 
    logLevel?: string, 
    loggerTransports?: winston.transport | winston.transport[]): CustomNodeLogger {


    if(!moduleOrComponentName) {
        moduleOrComponentName = LOGGER_MODULE_NAMES.ALL_COMBINED;

    }

    let logger: CustomNodeLogger = new CustomNodeLogger(/*pass any custom options here*/ 
        {
            level: logLevel ? logLevel : LOG_LEVELS_STR.LEVEL_HTTP,
            levels: LOG_LEVELS_NUM,
            moduleName: moduleOrComponentName,
            defaultMeta: {component: moduleOrComponentName.toUpperCase()},
            transports: loggerTransports ? loggerTransports : [ buildCustomFileTransport(moduleOrComponentName), defaultConsoleTransport]
        }
    );
    
    return logger;
    
}









//Notes: we can write a custom transport if needed, for a specific DB access, API access, etc...
//https://github.com/winstonjs/winston-transport
//many exist already, list here: https://github.com/winstonjs/winston/blob/master/docs/transports.md