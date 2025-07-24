const express = require('express');
import type { Request, Response } from "express";
const http = require('http');
const mediasoup = require('mediasoup');
const { Server } = require('socket.io');
import type { Socket } from "socket.io";
const {spawn} = require('child_process');

const FFMPEG_PROCESS_MAP = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ["http://localhost:3000","http://192.168.1.38:3000"],
        methods: ['GET', 'POST'],
    }
});

// --- Mediasoup and room state ---
let worker: any;
let router: any;
let transports: any[] = [];
let producers: any[] = [];
let consumers: any[] = [];

async function setupSoup() {
    worker = await mediasoup.createWorker({
        logLevel: "warn",
    });

    worker.on('died', () => {
        console.error('soup boiy ded');
        setTimeout(() => process.exit(1), 2000);
    });

    const mediaCodecs = [
        {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
        },
        {
            kind: 'video',
            mimeType: 'video/VP8',
            clockRate: 90000,
            parameters: {
                'x-google-start-bitrate': 1000,
            }
        },
    ];
    router = await worker.createRouter({ mediaCodecs });
    console.log('router boi chalu');
}

async function run() {
    await setupSoup();

    app.use('/hls', express.static('live'));

    server.listen(3003, () => {
        console.log('listening on 3003');
    });

    io.on('connection', (socket: Socket) => {
        console.log(`client connected: ${socket.id}`);

        // Inform the client about any existing producers
        if (producers.length > 0) {
            const producerIds = producers.map(p => p.producer.id);
            socket.emit('existing-producers', producerIds);
        }

        socket.on('getRouterRtpCapabilities', (callback) => {
            callback(router.rtpCapabilities);
        });
        
        socket.on('createWebRtcTransport', async ({ sender }, callback) => {
            try {
                const transport = await router.createWebRtcTransport({
                    listenIps: [{ ip: '192.168.1.38', announcedIp: '192.168.1.38' }],
                    enableUdp: true,
                    enableTcp: true,
                    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
                });
                transports.push({ socketId: socket.id, transport: transport, isSender: sender });

                callback({
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                });
            } 
            catch (error) {
                console.error('Error creating transport:', error);
                callback({ error: (error as Error).message });
            }
        });

        socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
            const transportEntry = transports.find(t => t.transport.id === transportId);
            if (!transportEntry) { return; }
            await transportEntry.transport.connect({ dtlsParameters });
            callback({ connected: true });
        });

        socket.on('createProducer', async ({ transportId, kind, rtpParameters }, callback) => {
            const transportEntry = transports.find(t => t.transport.id === transportId);
            if (!transportEntry) { return; }

            const producer = await transportEntry.transport.produce({ kind, rtpParameters });
            
            producers.push({ socketId: socket.id, producer: producer });
            console.log('---producer created:', producer.id);

            socket.broadcast.emit('new-producer', { producerId: producer.id });
            callback({ id: producer.id });
        });

        socket.on('createConsumer', async ({ transportId, producerId, rtpCapabilities }, callback) => {
            try {
                const transportEntry = transports.find(t => t.transport.id === transportId);
                if (!transportEntry) { return callback({ error: 'Transport not found' }); }

                if (!router.canConsume({ producerId, rtpCapabilities })) {
                    return callback({ error: `Router cannot consume producer: ${producerId}` });
                }

                const consumer = await transportEntry.transport.consume({
                    producerId,
                    rtpCapabilities,
                    paused: true,
                });
                
                // Store the new consumer
                consumers.push({ socketId: socket.id, consumer: consumer });
                console.log('->Consumer created:', consumer.id);

                callback({
                    id: consumer.id,
                    producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                });
            } catch (error) {
                console.error('Error creating consumer:', error);
                callback({ error: (error as Error).message });
            }
        });

        // --- NEW: Client requests to resume the consumer ---
        socket.on('resumeConsumer', async ({ consumerId }) => {
            console.log('---> Resuming consumer', consumerId);
            const consumerEntry = consumers.find(c => c.consumer.id === consumerId);
            if (consumerEntry) {
                await consumerEntry.consumer.resume();
                console.log("->Consumer resumed", consumerId);
            }
        });

        // --- NEW: Clean up resources on disconnect ---
        socket.on('disconnect', () => {
            console.log(`client disconnected: ${socket.id}`);
            
            // Close and remove producers associated with this socket
            producers.filter(p => p.socketId === socket.id).forEach(p => {
                p.producer.close();
                // Notify other clients that this producer has closed
                socket.broadcast.emit('producer-closed', { producerId: p.producer.id });
            });
            producers = producers.filter(p => p.socketId !== socket.id);

            // Close and remove consumers associated with this socket
            consumers.filter(c => c.socketId === socket.id).forEach(c => c.consumer.close());
            consumers = consumers.filter(c => c.socketId !== socket.id);

            // Close and remove transports associated with this socket
            transports.filter(t => t.socketId === socket.id).forEach(t => t.transport.close());
            transports = transports.filter(t => t.socketId !== socket.id);
        });
    });
}

run();