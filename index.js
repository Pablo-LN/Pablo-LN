
const net = require('net');
const carrier = require('carrier');
const crypto = require('crypto');
const got = require('got');
const HttpAgent = require('agentkeepalive');

const GET_WORK_INTERVAL = 1000;
const WORKERS = 1024;
const PORT = 4444;

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

const getPoolClient = (poolName, workerName, walletAddress, numberOfWorkers) => {

    const client = got.extend({
        agent: {
            http: new HttpAgent()
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

    const getWorkerId = () => Math.floor(numberOfWorkers * Math.random()) + 1;

    return {
        getWork: async () => {
            const { body } = await client.post(`${walletAddress}/${workerName}_Worker${getWorkerId()}`, {
                json: {
                    id: 1,
                    jsonrpc: '2.0',
                    method: 'mib_getWork'
                }
            });
            if (body.error) {
                throw body.error;
            }
            return body.result;
        },

        submitWork: async (nonce, header, mix) => {
            const { body } = await client.post(`${walletAddress}/${workerName}_Worker${getWorkerId()}`, {
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

    const onSubmitLogin = (msg) => {
        const [walletAddress, extra] = msg.params;
        const x = extra.split('.');
        if (x.length !== 3) {
            send(msg.id, null, { code: -1, message: 'Wrong arguments' });
            return;
        }
        const [poolName, workerName, difficulty] = x;

        // Some random number of workers
        const hash = crypto.createHash('sha256');
        hash.update(poolName + workerName + walletAddress);
        const workers = WORKERS / (16 ** difficulty);
        const numberOfWorkers = workers + (hash.digest().readUInt32LE(0) % workers) + Math.floor(100 * Math.random()) + 1;

        client = getPoolClient(poolName, workerName, walletAddress, numberOfWorkers);

        console.log(`Login: ${poolName} / ${workerName} / ${walletAddress}, workers: ${numberOfWorkers}`);
        send(msg.id, true);
    };

    const onGetWork = (msg) => {
        if (subscribed) return;
        subscribed = true;

        let lastHeader;
        getAndSendWork((header, seed, target) => {
            if (header !== lastHeader) {
                lastHeader = header;
                target = '0x' + target.substring(2, target.length - difficulty).padStart(64, '0');
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
