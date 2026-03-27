import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, StopCircle, Play, Settings, Download, Video, RefreshCw, AlertCircle, Clock, Film, ZoomIn, Timer, History, BarChart2, HelpCircle, Bell } from 'lucide-react';
import { Muxer, ArrayBufferTarget } from 'webm-muxer';
import { cn } from './lib/utils';

export default function App() {
  const [isSupported, setIsSupported] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [intervalMs, setIntervalMs] = useState(1000);
  const [outputFps, setOutputFps] = useState(30);
  const [frameCount, setFrameCount] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  
  const [zoom, setZoom] = useState(1);
  const [pinchStartDist, setPinchStartDist] = useState<number | null>(null);
  const [pinchStartZoom, setPinchStartZoom] = useState(1);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const encoderRef = useRef<any>(null); // Using any to avoid TS errors if VideoEncoder is not typed
  const muxerRef = useRef<any>(null);
  const timerRef = useRef<number | null>(null);
  const currentFrameRef = useRef(0);
  const zoomRef = useRef(1);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    if (!('VideoEncoder' in window)) {
      setIsSupported(false);
      return;
    }

    navigator.mediaDevices.enumerateDevices()
      .then(devs => {
        const videoDevices = devs.filter(d => d.kind === 'videoinput');
        setDevices(videoDevices);
        if (videoDevices.length > 0) {
          setSelectedDeviceId(videoDevices[0].deviceId);
        }
      })
      .catch(err => {
        console.error("Error enumerating devices:", err);
        setError("Could not access camera devices. Please ensure permissions are granted.");
      });
  }, []);

  useEffect(() => {
    if (!selectedDeviceId || !isSupported) return;
    
    let activeStream: MediaStream | null = null;
    
    navigator.mediaDevices.getUserMedia({
      video: { 
        deviceId: selectedDeviceId,
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    })
    .then(s => {
      activeStream = s;
      setStream(s);
      if (videoRef.current) {
        videoRef.current.srcObject = s;
      }
      setError(null);
    })
    .catch(err => {
      console.error("Error accessing camera:", err);
      setError("Could not access the selected camera. Please check permissions.");
    });

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [selectedDeviceId, isSupported]);

  const startRecording = async () => {
    if (!videoRef.current || !stream) {
      setError("Camera not ready.");
      return;
    }

    try {
      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack.getSettings();
      const width = settings.width || 1280;
      const height = settings.height || 720;

      if (canvasRef.current) {
        canvasRef.current.width = width;
        canvasRef.current.height = height;
      }

      muxerRef.current = new Muxer({
        target: new ArrayBufferTarget(),
        video: {
          codec: 'V_VP9',
          width,
          height,
          frameRate: outputFps
        }
      });

      // @ts-ignore
      encoderRef.current = new VideoEncoder({
        output: (chunk: any, meta: any) => muxerRef.current?.addVideoChunk(chunk, meta),
        error: (e: any) => {
          console.error("VideoEncoder error:", e);
          setError(`Encoding error: ${e.message}`);
          stopRecording();
        }
      });

      encoderRef.current.configure({
        codec: 'vp09.00.10.08',
        width,
        height,
        bitrate: 5_000_000,
      });

      setIsRecording(true);
      setFrameCount(0);
      currentFrameRef.current = 0;
      setVideoUrl(null);
      setError(null);

      const captureFrame = () => {
        if (!videoRef.current || !canvasRef.current || !encoderRef.current) return;
        
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        const vw = videoRef.current.videoWidth;
        const vh = videoRef.current.videoHeight;
        if (!vw || !vh) return;

        const currentZoom = zoomRef.current;
        const sWidth = vw / currentZoom;
        const sHeight = vh / currentZoom;
        const sx = (vw - sWidth) / 2;
        const sy = (vh - sHeight) / 2;

        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(videoRef.current, sx, sy, sWidth, sHeight, 0, 0, width, height);
        
        const timestamp = (currentFrameRef.current * 1000000) / outputFps;
        
        try {
          // @ts-ignore
          const frame = new VideoFrame(canvasRef.current, { timestamp });
          const isKeyFrame = currentFrameRef.current % outputFps === 0;
          
          encoderRef.current.encode(frame, { keyFrame: isKeyFrame });
          frame.close();
          
          currentFrameRef.current++;
          setFrameCount(currentFrameRef.current);
        } catch (err) {
          console.error("Error capturing frame:", err);
        }
      };

      captureFrame();
      timerRef.current = window.setInterval(captureFrame, intervalMs);
      
    } catch (err: any) {
      console.error("Failed to start recording:", err);
      setError(`Failed to start recording: ${err.message}`);
      setIsRecording(false);
    }
  };

  const stopRecording = async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    setIsRecording(false);

    try {
      if (encoderRef.current && muxerRef.current) {
        await encoderRef.current.flush();
        muxerRef.current.finalize();
        
        const buffer = muxerRef.current.target.buffer;
        const blob = new Blob([buffer], { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        setVideoUrl(url);
        
        encoderRef.current.close();
        encoderRef.current = null;
        muxerRef.current = null;
      }
    } catch (err: any) {
      console.error("Error finalizing video:", err);
      setError(`Error finalizing video: ${err.message}`);
    }
  };

  const formatDuration = (frames: number, fps: number) => {
    const totalSeconds = frames / fps;
    const mins = Math.floor(totalSeconds / 60);
    const secs = Math.floor(totalSeconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (!isSupported) {
    return (
      <div className="min-h-screen bg-surface text-on-surface flex items-center justify-center p-4 font-body">
        <div className="max-w-md text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-error mx-auto" />
          <h1 className="text-2xl font-bold font-headline">Browser Not Supported</h1>
          <p className="text-on-surface-variant">
            Your browser does not support the WebCodecs API required for this application.
            Please use a recent version of Chrome, Edge, or Safari.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface font-body text-on-surface antialiased flex">
      {/* SideNavBar */}
      <aside className="h-screen w-64 fixed left-0 top-0 z-50 bg-primary-container flex flex-col py-10 hidden md:flex">
        <div className="px-8 mb-8">
          <h1 className="text-xl font-black text-tertiary-fixed font-headline tracking-tighter">Timelapse</h1>
        </div>
        
        <nav className="flex-1 space-y-1">
          <a href="#" className="flex items-center gap-4 text-tertiary-fixed font-semibold bg-surface-container-low/5 rounded-l-none rounded-r-full py-3 px-8 border-l-4 border-tertiary-fixed font-headline tracking-wide transition-all duration-300">
            <Video className="w-5 h-5" />
            <span>Recording</span>
          </a>
          <a href="#" className="flex items-center gap-4 text-surface-container-low/60 hover:text-white py-3 px-8 transition-all duration-300 font-headline font-light tracking-wide hover:bg-surface-container-low/10">
            <History className="w-5 h-5" />
            <span>Gallery</span>
          </a>
          <a href="#" className="flex items-center gap-4 text-surface-container-low/60 hover:text-white py-3 px-8 transition-all duration-300 font-headline font-light tracking-wide hover:bg-surface-container-low/10">
            <Settings className="w-5 h-5" />
            <span>Settings</span>
          </a>
        </nav>

        <div className="mt-auto px-8">
          <button 
            onClick={isRecording ? stopRecording : startRecording}
            disabled={!stream || !!error}
            className={cn(
              "w-full py-3 rounded-md font-headline font-bold text-sm tracking-tight active:scale-95 transition-all duration-150 shadow-lg",
              isRecording 
                ? "bg-error text-white shadow-error/20" 
                : "bg-gradient-to-br from-primary to-primary-container text-tertiary-fixed shadow-primary/10 border border-tertiary-fixed/20 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {isRecording ? 'STOP RECORDING' : 'START RECORDING'}
          </button>
          <div className="mt-8">
            <a href="#" className="flex items-center gap-4 text-surface-container-low/60 hover:text-white py-3 transition-all duration-300 font-headline font-light tracking-wide">
              <HelpCircle className="w-5 h-5" />
              <span>Support</span>
            </a>
          </div>
        </div>
      </aside>

      {/* Main Content Canvas */}
      <main className="md:ml-64 flex-1 min-h-screen flex flex-col">
        {/* TopAppBar */}
        <header className="w-full sticky top-0 z-40 bg-surface/80 backdrop-blur-md flex justify-between items-center px-6 md:px-12 py-6">
          <div>
            <h2 className="text-2xl font-bold tracking-tighter text-on-surface font-headline uppercase">Studio</h2>
            <p className="text-on-surface-variant text-xs mt-1">Capture and compile your timelapse</p>
          </div>
          <div className="flex items-center gap-6">
            {isRecording && (
              <div className="flex items-center gap-2 px-4 py-2 bg-error-container rounded-full">
                <span className="w-2 h-2 rounded-full bg-error animate-pulse"></span>
                <span className="text-xs font-bold text-on-error-container uppercase tracking-widest">Live</span>
              </div>
            )}
            <div className="flex items-center gap-4">
              <button className="text-on-surface-variant hover:bg-surface-container-low p-2 rounded-full cursor-pointer transition-colors">
                <Bell className="w-5 h-5" />
              </button>
            </div>
          </div>
        </header>

        <div className="px-6 md:px-12 py-8 max-w-7xl mx-auto w-full flex-1 flex flex-col">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start flex-1">
            
            {/* Left Column: Timer & Preview */}
            <div className="col-span-1 lg:col-span-8 space-y-8">
              
              {/* The Pulse Timer */}
              <section className="bg-gradient-to-br from-primary to-primary-container rounded-3xl p-10 md:p-16 text-center relative overflow-hidden group shadow-xl">
                <div className="absolute -top-24 -left-24 w-64 h-64 bg-tertiary-fixed/5 rounded-full blur-[100px]"></div>
                <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-tertiary-fixed/5 rounded-full blur-[100px]"></div>
                
                <div className="relative z-10 flex flex-col items-center">
                  <span className="text-tertiary-fixed/40 font-headline font-bold tracking-[0.4em] uppercase text-xs mb-8">
                    {isRecording ? 'Recording Active' : 'Ready to Record'}
                  </span>
                  
                  <div className="relative inline-block mb-12">
                    <h2 className="text-7xl md:text-[10rem] font-headline font-extrabold text-white leading-none tracking-tighter">
                      {formatDuration(frameCount, outputFps)}
                    </h2>
                    {isRecording && (
                      <div className="absolute -right-4 md:-right-12 top-1/2 -translate-y-1/2 flex flex-col gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-tertiary-fixed animate-pulse"></div>
                        <div className="w-1.5 h-1.5 rounded-full bg-white/20"></div>
                        <div className="w-1.5 h-1.5 rounded-full bg-white/20"></div>
                      </div>
                    )}
                  </div>
                  
                  <div className="flex items-center gap-6">
                    {!isRecording ? (
                      <button 
                        onClick={startRecording}
                        disabled={!stream || !!error}
                        className="group relative flex items-center justify-center w-20 h-20 rounded-full bg-tertiary-fixed text-primary transition-all active:scale-95 shadow-[0_0_40px_rgba(98,250,227,0.2)] disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Play className="w-8 h-8 ml-1" fill="currentColor" />
                      </button>
                    ) : (
                      <button 
                        onClick={stopRecording}
                        className="group relative flex items-center justify-center w-20 h-20 rounded-full bg-error text-white transition-all active:scale-95 shadow-[0_0_40px_rgba(186,26,26,0.2)]"
                      >
                        <StopCircle className="w-8 h-8" fill="currentColor" />
                      </button>
                    )}
                  </div>
                </div>
              </section>

              {/* Recording Preview Section */}
              <section className="bg-surface-container-lowest rounded-2xl p-6 shadow-[0_32px_32px_-12px_rgba(12,20,39,0.04)]">
                <div className="flex justify-between items-center mb-6">
                  <div className="flex items-center gap-3">
                    <Camera className="w-5 h-5 text-on-surface-variant" />
                    <h3 className="font-headline font-bold text-sm uppercase tracking-widest text-on-surface">Live Feed</h3>
                  </div>
                  <span className="text-[10px] font-mono text-on-surface-variant px-2 py-1 bg-surface-container-low rounded">
                    {frameCount} FRAMES
                  </span>
                </div>
                
                <div className="aspect-video rounded-xl overflow-hidden bg-primary-container relative group">
                  <div 
                    className="w-full h-full touch-none"
                    onWheel={(e) => {
                      const newZoom = Math.min(Math.max(zoom - e.deltaY * 0.005, 1), 5);
                      setZoom(newZoom);
                    }}
                    onTouchStart={(e) => {
                      if (e.touches.length === 2) {
                        const dist = Math.hypot(
                          e.touches[0].clientX - e.touches[1].clientX,
                          e.touches[0].clientY - e.touches[1].clientY
                        );
                        setPinchStartDist(dist);
                        setPinchStartZoom(zoom);
                      }
                    }}
                    onTouchMove={(e) => {
                      if (e.touches.length === 2 && pinchStartDist !== null) {
                        const dist = Math.hypot(
                          e.touches[0].clientX - e.touches[1].clientX,
                          e.touches[0].clientY - e.touches[1].clientY
                        );
                        const scale = dist / pinchStartDist;
                        setZoom(Math.min(Math.max(pinchStartZoom * scale, 1), 5));
                      }
                    }}
                    onTouchEnd={() => setPinchStartDist(null)}
                  >
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
                      className={cn(
                        "w-full h-full object-cover transition-opacity duration-300",
                        videoUrl ? "opacity-0" : "opacity-100"
                      )}
                    />
                    {videoUrl && (
                      <video
                        src={videoUrl}
                        controls
                        className="absolute inset-0 w-full h-full object-cover z-10"
                      />
                    )}
                    
                    <canvas ref={canvasRef} className="hidden" />

                    {!stream && !error && (
                      <div className="absolute inset-0 flex items-center justify-center text-surface-container-low/50">
                        <RefreshCw className="w-8 h-8 animate-spin" />
                      </div>
                    )}
                  </div>
                  
                  {isRecording && (
                    <div className="absolute bottom-4 right-4 flex gap-2 z-20 pointer-events-none">
                      <span className="px-2 py-1 bg-black/40 backdrop-blur-md rounded text-[9px] text-white uppercase tracking-widest">
                        Capturing
                      </span>
                    </div>
                  )}
                </div>

                {error && (
                  <div className="mt-4 p-4 bg-error-container rounded-lg flex items-start gap-3 text-on-error-container">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <p className="text-sm font-medium">{error}</p>
                  </div>
                )}
              </section>

              {/* Output Actions */}
              {videoUrl && !isRecording && (
                <section className="bg-tertiary-container text-on-tertiary-container rounded-2xl p-6 flex items-center justify-between shadow-lg">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest font-bold mb-1 text-tertiary-fixed">Compilation Complete</p>
                    <p className="text-lg font-headline font-medium">Your timelapse is ready</p>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setVideoUrl(null)}
                      className="px-4 py-2 rounded-lg text-sm font-bold text-tertiary-fixed hover:bg-white/5 transition-colors"
                    >
                      Clear
                    </button>
                    <a
                      href={videoUrl}
                      download={`timelapse-${new Date().getTime()}.webm`}
                      className="bg-tertiary-fixed text-on-tertiary-fixed px-6 py-2 rounded-lg text-sm font-bold flex items-center gap-2 hover:opacity-90 transition-opacity"
                    >
                      <Download className="w-4 h-4" />
                      Download
                    </a>
                  </div>
                </section>
              )}
            </div>

            {/* Right Column: Settings */}
            <div className="col-span-1 lg:col-span-4 space-y-8">
              <div className="bg-surface-container-low rounded-3xl p-8 sticky top-28">
                <div className="mb-10">
                  <h3 className="text-xs font-bold font-headline uppercase tracking-[0.2em] text-on-surface mb-6 border-b border-outline-variant/10 pb-4">
                    Architecture
                  </h3>
                  
                  <div className="space-y-8">
                    {/* Camera Select */}
                    <div>
                      <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-3">
                        Recording Device
                      </label>
                      <div className="relative">
                        <select
                          disabled={isRecording}
                          value={selectedDeviceId}
                          onChange={e => setSelectedDeviceId(e.target.value)}
                          className="w-full bg-surface-container-highest border-none rounded-lg py-4 px-4 appearance-none focus:ring-2 focus:ring-tertiary-fixed font-headline text-primary text-sm disabled:opacity-50"
                        >
                          {devices.map(d => (
                            <option key={d.deviceId} value={d.deviceId}>
                              {d.label || `Camera ${d.deviceId.slice(0, 5)}`}
                            </option>
                          ))}
                        </select>
                        <Settings className="w-4 h-4 absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-on-surface-variant" />
                      </div>
                    </div>

                    {/* Interval Slider */}
                    <div>
                      <div className="flex justify-between items-end mb-4">
                        <label className="font-headline font-semibold text-primary">Capture Interval</label>
                        <span className="text-2xl font-headline font-light text-primary tracking-tighter">
                          {intervalMs >= 1000 ? intervalMs / 1000 : intervalMs} 
                          <span className="text-xs font-bold text-on-surface-variant uppercase tracking-widest ml-1">
                            {intervalMs >= 1000 ? 'sec' : 'ms'}
                          </span>
                        </span>
                      </div>
                      <input 
                        type="range" 
                        min="100" 
                        max="10000" 
                        step="100"
                        value={intervalMs}
                        onChange={(e) => setIntervalMs(Number(e.target.value))}
                        disabled={isRecording}
                        className="w-full h-1 bg-surface-container-high rounded-full appearance-none cursor-pointer custom-range disabled:opacity-50" 
                      />
                      <div className="flex justify-between mt-2 text-[10px] text-on-surface-variant font-bold uppercase tracking-widest">
                        <span>Fast (0.1s)</span>
                        <span>Slow (10s)</span>
                      </div>
                    </div>

                    {/* FPS Slider */}
                    <div>
                      <div className="flex justify-between items-end mb-4">
                        <label className="font-headline font-semibold text-primary">Output Framerate</label>
                        <span className="text-2xl font-headline font-light text-primary tracking-tighter">
                          {outputFps} <span className="text-xs font-bold text-on-surface-variant uppercase tracking-widest ml-1">fps</span>
                        </span>
                      </div>
                      <input 
                        type="range" 
                        min="24" 
                        max="60" 
                        step="1"
                        value={outputFps}
                        onChange={(e) => setOutputFps(Number(e.target.value))}
                        disabled={isRecording}
                        className="w-full h-1 bg-surface-container-high rounded-full appearance-none cursor-pointer custom-range disabled:opacity-50" 
                      />
                      <div className="flex justify-between mt-2 text-[10px] text-on-surface-variant font-bold uppercase tracking-widest">
                        <span>Cinematic (24)</span>
                        <span>Smooth (60)</span>
                      </div>
                    </div>

                    {/* Zoom Slider */}
                    <div>
                      <div className="flex justify-between items-end mb-4">
                        <label className="font-headline font-semibold text-primary">Digital Zoom</label>
                        <span className="text-2xl font-headline font-light text-primary tracking-tighter">
                          {zoom.toFixed(1)}<span className="text-xs font-bold text-on-surface-variant uppercase tracking-widest ml-1">x</span>
                        </span>
                      </div>
                      <input 
                        type="range" 
                        min="1" 
                        max="5" 
                        step="0.1"
                        value={zoom}
                        onChange={(e) => setZoom(parseFloat(e.target.value))}
                        className="w-full h-1 bg-surface-container-high rounded-full appearance-none cursor-pointer custom-range" 
                      />
                      <div className="flex justify-between mt-2 text-[10px] text-on-surface-variant font-bold uppercase tracking-widest">
                        <span>1x</span>
                        <span>5x</span>
                      </div>
                    </div>

                  </div>
                </div>

                <div className="bg-surface-container-lowest p-6 rounded-2xl border border-outline-variant/10">
                  <p className="text-xs italic text-on-surface-variant leading-relaxed">
                    "The shorter way to do many things is to only do one thing at a time."
                  </p>
                  <p className="text-[10px] font-bold uppercase mt-4 tracking-widest text-primary">— Mozart</p>
                </div>
              </div>
            </div>

          </div>
        </div>
        
        {/* SEO Footer */}
        <footer className="border-t border-outline-variant/10 bg-surface-container-lowest py-8 mt-auto">
          <div className="max-w-7xl mx-auto px-6 md:px-12 text-center space-y-4">
            <h2 className="text-lg font-headline font-semibold text-on-surface">Free Online Timelapse Maker</h2>
            <p className="text-sm text-on-surface-variant max-w-3xl mx-auto leading-relaxed">
              Use our free online timelapse recorder to capture stunning webcam timelapses directly in your browser. 
              No software installation, no watermarks, and completely secure—all processing happens locally on your device 
              using advanced WebCodecs technology. Perfect for 3D printing monitoring, studying, nature observation, and creative projects.
            </p>
            <div className="flex justify-center gap-4 text-xs text-on-surface-variant/60 pt-4 font-bold uppercase tracking-widest">
              <span>&copy; {new Date().getFullYear()} Timelapse Recorder</span>
              <span>•</span>
              <span>Browser-Based</span>
              <span>•</span>
              <span>Privacy First</span>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
