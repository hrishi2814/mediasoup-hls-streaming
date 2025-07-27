#!/usr/bin/env node

const http = require('http');

console.log('🔍 Testing Server Connectivity\n');

const testUrls = [
    'http://localhost:3003/api/test',
    'http://localhost:3003/api/stream-status',
    'http://localhost:3003/hls/output.m3u8'
];

async function testUrl(url) {
    return new Promise((resolve) => {
        console.log(`Testing: ${url}`);
        
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                console.log(`✅ ${url} - Status: ${res.statusCode}`);
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        console.log(`   Response:`, json);
                    } catch (e) {
                        console.log(`   Response: ${data.substring(0, 100)}...`);
                    }
                }
                resolve();
            });
        });
        
        req.on('error', (err) => {
            console.error(`❌ ${url} - Error: ${err.message}`);
            resolve();
        });
        
        req.setTimeout(5000, () => {
            console.error(`❌ ${url} - Timeout`);
            req.destroy();
            resolve();
        });
    });
}

async function runTests() {
    for (const url of testUrls) {
        await testUrl(url);
        console.log(''); // Empty line for readability
    }
    
    console.log('📋 Connectivity Test Summary:');
    console.log('- If all tests pass, the server is accessible');
    console.log('- If tests fail, check if the server is running on port 3003');
    console.log('- Make sure the server is started with: npm run dev:server');
}

runTests().catch(console.error); 