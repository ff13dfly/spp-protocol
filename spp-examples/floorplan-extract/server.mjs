/**
 * Local dev server with API proxy
 * - Serves static files from project root
 * - Proxies /api/chat → dashscope.aliyuncs.com (avoids CORS)
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const MIME = {
    '.html': 'text/html',
    '.js':   'text/javascript',
    '.mjs':  'text/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
};

function serveStatic(req, res) {
    let filePath = path.join(PROJECT_ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (filePath.endsWith('/')) filePath += 'index.html';

    if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    if (fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
    }

    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
}

function proxyAPI(req, res) {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
        const apiReq = https.request(
            'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': req.headers['authorization'] || '',
                },
            },
            (apiRes) => {
                res.writeHead(apiRes.statusCode, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                });
                apiRes.pipe(res);
            }
        );
        apiReq.on('error', (err) => {
            res.writeHead(502);
            res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(body);
        apiReq.end();
    });
}

function findPort(start) {
    return new Promise((resolve) => {
        const s = http.createServer();
        s.listen(start, () => { s.close(() => resolve(start)); });
        s.on('error', () => resolve(findPort(start + 1)));
    });
}

const PORT = await findPort(53260);

http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }

    if (req.url === '/api/chat' && req.method === 'POST') {
        proxyAPI(req, res);
    } else {
        serveStatic(req, res);
    }
}).listen(PORT, () => {
    console.log('--------------------------------------------------');
    console.log('  Floor Plan Structure Extraction Demo');
    console.log('--------------------------------------------------');
    console.log('');
    console.log(`  http://localhost:${PORT}/spp-examples/floorplan-extract/`);
    console.log('');
    console.log('  API proxy: /api/chat → dashscope.aliyuncs.com');
    console.log('--------------------------------------------------');
});
