import _ from 'lodash';

const config_file = process.env.CONFIG_FILE || '/etc/dns-proxy/config.json';

let loadedConfig = {};
try {
    loadedConfig = require(config_file);
} catch (e) {
    console.warn(`Failed loading config file (${config_file})`);
}

export default _.defaults(
    {
        port: process.env.PORT,
        host: process.env.HOST
    },
    loadedConfig,
    {
        port: 53,
        host: '0.0.0.0',
        servers: []
    }
)