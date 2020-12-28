import dgram from 'dgram';
import packet from 'dns-packet';
import _ from 'lodash';
import config from './config';

const selectServer = domain => {
    for (const serverConfig of config.servers) {
        if (domain.endsWith(`.${serverConfig.domain}`)) {
            return serverConfig;
        }
    }
};

const proxyRequest = ({query, nameserver, port}) => new Promise((resolve, reject) => {
    const proxySocket = dgram.createSocket('udp4');
    const proxyBuffer = packet.encode(query);
    proxySocket.send(proxyBuffer, 0, proxyBuffer.length, port, nameserver, () => {
        // TODO: add timeout
    });
    proxySocket.on('error', (err) => {
        return reject(err);
    });
    proxySocket.on('message', (responseBuffer) => {
        const response = packet.decode(responseBuffer);
        proxySocket.close();
        return resolve(response);
    });
});

const server = dgram.createSocket('udp4');

server.on('error', (err) => {
    console.log(`server error:\n${err.stack}`);
});

server.on('message', (queryBuffer, rinfo) => {
    const requestId = Math.random().toString(36).substring(7);
    const query = packet.decode(queryBuffer);
    const queryDomain = query.questions?.[0]?.name;
    console.log(`${requestId} :: request for ${queryDomain} from ${rinfo.address}:${rinfo.port}`);
    const nameserverConfig = selectServer(queryDomain);
    if (!nameserverConfig) {
        console.log(`${requestId} :: No server found for ${queryDomain}`);
        const modifiedResponseBuffer = packet.encode({
            id: query.id,
            type: "response",
            flags: 0b110000011,
            rcode: "NOTZONE",
            questions: query.questions
        });
        server.send(modifiedResponseBuffer, 0, modifiedResponseBuffer.length, rinfo.port, rinfo.address);
        return;
    }

    const [nameserver, port = 53] = nameserverConfig.nameserver.split(':');
    console.log(`${requestId} :: Using ${nameserver}:${port} to resolve ${queryDomain}`);

    const localDomain = _.get(nameserverConfig, "localDomain", `.${nameserverConfig.domain}`);
    { // change url to local domain of nameserver
        const index = queryDomain.lastIndexOf(`.${nameserverConfig.domain}`);
        query.questions[0].name = queryDomain.substring(0, index) + localDomain;
    }

    return proxyRequest({query: query, nameserver, port})
        .then(response => {
            const responseDomain = response.questions[0].name;

            { // change url back to origin
                const additionalDot = localDomain.length === 0 ? "." : "";
                const index = queryDomain.lastIndexOf(`${additionalDot}${localDomain}`);
                response.questions[0].name = responseDomain.substring(0, index) + `.${nameserverConfig.domain}`;
                response.answers.forEach(answer => {
                    const answerIndex = answer.name.lastIndexOf(localDomain);
                    answer.name = answer.name.substring(0, answerIndex) + `.${nameserverConfig.domain}`;
                });
                response.authorities = [];
                response.additionals = [];
            }

            const modifiedResponseBuffer = packet.encode(response);
            server.send(modifiedResponseBuffer, 0, modifiedResponseBuffer.length, rinfo.port, rinfo.address);
        })
        .catch(err => {
            console.error(`${requestId} :: Socket Error: %s`, err);
        });
});

server.on('listening', () => {
    const address = server.address();
    console.log(`server listening ${address.address}:${address.port}`);
});

server.bind(config.port, config.host);
