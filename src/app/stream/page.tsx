"use client";

import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import { types } from 'mediasoup-client'; // Import the types

export default function Stream() {
    // --- Refs for core objects ---
    const vidref = useRef<HTMLVideoElement>(null);
    const socketRef = useRef<Socket | null>(null);
    const devref = useRef<Device | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);

    // --- Refs for transports ---
    const sendTransportRef = useRef<types.Transport | null>(null);
    const recvTransportRef = useRef<types.Transport | null>(null);

    // --- State for UI ---
    const [isStreamReady, setIsStreamReady] = useState(false);
    const [isTransportReady, setIsTransportReady] = useState(false);
    const [isProducing, setIsProducing] = useState(false);
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
                    
                    // Create both transports after device is loaded
                    createSendTransport();
                    createRecvTransport();
                } catch (error) {
                    console.error('soup device error', error);
                }
            });
        });

        // --- Listen for new producers from other clients ---
        socket.on('new-producer', ({ producerId }) => {
            console.log(`--- New producer detected: ${producerId}`);
            consumeStream(producerId);
        });

        const createSendTransport = () => {
            if (!devref.current || !socketRef.current) return;
            socketRef.current.emit('createWebRtcTransport', { sender: true }, (params: any) => {
                if (params.error) { console.error(params.error); return; }
                
                const transport = devref.current!.createSendTransport(params);
                sendTransportRef.current = transport;
                setIsTransportReady(true); // Set ready once transport is created
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

        const consumeStream = async (producerId: string) => {
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
                const newStream = new MediaStream([track]);
                setRemoteStreams(prev => new Map(prev).set(producerId, newStream));
            });
        };

        async function getCameraStream() {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localStreamRef.current = stream;
            if (vidref.current) { vidref.current.srcObject = stream; }
            setIsStreamReady(true);
        }
        getCameraStream();

        return () => { socket.disconnect(); };
    }, []);

    const goLive = async () => {
        if (!sendTransportRef.current || !localStreamRef.current) {
            console.log('Transport or stream not ready');
            return;
        }
        setIsProducing(true);
        
        // Loop through all tracks (audio and video) and create a producer for each
        for (const track of localStreamRef.current.getTracks()) {
            try {
                await sendTransportRef.current.produce({ track });
            } catch (err) {
                console.error('Error producing track:', track.kind, err);
            }
        }
        console.log('--- All producers created ---');
    };

    return (
        <div>
            <h1>My Stream</h1>
            <div>
                <p>Stream Ready: {isStreamReady ? '✅' : '❌'}</p>
                <p>Transport Ready: {isTransportReady ? '✅' : '❌'}</p>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
                <video ref={vidref} autoPlay playsInline muted style={{ width: '45%', border: '1px solid black' }} />
                {Array.from(remoteStreams.values()).map((stream, index) => (
                    <video key={index} autoPlay playsInline ref={video => {
                        if (video) video.srcObject = stream;
                    }} style={{ width: '45%', border: '1px solid black' }} />
                ))}
            </div>
            <button onClick={goLive} disabled={!isStreamReady || !isTransportReady || isProducing}>
                {isProducing ? '● Live' : 'Go Live'}
            </button>
        </div>
    );
}