"use client";

import React, { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    Hls: any;
  }
}

export default function Watch() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<any>(null);
    const [streamAvailable, setStreamAvailable] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [hlsLoaded, setHlsLoaded] = useState(false);
    const [streamId, setStreamId] = useState<string | null>(null);
    const [retryCount, setRetryCount] = useState(0);

    // Dynamic URLs based on current hostname
    const getServerUrl = () => {
        const hostname = window.location.hostname;
        const port = '3003';
        
        // If we're accessing via IP address, try localhost first
        if (hostname === '192.168.1.38' || hostname === 'localhost' || hostname === '127.0.0.1') {
            return `http://localhost:${port}`;
        }
        
        // For other hosts, try the current hostname
        return `http://${hostname}:${port}`;
    };

    const HLS_URL = `${getServerUrl()}/hls/output.m3u8`;
    const API_URL = `${getServerUrl()}/api/stream-status`;

    // Debug info
    useEffect(() => {
        console.log('Watch page initialized');
        console.log('Current hostname:', window.location.hostname);
        console.log('Current location:', window.location.href);
        console.log('Server URL:', getServerUrl());
        console.log('HLS URL:', HLS_URL);
        console.log('API URL:', API_URL);
    }, []);

    useEffect(() => {
        // Load HLS.js
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
        script.onload = () => {
            console.log('HLS.js loaded successfully');
            setHlsLoaded(true);
        };
        script.onerror = () => {
            console.error('Failed to load HLS.js');
            setError('Failed to load video player');
            setLoading(false);
        };
        document.head.appendChild(script);

        return () => {
            if (hlsRef.current) {
                hlsRef.current.destroy();
            }
        };
    }, []);

    useEffect(() => {
        if (hlsLoaded) {
            checkStreamAvailability();
            const interval = setInterval(checkStreamAvailability, 2000); // Check every 2 seconds
            return () => clearInterval(interval);
        }
    }, [hlsLoaded]);

    const checkStreamAvailability = async () => {
        // Try multiple server URLs in case of network issues
        const serverUrls = [
            `http://localhost:3003`,
            `http://127.0.0.1:3003`,
            `http://192.168.1.38:3003`
        ];

        for (const serverUrl of serverUrls) {
            try {
                console.log('Checking stream availability...');
                console.log('Trying server URL:', serverUrl);
                
                const apiUrl = `${serverUrl}/api/stream-status`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000); // Shorter timeout for each attempt
                
                const response = await fetch(apiUrl, {
                    signal: controller.signal,
                    headers: {
                        'Cache-Control': 'no-cache'
                    },
                    mode: 'cors'
                });
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                console.log('Stream status:', data);
                
                // If we get here, this server URL works
                setStreamAvailable(data.available);
                setStreamId(data.streamId);
                setLoading(false);
                setRetryCount(0);
                
                // Update the URLs to use the working server
                const workingServerUrl = serverUrl;
                const workingHlsUrl = `${workingServerUrl}/hls/output.m3u8`;
                
                if (data.available && !hlsRef.current) {
                    console.log('Stream available, loading...');
                    console.log('Using HLS URL:', workingHlsUrl);
                    setTimeout(() => loadStream(workingHlsUrl), 500);
                } else if (!data.available && hlsRef.current) {
                    console.log('Stream no longer available, stopping...');
                    stopStream();
                }
                
                return; // Success, exit the loop
                
            } catch (err) {
                console.error(`Failed to connect to ${serverUrl}:`, err);
                // Continue to next URL
            }
        }
        
        // If we get here, all URLs failed
        console.error('All server URLs failed');
        setRetryCount(prev => prev + 1);
        setError('Network error - check if streaming server is running');
        setLoading(false);
    };

    const loadStream = (hlsUrl: string) => {
        if (!videoRef.current || !window.Hls || hlsRef.current) {
            console.log('Cannot load stream - missing requirements');
            return;
        }

        console.log('Loading HLS stream from:', hlsUrl);
        
        if (window.Hls.isSupported()) {
            const hls = new window.Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 30,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 5,
                debug: false // Set to true for more verbose logging
            });
            
            hlsRef.current = hls;
            hls.loadSource(hlsUrl);
            hls.attachMedia(videoRef.current);
            
            hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
                console.log('✅ HLS media attached');
            });
            
            hls.on(window.Hls.Events.MANIFEST_LOADED, () => {
                console.log('✅ HLS manifest loaded');
            });
            
            hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
                console.log('✅ HLS manifest parsed, starting playback');
                videoRef.current?.play().then(() => {
                    console.log('✅ Video playback started');
                    setError(null);
                }).catch(err => {
                    console.error('❌ Playback failed:', err);
                    setError('Playback failed - please try refreshing');
                });
            });
            
            hls.on(window.Hls.Events.LEVEL_LOADED, () => {
                console.log('✅ HLS level loaded');
            });
            
            hls.on(window.Hls.Events.FRAG_LOADED, () => {
                // Fragment loaded - stream is working
                if (error && error.includes('Stream')) {
                    setError(null);
                }
            });
            
            hls.on(window.Hls.Events.ERROR, (event: any, data: any) => {
                console.error('❌ HLS error:', data);
                
                if (data.fatal) {
                    switch (data.type) {
                        case window.Hls.ErrorTypes.NETWORK_ERROR:
                            console.log('Network error - attempting recovery');
                            hls.startLoad();
                            setError('Network error - retrying...');
                            break;
                        case window.Hls.ErrorTypes.MEDIA_ERROR:
                            console.log('Media error - attempting recovery');
                            hls.recoverMediaError();
                            setError('Media error - retrying...');
                            break;
                        default:
                            console.log('Fatal error - destroying HLS instance');
                            setError('Playback error - please refresh');
                            stopStream();
                            break;
                    }
                } else {
                    console.warn('Non-fatal HLS error:', data);
                }
            });
            
        } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
            // Native HLS support (Safari)
            console.log('Using native HLS support');
            videoRef.current.src = hlsUrl;
            videoRef.current.play().then(() => {
                console.log('✅ Native HLS playback started');
                setError(null);
            }).catch(err => {
                console.error('❌ Native HLS playback failed:', err);
                setError('Playback failed');
            });
        } else {
            setError('HLS not supported in this browser');
        }
    };

    const stopStream = () => {
        if (hlsRef.current) {
            console.log('Stopping HLS stream');
            hlsRef.current.destroy();
            hlsRef.current = null;
        }
        if (videoRef.current) {
            videoRef.current.src = '';
        }
    };

    const handleRefresh = () => {
        console.log('Manual refresh triggered');
        setError(null);
        setRetryCount(0);
        stopStream();
        checkStreamAvailability();
    };

    if (loading) {
        return (
            <div style={{ padding: '20px', textAlign: 'center' }}>
                <h1>Live Stream</h1>
                <p>Checking for stream...</p>
            </div>
        );
    }

    return (
        <div style={{ padding: '20px' }}>
            <h1>Live Stream</h1>
            
            <div style={{ marginBottom: '10px' }}>
                {streamAvailable ? (
                    <div>
                        <span style={{ color: 'green', fontSize: '18px', fontWeight: 'bold' }}>
                            🔴 LIVE
                        </span>
                        {streamId && (
                            <span style={{ marginLeft: '10px', fontSize: '12px', color: '#666' }}>
                                Stream ID: {streamId.substring(0, 8)}...
                            </span>
                        )}
                    </div>
                ) : (
                    <span style={{ color: 'gray', fontSize: '18px' }}>⚫ OFFLINE</span>
                )}
            </div>

            {error && (
                <div style={{ 
                    padding: '10px', 
                    backgroundColor: '#ffebee', 
                    border: '1px solid #f44336', 
                    borderRadius: '4px', 
                    marginBottom: '10px',
                    color: '#c62828'
                }}>
                    ⚠️ {error}
                </div>
            )}
            
            {streamAvailable ? (
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    controls
                    muted
                    style={{
                        width: '100%',
                        maxWidth: '800px',
                        height: 'auto',
                        backgroundColor: '#000',
                        borderRadius: '8px'
                    }}
                />
            ) : (
                <div style={{ 
                    width: '100%', 
                    maxWidth: '800px',
                    height: '450px', 
                    backgroundColor: '#f5f5f5', 
                    display: 'flex', 
                    flexDirection: 'column',
                    alignItems: 'center', 
                    justifyContent: 'center',
                    border: '2px dashed #ccc',
                    borderRadius: '8px',
                    color: '#666'
                }}>
                    <div style={{ fontSize: '48px', marginBottom: '10px' }}>📺</div>
                    <p style={{ margin: '0', fontSize: '16px' }}>
                        {loading ? 'Checking for stream...' : 'Waiting for stream to start...'}
                    </p>
                    <p style={{ margin: '5px 0 0 0', fontSize: '12px', color: '#999' }}>
                        Start streaming from the Stream page
                    </p>
                </div>
            )}
            
            <div style={{ marginTop: '15px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button 
                    onClick={handleRefresh}
                    style={{
                        padding: '8px 16px',
                        backgroundColor: '#2196F3',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                    }}
                >
                    🔄 Refresh
                </button>
                
                <button 
                    onClick={() => loadStream(HLS_URL)} 
                    disabled={!streamAvailable || !!hlsRef.current}
                    style={{
                        padding: '8px 16px',
                        backgroundColor: streamAvailable && !hlsRef.current ? '#4CAF50' : '#ccc',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: streamAvailable && !hlsRef.current ? 'pointer' : 'not-allowed'
                    }}
                >
                    {hlsRef.current ? '▶️ Playing' : '▶️ Load Stream'}
                </button>

                <button 
                    onClick={stopStream}
                    disabled={!hlsRef.current}
                    style={{
                        padding: '8px 16px',
                        backgroundColor: hlsRef.current ? '#f44336' : '#ccc',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: hlsRef.current ? 'pointer' : 'not-allowed'
                    }}
                >
                    ⏹️ Stop
                </button>
                
                <button 
                    onClick={checkStreamAvailability}
                    style={{
                        padding: '8px 16px',
                        backgroundColor: '#FF9800',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                    }}
                >
                    🔍 Check Status
                </button>
            </div>

            {/* Debug info (remove in production) */}
            <div style={{ 
                marginTop: '20px', 
                padding: '10px', 
                backgroundColor: '#f0f0f0', 
                borderRadius: '4px',
                fontSize: '12px',
                color: '#666'
            }}>
                <strong>Debug Info:</strong><br/>
                Stream Available: {streamAvailable ? 'Yes' : 'No'}<br/>
                HLS Loaded: {hlsLoaded ? 'Yes' : 'No'}<br/>
                Player Instance: {hlsRef.current ? 'Active' : 'None'}<br/>
                Retry Count: {retryCount}<br/>
                Stream URL: {HLS_URL}
            </div>
        </div>
    );
}