"use client"; //apparently this tells the next that it is a client component, allowing it to use browseronly apis loda lassan

import React from 'react' ;
import { useEffect, useRef } from 'react';


export default function Stream() {

    //We use useRef because we need to access the DOM element directly,but we don't want to cause a re-render when it's assigned.
  const vidref = useRef<HTMLVideoElement>(null);

  useEffect(()=>{
    
    async function getCameraStream(){
        const stream = await navigator.mediaDevices.getUserMedia({
            video:true,
            audio:true
        });

        if(vidref.current){
            vidref.current.srcObject = stream;
        }
    }
    getCameraStream();
  },[])


  return (

    <div>
        <p>Stream page</p>
              <video
        ref={vidref} // Attach the ref to the element
        autoPlay      // Start playing automatically
        playsInline   // Important for mobile browsers
        muted         // Mute your own audio to prevent feedback loops
        style={{ width: '80%', maxWidth: '600px', border: '1px solid black' }}
      />
    </div>
  )
}

