# Mediasoup to FFmpeg Pipeline Analysis

## Overview
This document analyzes the mediasoup to FFmpeg pipeline implementation and provides corrections for the identified issues.

## Pipeline Flow
```
WebRTC Client → MediaSoup Router → Plain Transport → FFmpeg → HLS Output
```

## Issues Found and Corrected

### 1. ❌ Port Configuration Mismatch (FIXED)

**Problem**: The original implementation had a critical port configuration mismatch:
- SDP was generated using MediaSoup's dynamic listening ports
- But MediaSoup was trying to connect to FFmpeg's fixed ports
- This created a bidirectional mismatch

**Original (Incorrect)**:
```typescript
// SDP used MediaSoup's ports
const videoPort = videoTransport.tuple.localPort;
const sdpString = `...m=video ${videoPort} RTP/AVP...`;

// But connected to FFmpeg's ports
await videoTransport.connect({
    ip: '127.0.0.1',
    port: ffmpegRtpVideoPort,  // Fixed port 5004
});
```

**Corrected**:
```typescript
// Connect MediaSoup TO FFmpeg's fixed ports
await videoTransport.connect({
    ip: '127.0.0.1',
    port: ffmpegRtpVideoPort,  // Fixed port 5004
    rtcpPort: ffmpegRtcpVideoPort
});

// SDP tells FFmpeg to listen on the same fixed ports
const sdpString = `...m=video ${ffmpegRtpVideoPort} RTP/AVP...`;
```

### 2. ❌ Missing RTCP Ports in SDP (FIXED)

**Problem**: The SDP didn't specify RTCP ports, which are essential for proper RTP/RTCP communication.

**Original (Incorrect)**:
```sdp
m=video 5004 RTP/AVP 96
a=rtpmap:96 VP8/90000
a=recvonly
```

**Corrected**:
```sdp
m=video 5004 RTP/AVP 96
a=rtpmap:96 VP8/90000
a=rtcp:5005
a=recvonly
```

### 3. ❌ Transport Configuration Issues (FIXED)

**Problem**: The transport configuration wasn't optimized for the MediaSoup→FFmpeg direction.

**Corrected Configuration**:
```typescript
const videoTransport = await router.createPlainTransport({
    listenIp: '127.0.0.1',
    rtcpMux: false,        // Separate RTCP ports
    comedia: false,        // MediaSoup initiates connection
    enableSrtp: false,     // No SRTP for local FFmpeg
});
```

## Corrected Pipeline Implementation

### Step 1: Create MediaSoup Plain Transports
```typescript
// Create transports that will send TO FFmpeg
const videoTransport = await router.createPlainTransport({
    listenIp: '127.0.0.1',
    rtcpMux: false,
    comedia: false,  // MediaSoup initiates connection
    enableSrtp: false,
});
```

### Step 2: Create Consumers
```typescript
// Consume from WebRTC producers
const videoConsumer = await videoTransport.consume({
    producerId: videoProducer.producer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: false
});
```

### Step 3: Connect to FFmpeg Ports
```typescript
// Connect MediaSoup TO FFmpeg's listening ports
await videoTransport.connect({
    ip: '127.0.0.1',
    port: 5004,      // FFmpeg RTP port
    rtcpPort: 5005   // FFmpeg RTCP port
});
```

### Step 4: Generate SDP for FFmpeg
```sdp
v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFMPEG
c=IN IP4 127.0.0.1
t=0 0
m=video 5004 RTP/AVP 96
a=rtpmap:96 VP8/90000
a=rtcp:5005
a=recvonly
m=audio 5006 RTP/AVP 97
a=rtpmap:97 opus/48000/2
a=rtcp:5007
a=recvonly
```

### Step 5: Start FFmpeg
```bash
ffmpeg -y \
  -protocol_whitelist file,udp,rtp \
  -f sdp -i stream.sdp \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -c:a aac -b:a 128k \
  -f hls -hls_time 2 -hls_list_size 3 \
  output.m3u8
```

## Port Configuration

| Service | RTP Port | RTCP Port | Purpose |
|---------|----------|-----------|---------|
| FFmpeg Video | 5004 | 5005 | Receive video from MediaSoup |
| FFmpeg Audio | 5006 | 5007 | Receive audio from MediaSoup |

## Data Flow

1. **WebRTC Client** sends media to MediaSoup via WebRTC transport
2. **MediaSoup Router** receives and processes the media
3. **Plain Transport** consumes the media and sends via RTP
4. **FFmpeg** receives RTP on fixed ports (5004, 5006)
5. **FFmpeg** transcodes to H.264/AAC and outputs HLS
6. **HLS Files** are served via HTTP for playback

## Testing

Run the test script to verify the pipeline configuration:
```bash
node test-pipeline.js
```

This will check:
- ✅ FFmpeg availability
- ✅ UDP port availability
- ✅ HLS output directory
- ✅ SDP generation
- ✅ FFmpeg SDP parsing

## Troubleshooting

### Common Issues

1. **Port Already in Use**
   - Check if ports 5004-5007 are available
   - Kill any existing FFmpeg processes
   - Restart the application

2. **No RTP Data Received**
   - Verify MediaSoup transports are connected
   - Check SDP payload types match
   - Ensure RTCP ports are correctly configured

3. **HLS Not Generated**
   - Check FFmpeg process is running
   - Verify HLS output directory permissions
   - Monitor FFmpeg stderr for errors

### Debug Commands

```bash
# Check if ports are in use
netstat -tulpn | grep :5004

# Monitor FFmpeg process
ps aux | grep ffmpeg

# Check HLS files
ls -la live/

# Test UDP ports
nc -u -l 5004
```

## Performance Considerations

- **Low Latency**: Use `ultrafast` preset and `zerolatency` tune
- **Bandwidth**: Adjust bitrates based on requirements
- **CPU Usage**: Monitor FFmpeg CPU usage during transcoding
- **Memory**: HLS segments consume disk space

## Security Notes

- This implementation uses localhost (127.0.0.1) for security
- No SRTP encryption for local FFmpeg communication
- Consider firewall rules for production deployment
- Validate input streams to prevent injection attacks 