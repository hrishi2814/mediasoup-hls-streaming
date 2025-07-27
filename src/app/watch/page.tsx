"use client";

import React, { useEffect, useRef } from 'react';
import Hls from 'hls.js';

export default function Page() {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;

    if (video && Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource('http://localhost:3003/hls/output.m3u8'); 
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, function (event, data) {
        console.log('manifest loaded, found ' + data.levels.length + ' quality level(s)');
      });

      return () => {
        hls.destroy(); // Cleanup
      };
    // } else if (video && video.canPlayType('application/vnd.apple.mpegurl')) {

    }
  }, []);

  return (
    <div>
      <video
        ref={videoRef}
        controls
        style={{ width: '100%', maxWidth: '800px' }}
      />
    </div>
  );
}
