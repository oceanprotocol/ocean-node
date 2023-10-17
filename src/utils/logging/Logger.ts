import winston, { Logger } from 'winston';
import * as Transport from 'winston-transport';
//import { AbstractConfigSetLevels } from 'winston/lib/winston/config';

//all the types of modules/components
export const LOGGER_MODULE_NAMES = {
    HTTP: "http.log",
    P2P: "p2p.log",
    INDEXER: "indexer.log",
    PROVIDER: "provider.log",
    DATABASE: "database.log",
    ALL_COMBINED: "all.log" 
}

//Some constants for logging
export const LEVELS = {
    'error': 0,
    'warn': 1,
    'info': 2,
    'http': 3,
    'verbose': 4,
    'debug': 5,
    'silly': 6
};

export const LOG_LEVELS = {
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
        levels: LEVELS,
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
    logLevel?: string;

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
            filename: moduleName,
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
            this.logger.log(LOG_LEVELS.LEVEL_WARN,"Warning! Calling CustomNodeLogger without any logger options, will just use defaults...");
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

    getModuleName(): string {
        return this.loggerOptions.moduleName;
    }

    getLoggerLevel(): string {
        return this.loggerOptions.logLevel;
    }


}

//kind of a factory function for different modules
export function getCustomLoggerForModule(moduleName?: string, logLevel?: string): CustomNodeLogger {

    let logger: CustomNodeLogger;

    if(!moduleName) {
        moduleName = LOGGER_MODULE_NAMES.ALL_COMBINED;
    }

    if(LOGGER_MODULE_NAMES.P2P === moduleName) {

        logger = new CustomNodeLogger(/*pass any custom options here*/ 
            {
                level: logLevel ? logLevel : LOG_LEVELS.LEVEL_HTTP,
                levels: LEVELS,
                moduleName: LOGGER_MODULE_NAMES.P2P,
                transports: [ buildCustomFileTransport(LOGGER_MODULE_NAMES.P2P),defaultConsoleTransport]
            }
        );
    }
    //TODO others

    if(!logger) {
        logger = new CustomNodeLogger();
    }
    
    return logger;


    
}









//Notes: we can write a custom transport if needed, for a specific DB access, API access, etc...
//https://github.com/winstonjs/winston-transport
//many exist already, list here: https://github.com/winstonjs/winston/blob/master/docs/transports.md