"use client";

import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import { types } from 'mediasoup-client';
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";

export default function Stream() {
    const vidref = useRef<HTMLVideoElement>(null);
    const socketRef = useRef<Socket | null>(null);
    const devref = useRef<Device | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);

    const sendTransportRef = useRef<types.Transport | null>(null);
    const recvTransportRef = useRef<types.Transport | null>(null);

    const [isStreamReady, setIsStreamReady] = useState(false);
    const [isTransportReady, setIsTransportReady] = useState(false);
    const [isProducing, setIsProducing] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());

    useEffect(() => {
        const socket = io("http://192.168.1.38:3003");
        socketRef.current = socket;

        socket.on('connect', () => {
            console.log('connected to backend');
            socket.emit('getRouterRtpCapabilities', async (routerRtpCapabilities: any) => {
                try {
                    const device = new Device();
                    await device.load({ routerRtpCapabilities });
                    devref.current = device;
                    console.log('device boi loaded');
                    
                    createSendTransport();
                    createRecvTransport();
                } catch (error) {
                    console.error('soup device error', error);
                }
            });
        });

        socket.on('new-producer', ({ producerId, socketId }) => {
            console.log(`--- New producer detected: ${producerId} from ${socketId}`);
            consumeStream(producerId, socketId);
        });

        socket.on('producer-closed', ({ producerId, socketId }) => {
            console.log(`--- Producer closed: ${producerId} from ${socketId}`);
            setRemoteStreams(prev => {
                const newMap = new Map(prev);
                newMap.delete(socketId);
                return newMap;
            });
        });

        socket.on('existing-producers', (producers: { producerId: string, socketId: string }[]) => {
            console.log('Existing producers:', producers);
            producers.forEach(({ producerId, socketId }) => consumeStream(producerId, socketId));
        });

        const createSendTransport = () => {
            if (!devref.current || !socketRef.current) return;
            socketRef.current.emit('createWebRtcTransport', { sender: true }, (params: any) => {
                if (params.error) { console.error(params.error); return; }
                
                const transport = devref.current!.createSendTransport(params);
                sendTransportRef.current = transport;
                setIsTransportReady(true);
                console.log('Send transport created, ready to produce.');

                transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                    if (!socketRef.current) return;
                    socketRef.current.emit('connectTransport', { transportId: transport.id, dtlsParameters }, ({ connected }) => {
                        if (connected) { callback(); console.log('Send transport connected.'); } 
                        else { errback(new Error('Send transport connection failed.')); }
                    });
                });

                transport.on('produce', async (parameters, callback, errback) => {
                    if (!socketRef.current) return;
                    socketRef.current.emit('createProducer', { transportId: transport.id, kind: parameters.kind, rtpParameters: parameters.rtpParameters }, ({ id }) => {
                        callback({ id });
                        console.log('Producer created');
                    });
                });
            });
        };

        const createRecvTransport = () => {
            if (!devref.current || !socketRef.current) return;
            socketRef.current.emit('createWebRtcTransport', { sender: false }, (params: any) => {
                if (params.error) { console.error(params.error); return; }

                const transport = devref.current!.createRecvTransport(params);
                recvTransportRef.current = transport;
                console.log('Receive transport created.');

                transport.on('connect', ({ dtlsParameters }, callback, errback) => {
                    if (!socketRef.current) return;
                    socketRef.current.emit('connectTransport', { transportId: transport.id, dtlsParameters }, ({ connected }) => {
                        if (connected) { callback(); console.log('Receive transport connected.'); }
                        else { errback(new Error('Receive transport connection failed.')); }
                    });
                });
            });
        };

        const consumeStream = async (producerId: string, socketId: string) => {
            if (!devref.current || !recvTransportRef.current || !socketRef.current) return;

            const rtpCapabilities = devref.current.rtpCapabilities;
            socketRef.current.emit('createConsumer', { transportId: recvTransportRef.current.id, producerId, rtpCapabilities }, async (params: any) => {
                if (params.error) { console.error('Cannot consume', params.error); return; }

                const consumer = await recvTransportRef.current!.consume({
                    id: params.id,
                    producerId: params.producerId,
                    kind: params.kind,
                    rtpParameters: params.rtpParameters,
                });
                
                socketRef.current!.emit('resumeConsumer', { consumerId: consumer.id });

                const { track } = consumer;
                setRemoteStreams(prev => {
                    const newMap = new Map(prev);
                    let stream = newMap.get(socketId);
                    if (!stream) {
                        stream = new MediaStream();
                    }
                    stream.addTrack(track);
                    newMap.set(socketId, stream);
                    return newMap;
                });
            });
        };

        async function getCameraStream() {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                localStreamRef.current = stream;
                if (vidref.current) { vidref.current.srcObject = stream; }
                setIsStreamReady(true);
            } catch (error) {
                console.error('Error accessing camera/microphone:', error);
            }
        }
        getCameraStream();

        return () => {
            // Cleanup on unmount
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(track => track.stop());
            }
            socket.disconnect();
        };
    }, []);

    const goLive = async () => {
        if (!sendTransportRef.current || !localStreamRef.current) {
            console.log('Transport or stream not ready');
            return;
        }
        setIsProducing(true);
        
        for (const track of localStreamRef.current.getTracks()) {
            try {
                await sendTransportRef.current.produce({ track });
            } catch (err) {
                console.error('Error producing track:', track.kind, err);
            }
        }
        console.log('--- All producers created ---');
    };

    const startHLSStream = () => {
        if (!socketRef.current) return;
        
        socketRef.current.emit('start-hls-stream', (response: any) => {
            if (response.error) {
                console.error('Failed to start HLS stream:', response.error);
                alert('Failed to start HLS stream: ' + response.error);
            } else {
                setIsStreaming(true);
                console.log('HLS stream started successfully');
            }
        });
    };

    const stopHLSStream = () => {
        if (!socketRef.current) return;
        
        socketRef.current.emit('stop-hls-stream', (response: any) => {
            if (response.error) {
                console.error('Failed to stop HLS stream:', response.error);
            } else {
                setIsStreaming(false);
                console.log('HLS stream stopped');
            }
        });
    };

    return (
        <div style={{ padding: '20px' }}>
            <h1>My Stream</h1>
            <div style={{ marginBottom: '20px' }}>
                <p>Stream Ready: {isStreamReady ? '✅' : '❌'}</p>
                <p>Transport Ready: {isTransportReady ? '✅' : '❌'}</p>
                <p>Producing: {isProducing ? '✅' : '❌'}</p>
                <p>HLS Streaming: {isStreaming ? '🔴 LIVE' : '❌'}</p>
            </div>
            
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <video 
                    ref={vidref} 
                    autoPlay 
                    playsInline 
                    muted 
                    style={{ width: '45%', border: '1px solid black' }} 
                />
                {Array.from(remoteStreams.values()).map((stream, index) => (
                    <video 
                        key={index} 
                        autoPlay 
                        playsInline 
                        ref={video => {
                            if (video) video.srcObject = stream;
                        }} 
                        style={{ width: '45%', border: '1px solid black' }} 
                    />
                ))}
            </div>
            
            <div style={{ display: 'flex', gap: '10px' }}>
                <button 
                    onClick={goLive} 
                    disabled={!isStreamReady || !isTransportReady || isProducing}
                >
                    {isProducing ? '● Live' : 'Go Live'}
                </button>
                
                <button 
                    onClick={startHLSStream} 
                    disabled={!isProducing || isStreaming}
                >
                    Start HLS Stream
                </button>
                
                <button 
                    onClick={stopHLSStream} 
                    disabled={!isStreaming}
                >
                    Stop HLS Stream
                </button>
            </div>

            <div>
                <ToggleGroup type="multiple">
                <ToggleGroupItem value="mute"> <MicOff className="w-4 h-4" /></ToggleGroupItem>
                <ToggleGroupItem value="video"><Video className="w-4 h-4" /></ToggleGroupItem>
                
                </ToggleGroup>
            </div>
        </div>
    );
}