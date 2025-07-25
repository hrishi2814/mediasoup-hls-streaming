const express = require('express');
import type { Request, Response } from "express";
const http = require('http');
const mediasoup = require('mediasoup');
const cors = require('cors');
const { Server } = require('socket.io');
import type { Socket } from "socket.io";
const {spawn} = require('child_process');
const path = require('path');
const FFMPEG_PROCESS_MAP = new Map();
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ["http://localhost:3000","http://192.168.1.38:3000"],
        methods: ['GET', 'POST'],
    }
});

app.use(cors());
const hlsOutputPath = path.resolve('live');

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

    app.use('/hls', express.static(hlsOutputPath));
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

       socket.on('start-hls-stream', async (callback) => {
    console.log('-> Received request to start HLS stream');

    const videoProducer = producers.find(p => p.producer.kind === 'video');
    const audioProducer = producers.find(p => p.producer.kind === 'audio');

    if (!videoProducer || !audioProducer) {
        return callback({ error: 'No video or audio producers available' });
    }

    // --- Define FFMPEG's listening ports ---
    const ffmpegRtpVideoPort = 5004;
    const ffmpegRtpAudioPort = 5006;

    // --- Create PlainTransports for mediasoup to send media to FFMPEG ---
    const videoTransport = await router.createPlainTransport({
        listenIp: '127.0.0.1',
        rtcpMux: false, // Ensure separate RTCP port
    });
    // Tell mediasoup where to send the video RTP
    await videoTransport.connect({ ip: '127.0.0.1', port: ffmpegRtpVideoPort });

    const audioTransport = await router.createPlainTransport({
        listenIp: '127.0.0.1',
        rtcpMux: false,
    });
    // Tell mediasoup where to send the audio RTP
    await audioTransport.connect({ ip: '127.0.0.1', port: ffmpegRtpAudioPort });

    // --- Create consumers to pipe the media to the transports ---
    const videoConsumer = await videoTransport.consume({ producerId: videoProducer.producer.id });
    const audioConsumer = await audioTransport.consume({ producerId: audioProducer.producer.id });

    // --- Generate a simple SDP file telling FFMPEG where to listen ---
    const sdpString = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFMPEG
c=IN IP4 127.0.0.1
t=0 0
m=video ${ffmpegRtpVideoPort} RTP/AVP 101
a=rtpmap:101 VP8/90000
m=audio ${ffmpegRtpAudioPort} RTP/AVP 102
a=rtpmap:102 opus/48000/2`;

    const sdpFilePath = path.join(os.tmpdir(), 'stream.sdp');
    fs.writeFileSync(sdpFilePath, sdpString);

    // --- Spawn FFMPEG with the simplified input ---
    const ffmpeg = spawn('ffmpeg', [
        '-protocol_whitelist', 'file,udp,rtp',
        '-i', sdpFilePath,
        '-c:v', 'copy', // We can copy the video codec
        '-c:a', 'aac', '-b:a', '128k', // But we need to transcode audio
        '-hls_time', '2', '-hls_list_size', '5', '-hls_flags', 'delete_segments',
        '-f', 'hls',
        path.join(hlsOutputPath, 'output.m3u8'),
    ]);

    FFMPEG_PROCESS_MAP.set(socket.id, ffmpeg);
    
    // FFMPEG logs
    ffmpeg.stderr.on('data', (data: any) => { console.error(`ffmpeg-stderr: ${data}`); });
    ffmpeg.on('close', (code: number) => {
        console.log(`ffmpeg process exited with code ${code}`);
        videoConsumer.close();
        audioConsumer.close();
        videoTransport.close();
        audioTransport.close();
        fs.unlinkSync(sdpFilePath);
        FFMPEG_PROCESS_MAP.delete(socket.id);
    });

    callback({ streaming: true });
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

            if (FFMPEG_PROCESS_MAP.has(socket.id)) {
                    FFMPEG_PROCESS_MAP.get(socket.id).kill('SIGINT');
                    FFMPEG_PROCESS_MAP.delete(socket.id);
            }
        });
    });
}

run();