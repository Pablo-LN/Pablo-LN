
const net = require('net');
const carrier = require('carrier');
const got = require('got');
const { SocksProxyAgent } = require('socks-proxy-agent');

const GET_WORK_INTERVAL = 1000;
const PORT = 8666;

const humanHashrate = (hashes) => {
    const thresh = 1000;
    const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s', 'ZH/s', 'YH/s'];
    let u = 0;
    while (Math.abs(hashes) >= thresh && u < units.length - 1) {
        hashes /= thresh;
        ++u;
    }
    return `${hashes.toFixed(hashes >= 100 ? 0 : hashes >= 10 ? 1 : 2)} ${units[u]}`;
};

const getPoolClient = async (poolName, walletAddress) => {

    const apiClient = got.extend({
        agent: {
            https: new SocksProxyAgent({
                host: 'localhost',
                port: 9150
            })
        },
        headers: {
            'accept': '*/*',
            'charsets': 'utf-8',
            'content-Type': 'application/json',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; rv:80.0) Gecko/20100101 Firefox/80.0'
        },
        responseType: 'json',
        timeout: 2000
    });

    const poolClient = got.extend({
        agent: {
            https: new SocksProxyAgent({
                host: 'localhost',
                port: 9150
            })
        },
        decompress: false,
        headers: {
            'accept': '*/*',
            'charsets': 'utf-8',
            'content-Type': 'application/json',
            'user-agent': undefined
        },
        prefixUrl: `http://${poolName}.mibpool.com:8888`,
        responseType: 'json',
        timeout: 2000
    });

    const getWorkers = async () => {
        try {
            const { body } = await apiClient.get(`http://${poolName}.mibpool.com:8080/api/accounts/${walletAddress}`);
            return Object.entries(body.workers).filter(e => !e[1].offline).map(e => e[0]);
        }
        catch (e) {
            console.error(`http://${poolName}.mibpool.com:8080/api/accounts/${walletAddress}`, e.message);
            throw e;
        }
    };

    const workers = await getWorkers();
    const workerName = workers[Math.floor(Math.random() * workers.length)];


    console.log(`Selected worker: ${workerName}`);

    return {
        getWork: async () => {
            const { body } = await poolClient.post(`${walletAddress}/${workerName}`, {
                json: {
                    id: 1,
                    jsonrpc: '2.0',
                    method: 'mib_getWork'
                }
            });
            if (body.error) {
                throw body.error;
            }
            const [header, seed, target] = body.result;
            return [header, seed, target];
        },

        submitWork: async (nonce, header, mix) => {
            const { body } = await poolClient.post(`${walletAddress}/${workerName}`, {
                json: {
                    id: 1,
                    jsonrpc: '2.0',
                    method: 'mib_submitWork',
                    params: [nonce, header, mix]
                }
            });
            if (body.error) {
                throw body.error;
            }
            return body.result;
        }
    }
}

const server = net.createServer(conn => {
    console.log(`New client connected from ${conn.remoteAddress}`);

    let closed = false;
    let subscribed = false;
    let client;

    const send = (id, result, error) => {
        if (closed) return;
        const line = JSON.stringify({
            id,
            jsonrpc: "2.0",
            result,
            error
        });
        //console.debug(`< ${line}`);
        conn.write(line);
        conn.write('\n');
    };

    const getAndSendWork = async (cb) => {
        if (client === undefined) return;
        try {
            const [header, seed, target] = await client.getWork();
            cb(header, seed, target);
        }
        catch (e) {
            console.error('Get work:', e.message || e); // Timeout?
        }
        if (!closed) {
            setTimeout(getAndSendWork, GET_WORK_INTERVAL, cb);
        }
    };

    const onSubmitLogin = async (msg) => {
        const [walletAddress, poolName] = msg.params;

        client = await getPoolClient(poolName, walletAddress);

        console.log(`Login: ${poolName} / ${walletAddress}`);
        send(msg.id, true);
    };

    const onGetWork = (msg) => {
        if (subscribed) return;
        subscribed = true;

        let lastHeader;
        getAndSendWork((header, seed, target) => {
            if (header !== lastHeader) {
                lastHeader = header;
                send(0, [header, seed, target]);
            }
        });
    };

    const onSubmitWork = async (msg) => {
        try {
            const result = await client.submitWork(...msg.params);
            send(msg.id, result);
        }
        catch (e) {
            console.error('Submit work:', e.message || e);
            send(msg.id, null, { code: (msg.code || -1), message: (e.message || e) });
        }
    };

    const onSubmitHashrate = (msg) => {
        const [hashrate, id] = msg.params;
        console.log(`${id.substr(2, 8)}: ${humanHashrate(parseInt(hashrate.substr(2), 16))}`);
        send(msg.id, true);
    };

    carrier.carry(conn, async line => {
        let msg;
        try {
            msg = JSON.parse(line);
            if (msg.id === undefined || msg.method === undefined || msg.params === undefined) {
                console.error('Strange message:', line);
                return;
            }
        } catch (e) {
            console.error('Error parsing:', line);
            return;
        }

        //console.debug(`> ${line}`);

        switch (msg.method) {
            case "eth_submitLogin":
                onSubmitLogin(msg);
                break;
            case "eth_getWork":
                onGetWork(msg);
                break;
            case "eth_submitWork":
                onSubmitWork(msg);
                break;
            case "eth_submitHashrate":
                onSubmitHashrate(msg);
                break;
            default:
                console.error('Unknown method:', msg.method);
                break;
        }
    });

    conn.on('close', () => {
        closed = true;
        console.log(`Client ${conn.remoteAddress} disconnected`);
    });

    conn.on('error', e => console.error('Client error:', (e.message || e)));
});

server.on('error', e => console.error('Server error: ', e.message));

server.listen({ port: PORT }, () => {
    console.log(`Mib proxy started on port ${PORT}`);
});
