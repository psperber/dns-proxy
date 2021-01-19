import dgram from 'dgram';
import packet from 'dns-packet';
import _ from 'lodash';
import config from './config';
import ip from 'ip';

const selectServer = query => {
    const domain = query.questions?.[0]?.name;
    let ipAddr = null;
    if (domain.endsWith('.in-addr.arpa')) {
        const [p1 = 0, p2 = 0, p3 = 0, p4 = 0] = domain
            .substring(0, domain.length - 13)
            .split('.')
            .reverse();
        ipAddr = `${p1}.${p2}.${p3}.${p4}`;
    }
    for (const serverConfig of config.servers) {
        if (domain.endsWith(`.${serverConfig.domain}`)) {
            return serverConfig;
        }
        const subnet = serverConfig.subnet;
        if (ipAddr && subnet && ip.cidrSubnet(subnet).contains(ipAddr)) {
            return  serverConfig;
        }
    }
};

const processQuery = ({ query: _query, nameserverConfig }) => {
    const query = _.cloneDeep(_query);
    const domain = query.questions?.[0]?.name;
    const queryType = query.questions?.[0]?.type;
    const localDomain = nameserverConfig.localDomain ?? nameserverConfig.domain;
    const additionalDot = localDomain.length !== 0 ? "." : "";

    switch (queryType) {
        case "A": { // change url to local domain of nameserver
            const index = domain.lastIndexOf(`.${nameserverConfig.domain}`);
            query.questions[0].name = domain.substring(0, index) + `${additionalDot}${localDomain}`;
            break;
        }
        default: break;
    }

    return query;
};

const processResponse = ({ response: _response, nameserverConfig }) => {
    const response = _.cloneDeep(_response);
    const queryType = response.questions?.[0]?.type;
    const localDomain = nameserverConfig.localDomain ?? nameserverConfig.domain;
    const additionalDot = localDomain.length !== 0 ? "." : "";

    switch (queryType) {
        case "A": { // change url back to origin
            const domain = response.questions[0].name;
            const index = domain.lastIndexOf(`${additionalDot}${localDomain}`);
            response.questions[0].name = domain.substring(0, index) + `.${nameserverConfig.domain}`;
            response.answers.forEach(answer => {
                const index = answer.name.lastIndexOf(`${additionalDot}${localDomain}`);
                answer.name = answer.name.substring(0, index) + `.${nameserverConfig.domain}`;
            });
            break;
        }
        case "PTR": {
            response.answers.forEach(answer => {
                const index = answer.data.lastIndexOf(`${additionalDot}${localDomain}`);
                answer.data = answer.data.substring(0, index) + `.${nameserverConfig.domain}`;
            });
            break;
        }
        default: break;
    }
    response.authorities = [];
    response.additionals = [];

    return response;
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
    const nameserverConfig = selectServer(query);
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

    const processedQuery = processQuery({ query, nameserverConfig });
    return proxyRequest({ query: processedQuery, nameserver, port })
        .then(response => {
            const processedResponse = processResponse({ response, nameserverConfig });
            const modifiedResponseBuffer = packet.encode(processedResponse);
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
