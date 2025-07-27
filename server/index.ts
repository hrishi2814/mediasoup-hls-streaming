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

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

const hlsOutputPath = path.resolve('live');

// Create HLS directory if it doesn't exist
if (!fs.existsSync(hlsOutputPath)) {
    fs.mkdirSync(hlsOutputPath, { recursive: true });
}

// --- Mediasoup and room state ---
let worker: any;
let router: any;
let transports: any[] = [];
let producers: any[] = [];
let consumers: any[] = [];

async function setupSoup() {
    testFFmpegCapabilities();
    testUDPPorts([5004,5006,5007]);
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

    // Serve HLS files with proper CORS headers
    app.use('/hls', express.static(hlsOutputPath, {
        setHeaders: (res:any, path:any) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            if (path.endsWith('.m3u8')) {
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            }
            if (path.endsWith('.ts')) {
                res.setHeader('Content-Type', 'video/mp2t');
            }
        }
    }));
    
    // Add endpoint to check if stream is available
    app.get('/api/stream-status', (req: Request, res: Response) => {
        const activeStreams = Array.from(FFMPEG_PROCESS_MAP.keys());
        const hasActiveStream = activeStreams.length > 0;
        
        if (hasActiveStream) {
            const streamId = activeStreams[0];
            const m3u8Path = path.join(hlsOutputPath, `stream_${streamId}.m3u8`);
            const exists = fs.existsSync(m3u8Path);
            res.json({ available: exists, streamId });
        } else {
            res.json({ available: false, streamId: null });
        }
    });

    // Simple test endpoint for debugging
    app.get('/api/test', (req: Request, res: Response) => {
        res.json({ 
            status: 'ok', 
            message: 'Server is running',
            timestamp: new Date().toISOString(),
            activeStreams: Array.from(FFMPEG_PROCESS_MAP.keys())
        });
    });

    // Main HLS endpoint - serve the active stream
    app.get('/hls/output.m3u8', (req: Request, res: Response) => {
        const activeStreams = Array.from(FFMPEG_PROCESS_MAP.keys());
        
        if (activeStreams.length > 0) {
            const streamId = activeStreams[0];
            const streamPath = path.join(hlsOutputPath, `stream_${streamId}.m3u8`);
            
            if (fs.existsSync(streamPath)) {
                const content = fs.readFileSync(streamPath, 'utf8');
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                return res.send(content);
            }
        }
        
        res.status(404).json({ error: 'Stream not found' });
    });

    server.listen(3003, '0.0.0.0', () => {
        console.log('listening on 0.0.0.0:3003');
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
                    listenIps: [{ ip: '0.0.0.0', announcedIp: '192.168.1.38' }],
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

        socket.on('resumeConsumer', async ({ consumerId }) => {
            console.log('---> Resuming consumer', consumerId);
            const consumerEntry = consumers.find(c => c.consumer.id === consumerId);
            if (consumerEntry) {
                await consumerEntry.consumer.resume();
                console.log("->Consumer resumed", consumerId);
            }
        });

        // Replace your start-hls-stream handler with this debug version:

socket.on('start-hls-stream', async (callback) => {
    console.log('-> Received request to start HLS stream');

    const videoProducer = producers.find(p => p.producer.kind === 'video');
    const audioProducer = producers.find(p => p.producer.kind === 'audio');

    if (!videoProducer || !audioProducer) {
        return callback({ error: 'No video or audio producers available' });
    }

    if (FFMPEG_PROCESS_MAP.has(socket.id)) {
        return callback({ error: 'Already streaming' });
    }

    try {
        const ffmpegRtpVideoPort = 5004;
        const ffmpegRtcpVideoPort = 5005;
        const ffmpegRtpAudioPort = 5006;
        const ffmpegRtcpAudioPort = 5007;

        console.log('Creating video transport...');
        // Create plain transports for FFmpeg - MediaSoup will send TO FFmpeg
        const videoTransport = await router.createPlainTransport({
            listenIp: '127.0.0.1',
            rtcpMux: false,
            comedia: false,  // MediaSoup initiates connection
            enableSrtp: false,
        });

        console.log('Creating audio transport...');
        const audioTransport = await router.createPlainTransport({
            listenIp: '127.0.0.1',
            rtcpMux: false,
            comedia: false,  // MediaSoup initiates connection
            enableSrtp: false,
        });

        console.log('Video transport created on:', videoTransport.tuple);
        console.log('Audio transport created on:', audioTransport.tuple);

        console.log('Creating video consumer...');
        const videoConsumer = await videoTransport.consume({
            producerId: videoProducer.producer.id,
            rtpCapabilities: router.rtpCapabilities,
            paused: false
        });
        
        console.log('Creating audio consumer...');
        const audioConsumer = await audioTransport.consume({
            producerId: audioProducer.producer.id,
            rtpCapabilities: router.rtpCapabilities,
            paused: false
        });

        // Get the actual RTP parameters for SDP generation
        const videoRtpParams = videoConsumer.rtpParameters;
        const audioRtpParams = audioConsumer.rtpParameters;

        const videoPayloadType = videoRtpParams.codecs[0].payloadType;
        const audioPayloadType = audioRtpParams.codecs[0].payloadType;

        console.log('Video payload type:', videoPayloadType);
        console.log('Audio payload type:', audioPayloadType);

        // Connect MediaSoup transports TO FFmpeg's fixed ports
        console.log('Connecting video transport to FFmpeg...');
        await videoTransport.connect({
            ip: '127.0.0.1',
            port: ffmpegRtpVideoPort,
            rtcpPort: ffmpegRtcpVideoPort
        });

        console.log('Connecting audio transport to FFmpeg...');
        await audioTransport.connect({
            ip: '127.0.0.1',
            port: ffmpegRtpAudioPort,
            rtcpPort: ffmpegRtcpAudioPort
        });

        console.log('Transport connections established');
        console.log('Video transport tuple after connect:', videoTransport.tuple);
        console.log('Audio transport tuple after connect:', audioTransport.tuple);

        // Generate SDP for FFmpeg to RECEIVE on the fixed ports
        const sdpString = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFMPEG
c=IN IP4 127.0.0.1
t=0 0
m=video ${ffmpegRtpVideoPort} RTP/AVP ${videoPayloadType}
a=rtpmap:${videoPayloadType} VP8/90000
a=rtcp:${ffmpegRtcpVideoPort}
a=recvonly
m=audio ${ffmpegRtpAudioPort} RTP/AVP ${audioPayloadType}
a=rtpmap:${audioPayloadType} opus/48000/2
a=rtcp:${ffmpegRtcpAudioPort}
a=recvonly`;

        const sdpFilePath = path.join(os.tmpdir(), `stream_${socket.id}.sdp`);
        fs.writeFileSync(sdpFilePath, sdpString);
        
        console.log('Generated SDP for FFmpeg to receive:');
        console.log(sdpString);

        // Clean up any existing files first
        const streamFiles = fs.readdirSync(hlsOutputPath).filter((file:string) => 
            file.includes(`stream_${socket.id}`)
        );
        streamFiles.forEach((file:string) => {
            try {
                fs.unlinkSync(path.join(hlsOutputPath, file));
            } catch (err) {
                console.warn('Could not delete old file:', file);
            }
        });

        console.log('Starting FFmpeg process...');
        
        // Start FFmpeg to RECEIVE on the fixed ports
        const ffmpeg = spawn('ffmpeg', [
            '-y',
            '-protocol_whitelist', 'file,udp,rtp',
            '-analyzeduration', '2000000',
            '-probesize', '2000000',
            '-fflags', '+genpts',
            '-f', 'sdp',
            '-i', sdpFilePath,
            
            // Force video stream inclusion
            '-map', '0:v?',
            '-map', '0:a?',
            
            // Video encoding settings
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-profile:v', 'baseline',
            '-level', '3.1',
            '-pix_fmt', 'yuv420p',
            '-g', '30',
            '-keyint_min', '30',
            '-sc_threshold', '0',
            '-r', '30',
            '-b:v', '500k',
            '-maxrate', '750k',
            '-bufsize', '1500k',
            
            // Audio encoding settings
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '48000',
            '-ac', '2',
            
            // HLS settings
            '-f', 'hls',
            '-hls_time', '2',
            '-hls_list_size', '3',
            '-hls_flags', 'delete_segments+round_durations+independent_segments',
            '-hls_segment_type', 'mpegts',
            '-hls_start_number_source', 'epoch',
            
            path.join(hlsOutputPath, `stream_${socket.id}.m3u8`),
        ], { 
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false
        });

        FFMPEG_PROCESS_MAP.set(socket.id, {
            process: ffmpeg,
            videoTransport,
            audioTransport,
            videoConsumer,
            audioConsumer,
            sdpFilePath
        });

        // Log ALL FFmpeg output for debugging
        ffmpeg.stderr.on('data', (data: Buffer) => {
            const output = data.toString();
            console.log(`[FFMPEG]: ${output.trim()}`);
        });

        ffmpeg.stdout.on('data', (data: Buffer) => {
            console.log(`[FFMPEG-OUT]: ${data.toString().trim()}`);
        });

        ffmpeg.on('close', (code: number | null) => {
            console.log(`FFmpeg process exited with code ${code}`);
            cleanup();
        });

        ffmpeg.on('error', (error: Error) => {
            console.error('FFMPEG spawn error:', error);
            cleanup();
        });

        const cleanup = () => {
            if (FFMPEG_PROCESS_MAP.has(socket.id)) {
                const processData = FFMPEG_PROCESS_MAP.get(socket.id);
                try {
                    processData.videoConsumer.close();
                    processData.audioConsumer.close();
                    processData.videoTransport.close();
                    processData.audioTransport.close();
                    
                    if (fs.existsSync(processData.sdpFilePath)) {
                        fs.unlinkSync(processData.sdpFilePath);
                    }
                    
                    const hlsFiles = fs.readdirSync(hlsOutputPath).filter((file:string) => 
                        file.includes(`stream_${socket.id}`)
                    );
                    
                    hlsFiles.forEach((file:string) => {
                        try {
                            fs.unlinkSync(path.join(hlsOutputPath, file));
                        } catch (err) {
                            console.warn('Could not delete HLS file:', file);
                        }
                    });
                    
                } catch (err) {
                    console.error('Cleanup error:', err);
                }
                FFMPEG_PROCESS_MAP.delete(socket.id);
            }
        };

        // Wait for FFmpeg to detect streams and start processing
        let checkCount = 0;
        const checkInterval = setInterval(() => {
            checkCount++;
            const m3u8Path = path.join(hlsOutputPath, `stream_${socket.id}.m3u8`);
            
            console.log(`Check ${checkCount}: Looking for ${m3u8Path}`);
            
            if (fs.existsSync(m3u8Path)) {
                console.log('✅ HLS stream file created successfully!');
                console.log('📁 Files in live directory:', fs.readdirSync(hlsOutputPath).filter((f:any) => f.includes(socket.id)));
                console.log('🔗 Available at: /hls/output.m3u8');
                clearInterval(checkInterval);
            } else if (checkCount >= 20) { // 20 seconds
                console.log('❌ HLS stream file still not created after 20 seconds');
                console.log('📁 Files in live directory:', fs.readdirSync(hlsOutputPath).filter((f:any) => f.includes(socket.id)));
                clearInterval(checkInterval);
            }
        }, 1000);

        callback({ streaming: true });

    } catch (error) {
        console.error('Error starting HLS stream:', error);
        callback({ error: (error as Error).message });
    }
}); 

        socket.on('stop-hls-stream', (callback) => {
            if (FFMPEG_PROCESS_MAP.has(socket.id)) {
                const processData = FFMPEG_PROCESS_MAP.get(socket.id);
                processData.process.kill('SIGTERM');
                callback({ stopped: true });
            } else {
                callback({ error: 'No active stream found' });
            }
        });

        socket.on('disconnect', () => {
            console.log(`client disconnected: ${socket.id}`);
            
            // Close and remove producers associated with this socket
            producers.filter(p => p.socketId === socket.id).forEach(p => {
                p.producer.close();
                socket.broadcast.emit('producer-closed', { producerId: p.producer.id });
            });
            producers = producers.filter(p => p.socketId !== socket.id);

            // Close and remove consumers associated with this socket
            consumers.filter(c => c.socketId === socket.id).forEach(c => c.consumer.close());
            consumers = consumers.filter(c => c.socketId !== socket.id);

            // Close and remove transports associated with this socket
            transports.filter(t => t.socketId === socket.id).forEach(t => t.transport.close());
            transports = transports.filter(t => t.socketId !== socket.id);

            // Clean up FFMPEG process
            if (FFMPEG_PROCESS_MAP.has(socket.id)) {
                const processData = FFMPEG_PROCESS_MAP.get(socket.id);
                processData.process.kill('SIGTERM');
            }
        });
    });
}

run();

// Function to test FFmpeg availability and capabilities
function testFFmpegCapabilities() {
    const ffmpeg = spawn('ffmpeg', ['-version'], { stdio: ['pipe', 'pipe', 'pipe'] });
    
    ffmpeg.stdout.on('data', (data:any) => {
        console.log('FFmpeg available:', data.toString().split('\n')[0]);
    });
    
    ffmpeg.on('close', (code:any) => {
        if (code !== 0) {
            console.error('FFmpeg not available or not working properly');
        }
    });
}

// Function to verify SDP file content and format
function verifySDP(sdpFilePath: string) {
    try {
        if (fs.existsSync(sdpFilePath)) {
            const content = fs.readFileSync(sdpFilePath, 'utf8');
            console.log('Generated SDP:');
            console.log(content);
            
            // Basic SDP validation
            if (content.includes('m=video') && content.includes('m=audio')) {
                console.log('✅ SDP has both video and audio streams');
            } else {
                console.warn('⚠️ SDP may be missing video or audio streams');
            }
        } else {
            console.error('❌ SDP file not found at:', sdpFilePath);
        }
    } catch (error) {
        console.error('Error reading SDP file:', error);
    }
}

// Function to test UDP port availability
function testUDPPorts(ports: number[]) {
    const dgram = require('dgram');
    
    ports.forEach(port => {
        const socket = dgram.createSocket('udp4');
        
        socket.bind(port, '127.0.0.1', () => {
            console.log(`✅ Port ${port} is available`);
            socket.close();
        });
        
        socket.on('error', (err:any) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`❌ Port ${port} is already in use - this may cause issues with FFmpeg`);
            } else {
                console.error(`❌ Port ${port} error:`, err.message);
            }
        });
    });
}