"use client";

import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { io, Socket } from "socket.io-client";

export default function WatchPage() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const socketRef = useRef<Socket | null>(null);
    
    // State to control the UI
    const [isConnecting, setIsConnecting] = useState(false);

    // This function will now be called by the button
    const startStream = () => {
        setIsConnecting(true);
        if (socketRef.current && socketRef.current.connected) {
            console.log("Requesting HLS stream to start...");
            socketRef.current.emit('start-hls-stream', (response: any) => {
                if (response.error) {
                    console.error('Error starting HLS stream:', response.error);
                    setIsConnecting(false); // Allow retry
                } else {
                    console.log('HLS stream started successfully. Player will now load.');
                    loadPlayer();
                }
            });
        }
    };
    
    // This function sets up the HLS.js player
    const loadPlayer = () => {
        const video = videoRef.current;
        if (!video) return;

        const hlsUrl = `http://192.168.1.38:3000/hls/output.m3u8`; // Use your Network IP

        if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().catch(e => console.error("Autoplay was prevented:", e));
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = hlsUrl;
        }
    };

    useEffect(() => {
        // Just connect the socket on load
        const socket = io("http://192.168.1.38:3003"); // Use your Network IP
        socketRef.current = socket;

        socket.on('connect', () => {
            console.log("Socket connected to server.");
        });

        return () => {
            socket.disconnect();
        };
    }, []);

    return (
        <div>
            <h1>Watching Live Stream</h1>
            <video ref={videoRef} controls muted style={{ width: '80%', maxWidth: '800px', backgroundColor: '#000' }} />
            <br />
            <button onClick={startStream} disabled={isConnecting}>
                {isConnecting ? 'Loading...' : 'Start Watching'}
            </button>
        </div>
    );
}