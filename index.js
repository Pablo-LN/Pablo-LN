
const net = require('net');
const carrier = require('carrier');
const got = require('got');
const { SocksProxyAgent } = require('socks-proxy-agent');

const GET_WORK_INTERVAL = 1000;
const PORT = 8666;

const youAreBlacklisted = 'You are blacklisted';

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

const getApiClient = () => {

    const client = got.extend({
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
        timeout: 5000
    });

    return {
        getMightyMiners: async (pools) => {
            const miners = await Promise.all(pools.map(async pool => {
                const minHr = 1e6;
                const maxAge = 180;
                try {
                    const { body } = await client.get(`http://${pool}:8080/api/miners`);
                    return Promise.all(Object.entries(body.miners)
                        .filter(e => !e[1].offline && e[1].hr >= minHr && ((Date.now() / 1000) - e[1].lastBeat) < maxAge)
                        .map(async e => {
                            const walletAddress = e[0];
                            const { body } = await client.get(`http://${pool}:8080/api/accounts/${walletAddress}`);
                            const workers = Object.entries(body.workers).filter(e => !e[1].offline).map(e => e[0]);
                            return {
                                pool,
                                walletAddress,
                                workerName: workers[Math.floor(Math.random() * workers.length)],
                                hashrate: e[1].hr,
                            };
                        }));
                } catch (e) {
                    console.error('Error requesting', pool, e.message);
                    return [];
                }
            }));
            return miners.flat().sort((a, b) => b.hashrate - a.hashrate);
        }
    };
};

const getPoolClient = (miners) => {

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
        // prefixUrl: `http://${poolName}.mibpool.com:8888`,
        responseType: 'json',
        timeout: 5000
    });

    let minerIdx = -1;
    let lastSwitch = undefined;
    let currentMiner = undefined;

    const nextMiner = () => {
        if (lastSwitch !== undefined && (Date.now() - lastSwitch <= 10000)) {
            return;
        }
        ++minerIdx;
        if (minerIdx === miners.length) {
            process.exit();
        }
        lastSwitch = Date.now();
        currentMiner = miners[minerIdx];
        console.log(`Chosen ${currentMiner.walletAddress} @ ${currentMiner.pool} - ${humanHashrate(currentMiner.hashrate)}`);
    };

    nextMiner();

    return {
        getWork: async () => {
            const { body } = await poolClient.post(`http://${currentMiner.pool}:8888/${currentMiner.walletAddress}/${currentMiner.workerName}`, {
                json: {
                    id: 1,
                    jsonrpc: '2.0',
                    method: 'mib_getWork'
                }
            });
            if (body.error) {
                if (body.error.message === youAreBlacklisted) {
                    nextMiner();
                }
                throw body.error;
            }
            const [header, seed, target] = body.result;
            return [header, seed, target];
        },

        submitWork: async (nonce, header, mix) => {
            const { body } = await poolClient.post(`http://${currentMiner.pool}:8888/${currentMiner.walletAddress}/${currentMiner.workerName}`, {
                json: {
                    id: 1,
                    jsonrpc: '2.0',
                    method: 'mib_submitWork',
                    params: [nonce, header, mix]
                }
            });
            if (body.error) {
                if (body.error.message === youAreBlacklisted) {
                    nextMiner();
                }
                throw body.error;
            }
            return body.result;
        }
    };
};

const createServer = (miners) => {
    const server = net.createServer(conn => {
        console.log(`New client connected from ${conn.remoteAddress}`);

        let closed = false;
        let subscribed = false;
        let client;

        const send = (id, result, error) => {
            if (closed) return;
            const line = JSON.stringify({
                id,
                jsonrpc: '2.0',
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
            client = getPoolClient(miners);
            console.log('Miner logged in');
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
                case 'eth_submitLogin':
                    onSubmitLogin(msg);
                    break;
                case 'eth_getWork':
                    onGetWork(msg);
                    break;
                case 'eth_submitWork':
                    onSubmitWork(msg);
                    break;
                case 'eth_submitHashrate':
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
};


const pools = [
    'china01a.mibpool.com',
    'china02.mibpool.com',
    'chinamib.cn',
    'europe.mibpool.com',
    'europe02.mibpool.com',
    'germany.mibpool.com',
    'global01.mibpool.com',
    'global02.mibpool.com',
    'global03.mibpool.com',
    'hangzhoumib.com',
    'japan.mibpool.com',
    'kentucky.mibpool.com',
    'korea01.mibpool.com',
    'korea02.mibpool.com',
    'korea03.mibpool.com',
    'korea04.mibpool.com',
    'lasvegas.mibpool.com',
    'munchen.mibpool.com',
    'seoul.mibpool.com',
    'srilanka.mibpool.com',
    'won1.mibpool.com',
    'www.mib.yaopool.com'
];

(async () => {

    const client = getApiClient();

    const miners = await client.getMightyMiners(pools);
    miners.forEach(r => {
        console.log(`${r.pool}\t${r.workerName}\t${humanHashrate(r.hashrate)}`);
    });

    const total = miners.reduce((a, v) => a + v.hashrate, 0);
    console.log(`Total hashrate: ${humanHashrate(total)}`);

    createServer(miners);

})().catch(e => console.error(e));
