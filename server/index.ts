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
        //lets try if h264 can be streamed
        //meh not useful,maybe for safari
        // {
        //     kind: 'video',
        //     mimeType: 'video/H264',
        //     clockRate: 90000,
        //     parameters: {
        //         'packetization-mode': 1,
        //         'profile-level-id': '42e01f', // Baseline profile for browser compatibility
        //         'level-asymmetry-allowed': 1
        //     }
        // },
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
        console.log(Array.from(FFMPEG_PROCESS_MAP.keys()));

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
            const producerInfos = producers.map(p => ({ producerId: p.producer.id, socketId: p.socketId }));
            socket.emit('existing-producers', producerInfos);
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

            socket.broadcast.emit('new-producer', { producerId: producer.id, socketId: socket.id });
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


        socket.on('start-hls-stream', async (callback) => {
            console.log('-> Received request to start HLS stream');

            // Find up to two video and two audio producers
            const videoProducers = producers.filter(p => p.producer.kind === 'video').slice(0, 2);
            const audioProducers = producers.filter(p => p.producer.kind === 'audio').slice(0, 2);

            console.log('Video producers:', videoProducers.map(p => p.producer.id));
            console.log('Audio producers:', audioProducers.map(p => p.producer.id));

            if (videoProducers.length === 0 || audioProducers.length === 0) {
                return callback({ error: 'No video or audio producers available' });
            }

            if (FFMPEG_PROCESS_MAP.has(socket.id)) {
                return callback({ error: 'Already streaming' });
            }

            try {
                // Assign unique ports for each stream
                const basePort = 5004;
                const transports = [];
                // const consumers = [];
                const consumers : any[]=[];

                let sdpMedia = '';

                // Video streams setup
                for (let i = 0; i < videoProducers.length; i++) {
                    const rtpPort = basePort + i * 2;
                    const rtcpPort = rtpPort + 1;
                    console.log(`Creating video transport for producer ${videoProducers[i].producer.id} on ports RTP:${rtpPort} RTCP:${rtcpPort}`);
                    
                    const transport = await router.createPlainTransport({
                        listenIp: '127.0.0.1',
                        rtcpMux: false,
                        comedia: false,
                        enableSrtp: false,

                        //useless as for now
                        // enableUdpSocket: true,
                        // enableTcpSocket: false,
                        // enableSctp: false,
                        // numSctpStreams: { OS: 1024, MIS: 1024 },
                        // maxSctpMessageSize: 262144,
                        // sctpSendBufferSize: 262144,
                    });
                    
                    await transport.connect({ ip: '127.0.0.1', port: rtpPort, rtcpPort });
                    
                    const consumer = await transport.consume({
                        producerId: videoProducers[i].producer.id,
                        rtpCapabilities: router.rtpCapabilities,
                        paused: false
                    });
                    
                    const pt = consumer.rtpParameters.codecs[0].payloadType;
                    console.log(`Video consumer for producer ${videoProducers[i].producer.id} created with payload type ${pt}`);
                    await consumer.resume();
                    console.log(`Video consumer for producer ${videoProducers[i].producer.id} resumed`);
                    
                    // Add video media to SDP
                    sdpMedia += `m=video ${rtpPort} RTP/AVP ${pt}\n`;
                    sdpMedia += `c=IN IP4 127.0.0.1\n`;
                    sdpMedia += `a=rtpmap:${pt} VP8/90000\n`;
                    sdpMedia += `a=rtcp:${rtcpPort}\n`;
                    sdpMedia += `a=recvonly\n`;
                    
                    transports.push(transport);
                    consumers.push(consumer);
                }

                // Audio streams setup
                for (let i = 0; i < audioProducers.length; i++) {
                    const rtpPort = basePort + 100 + i * 2;
                    const rtcpPort = rtpPort + 1;
                    console.log(`Creating audio transport for producer ${audioProducers[i].producer.id} on ports RTP:${rtpPort} RTCP:${rtcpPort}`);
                    
                    const transport = await router.createPlainTransport({
                        listenIp: '127.0.0.1',
                        rtcpMux: false,
                        comedia: false,
                        enableSrtp: false,
                    });
                    
                    await transport.connect({ ip: '127.0.0.1', port: rtpPort, rtcpPort });
                    
                    const consumer = await transport.consume({
                        producerId: audioProducers[i].producer.id,
                        rtpCapabilities: router.rtpCapabilities,
                        paused: false
                    });
                    
                    const pt = consumer.rtpParameters.codecs[0].payloadType;
                    console.log(`Audio consumer for producer ${audioProducers[i].producer.id} created with payload type ${pt}`);
                    await consumer.resume();
                    console.log(`Audio consumer for producer ${audioProducers[i].producer.id} resumed`);
                    
                    // Add audio media to SDP
                    sdpMedia += `m=audio ${rtpPort} RTP/AVP ${pt}\n`;
                    sdpMedia += `c=IN IP4 127.0.0.1\n`;
                    sdpMedia += `a=rtpmap:${pt} opus/48000/2\n`;
                    sdpMedia += `a=rtcp:${rtcpPort}\n`;
                    sdpMedia += `a=recvonly\n`;
                    
                    transports.push(transport);
                    consumers.push(consumer);
                }

                // Create SDP file
                const sdpString = `v=0\no=- 0 0 IN IP4 127.0.0.1\ns=FFMPEG\nc=IN IP4 127.0.0.1\nt=0 0\n${sdpMedia}`;
                const sdpFilePath = path.join(os.tmpdir(), `stream_${socket.id}.sdp`);
                fs.writeFileSync(sdpFilePath, sdpString);
                console.log('Generated SDP for FFmpeg to receive:');
                console.log(sdpString);

                // Clean up any existing files first
                const streamFiles = fs.readdirSync(hlsOutputPath).filter((file: string) => 
                    file.includes(`stream_${socket.id}`)
                );
                streamFiles.forEach((file: string) => {
                    try {
                        fs.unlinkSync(path.join(hlsOutputPath, file));
                    } catch (err) {
                        console.warn('Could not delete old file:', file);
                    }
                });

                // Build the correct filter complex
                let filterComplex = '';
                
                // Video processing
                if (videoProducers.length === 1) {
                    // Single video - just scale it
                    filterComplex += '[0:v:0]scale=1280:720[vout];';

                    //trying vaapi
                    // filterComplex += '[0:v:0]scale_vaapi=1280:720[vout];';
                    
                    //2nd attempt
                    // filterComplex+='[0:v:0]scale_vaapi=w=1280:h=720:format=nv12[vout];';

                    //3rd attempt
                    // filterComplex+='[0:v:0]scale=w=1280:h=720,format=nv12,hwupload[vout];[0:a:0]anull[aout]';


                } else if (videoProducers.length === 2) {
                    // Two videos side by side - FIXED LAYOUT
                    filterComplex += '[0:v:0]scale=640:720[v0];';
                    filterComplex += '[0:v:1]scale=640:720[v1];';
                    //
                    filterComplex += '[v0][v1]hstack=inputs=2[vout];';
                    //trying vaapi
                    // filterComplex += '[0:v:0]scale_vaapi=640:720[v0];';
                    // filterComplex += '[0:v:1]scale_vaapi=640:720[v1];';
                    // filterComplex += '[v0][v1]hstack=inputs=2[vout];';
                }
                
                // Audio processing
                if (audioProducers.length === 1) {
                    filterComplex += '[0:a:0]anull[aout]';
                } else if (audioProducers.length === 2) {
                    filterComplex += '[0:a:0][0:a:1]amix=inputs=2:duration=longest[aout]';
                }

                console.log('Filter complex:', filterComplex);

                // Build FFmpeg arguments - SIMPLIFIED
                const ffmpegArgs = [
                    // '-loglevel', 'debug',
                    '-y',
                    '-protocol_whitelist', 'file,udp,rtp',
                    '-analyzeduration', '10000000',
                    '-probesize', '5000000',
                    '-fflags', '+genpts+discardcorrupt+nobuffer',
                    '-err_detect', 'ignore_err',
                    //   '-reorder_queue_size', '0',
                    // //vaaapi bc
                    // '-hwaccel', 'vaapi',                    // VAAPI decode
                    // '-hwaccel_device', '/dev/dri/renderD128', // Your device
                    // '-hwaccel_output_format', 'vaapi',      // Keep in GPU memory

                    '-f', 'sdp',
                    '-i', sdpFilePath,

                    '-filter_complex', filterComplex,
                    '-map', '[vout]',
                    '-map', '[aout]',
                    
                    // Video encoding settings
                    '-c:v', 'libx264',             //this is the software encoding settings
                    '-preset', 'ultrafast',
                    '-tune', 'zerolatency',

                    // //hardware video encoding
                    // '-c:v', 'h264_qsv',           // Hardware encoder
                    // '-preset', 'fast', 
                    
                    //vaapi encoding
                    // '-c:v', 'h264_vaapi',
                    // '-profile:v', 'baseline',

                    '-level', '3.1',
                    '-pix_fmt', 'yuv420p',
                    '-g', '22',
                    '-keyint_min', '30',
                    '-sc_threshold', '0',
                    '-r', '22',
                    '-b:v', '600k',
                    '-maxrate', '600k',
                    '-bufsize', '1200k',
                    
                    // Audio encoding settings
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    '-ar', '48000',
                    '-ac', '2',

                        '-max_muxing_queue_size', '512',
                    // HLS settings
                    '-f', 'hls',
                    // '-hls_time', '4',
                    '-hls_time', '1',
                    '-hls_list_size', '3',//'5',
                    '-hls_flags', 'delete_segments+round_durations+independent_segments',
                    '-hls_segment_type', 'mpegts',
                    '-hls_allow_cache', '0',

                    path.join(hlsOutputPath, `stream_${socket.id}.m3u8`)
                ];

                console.log('Starting FFmpeg with command:');
                console.log('ffmpeg', ffmpegArgs.join(' '));

                const ffmpeg = spawn('sudo',[
                    'ionice','-c','1','-n','0',
                    'nice','-n','-10',
                    'ffmpeg', ...ffmpegArgs],
                     {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: false
                });

                //timer
                // Start a periodic keyframe request for all video consumers.
                const keyFrameInterval = setInterval(() => {
                    consumers.forEach((consumer: any) => {
                        // We add a check for 'consumer' itself for safety
                        if (consumer && consumer.kind === 'video' && !consumer.closed) {
                            // Request a keyframe from the original sender
                            consumer.requestKeyFrame()
                                .then(() => console.log(`[Keyframe] Requested for consumer ${consumer.id}`))
                                .catch((e: Error) => console.error('Keyframe request failed:', e.message));
                        }
                    });
                }, 4000); // Request a keyframe every 4 seconds.

                FFMPEG_PROCESS_MAP.set(socket.id, {
                    process: ffmpeg,
                    transports,
                    consumers,
                    sdpFilePath
                });

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

                        // Stop the periodic keyframe request timer.
                        clearInterval(processData.keyFrameInterval);

                        try {
                            processData.consumers.forEach((c: any) => c.close());
                            processData.transports.forEach((t: any) => t.close());
                            if (fs.existsSync(processData.sdpFilePath)) {
                                fs.unlinkSync(processData.sdpFilePath);
                            }
                            const hlsFiles = fs.readdirSync(hlsOutputPath).filter((file: string) => 
                                file.includes(`stream_${socket.id}`)
                            );
                            hlsFiles.forEach((file: string) => {
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
                    if (fs.existsSync(m3u8Path)) {
                        console.log('✅ HLS stream file created successfully!');
                        clearInterval(checkInterval);
                        callback({ streaming: true });
                    } else if (checkCount >= 20) {
                        console.log('❌ HLS stream file still not created after 20 seconds');
                        clearInterval(checkInterval);
                        callback({ error: 'Stream failed to start' });
                        cleanup();
                    }
                }, 1000);

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

        socket.on('getProducers', (callback) => {
            const producerInfos = producers.map(p => ({ producerId: p.producer.id, socketId: p.socketId }));
            callback(producerInfos);
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