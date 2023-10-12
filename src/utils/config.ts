import {OceanNodeConfig} from '../@types/OceanNode'


export async function getConfig():Promise<OceanNodeConfig>{
    let port = parseInt(process.env.PORT)
    if(isNaN(port))
        port=8000

    const config:OceanNodeConfig = {
        hasIndexer:true,
        hasHttp: true,
        hasP2P:true,
        hasProvider:true,
        httpPort: port,
        dbConfig: {
            dbname:'oceannode',
            host:'127.0.0.1',
            user: 'oceannode',
            pwd: 'oceannode'
        },
        pk:process.env.PRIVATE_KEY
    }
    return(config)
}