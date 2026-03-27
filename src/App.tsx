import React, { useState, useEffect, useRef } from 'react';
import { Camera, StopCircle, Play, Settings, Download, Video, AlertCircle, Clock, Eye, Activity, RotateCcw, Volume2, RefreshCw, Timer } from 'lucide-react';
import { Muxer, ArrayBufferTarget } from 'webm-muxer';
import { cn } from './lib/utils';

export default function App() {
  const [isSupported, setIsSupported] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  type SessionState = 'idle' | 'running' | 'recap';
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  
  const POMODORO_TIME = 25 * 60; // 25 minutes
  const [timeLeft, setTimeLeft] = useState(POMODORO_TIME);
  const [shameScore, setShameScore] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  
  const encoderRef = useRef<any>(null); 
  const muxerRef = useRef<any>(null);
  const captureTimerRef = useRef<number | null>(null);
  const pomodoroTimerRef = useRef<number | null>(null);
  const currentFrameRef = useRef(0);

  // Constants for timelapse
  const intervalMs = 1000; // 1 frame per second
  const outputFps = 30;

  // Initialize camera and permissions
  useEffect(() => {
    if (!('VideoEncoder' in window)) {
      setIsSupported(false);
      return;
    }

    navigator.mediaDevices.getUserMedia({ video: true })
      .then(initialStream => {
        initialStream.getTracks().forEach(t => t.stop());
        return navigator.mediaDevices.enumerateDevices();
      })
      .then(devs => {
        const videoDevices = devs.filter(d => d.kind === 'videoinput');
        setDevices(videoDevices);
        if (videoDevices.length > 0) {
          setSelectedDeviceId(videoDevices[0].deviceId || 'default');
        } else {
          setSelectedDeviceId('default');
        }
      })
      .catch(err => {
        console.error("Error enumerating devices:", err);
        setError("Could not access camera devices. Please ensure permissions are granted.");
      });
  }, []);

  // Update stream when device changes
  useEffect(() => {
    if (!selectedDeviceId || !isSupported) return;
    
    let activeStream: MediaStream | null = null;
    
    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    };
    if (selectedDeviceId !== 'default') {
      videoConstraints.deviceId = selectedDeviceId;
    }

    navigator.mediaDevices.getUserMedia({ video: videoConstraints })
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

  // Shame Score Logic
  useEffect(() => {
    let shameInterval: number;
    let visibilityListener: () => void;

    if (sessionState === 'running') {
      shameInterval = window.setInterval(() => {
        if (document.hidden) {
          // HUGE penalty for tabbing away
          setShameScore(s => s + 25);
        } else {
          // Increments randomly as you work, representing the inevitable build-up of shame
          if (Math.random() < 0.2) setShameScore(s => s + 1);
        }
      }, 1000);

      visibilityListener = () => {
        if (document.hidden) {
          setShameScore(s => s + 50); // Immediate penalty for switching tabs!
        }
      };
      document.addEventListener('visibilitychange', visibilityListener);
    }

    return () => {
      if (shameInterval) clearInterval(shameInterval);
      if (visibilityListener) document.removeEventListener('visibilitychange', visibilityListener);
    };
  }, [sessionState]);

  const startSession = async () => {
    if (!videoRef.current || !stream) {
      setError("Camera not ready.");
      return;
    }

    // Play lofi stream
    if (audioRef.current) {
      audioRef.current.loop = true;
      audioRef.current.volume = 0.4;
      audioRef.current.play().catch(e => console.warn("Audio playback prevented:", e));
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
        video: { codec: 'V_VP9', width, height, frameRate: outputFps }
      });

      // @ts-ignore
      encoderRef.current = new VideoEncoder({
        output: (chunk: any, meta: any) => muxerRef.current?.addVideoChunk(chunk, meta),
        error: (e: any) => {
          console.error("VideoEncoder error:", e);
          setError(`Encoding error: ${e.message}`);
          stopSession();
        }
      });

      encoderRef.current.configure({
        codec: 'vp09.00.10.08',
        width,
        height,
        bitrate: 5_000_000,
      });

      setSessionState('running');
      setTimeLeft(POMODORO_TIME);
      setShameScore(0);
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

        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(videoRef.current, 0, 0, vw, vh, 0, 0, width, height);
        
        const timestamp = (currentFrameRef.current * 1000000) / outputFps;
        
        try {
          // @ts-ignore
          const frame = new VideoFrame(canvasRef.current, { timestamp });
          const isKeyFrame = currentFrameRef.current % outputFps === 0;
          
          encoderRef.current.encode(frame, { keyFrame: isKeyFrame });
          frame.close();
          currentFrameRef.current++;
        } catch (err) {
          console.error("Error capturing frame:", err);
        }
      };

      captureFrame(); // Capture first frame immediately
      captureTimerRef.current = window.setInterval(captureFrame, intervalMs);
      
      pomodoroTimerRef.current = window.setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            stopSession();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      
    } catch (err: any) {
      console.error("Failed to start session:", err);
      setError(`Failed to start session: ${err.message}`);
      setSessionState('idle');
    }
  };

  const stopSession = async () => {
    if (captureTimerRef.current) {
      clearInterval(captureTimerRef.current);
      captureTimerRef.current = null;
    }
    if (pomodoroTimerRef.current) {
      clearInterval(pomodoroTimerRef.current);
      pomodoroTimerRef.current = null;
    }

    if (audioRef.current) {
      audioRef.current.pause();
    }

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

    setSessionState('recap');
  };

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const currentFocusScore = Math.max(0, 100 - Math.floor(shameScore / 10));

  if (!isSupported) {
    return (
      <div className="min-h-screen bg-surface text-on-surface flex items-center justify-center p-4 font-body">
        <div className="max-w-md text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-error mx-auto" />
          <h1 className="text-2xl font-bold font-headline">Browser Not Supported</h1>
          <p className="text-on-surface-variant">Your browser does not support the required WebCodecs API.</p>
        </div>
      </div>
    );
  }

  if (sessionState === 'recap') {
    return (
      <div className="min-h-screen bg-inverse-surface text-inverse-on-surface font-body p-8 flex flex-col items-center justify-center overflow-y-auto pattern-bg">
        <div className="max-w-6xl w-full">
          <div className="text-center mb-12">
            <h1 className="text-5xl font-black font-headline text-tertiary-fixed mb-4">Session Recap</h1>
            <p className="text-xl text-inverse-primary tracking-wide">Here is what happened while you were "studying".</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            {/* Timelapse Video */}
            <div className="bg-surface-container-lowest p-4 rounded-3xl shadow-2xl relative">
              <span className="absolute -top-4 -left-4 bg-tertiary-fixed text-on-tertiary-fixed px-4 py-1 rounded-full text-xs font-bold uppercase tracking-widest shadow-lg">Evidence</span>
              {videoUrl ? (
                <div className="w-full aspect-video rounded-2xl overflow-hidden bg-black flex items-center justify-center relative group">
                  <video src={videoUrl} controls autoPlay loop className="w-full h-full object-contain" />
                  <a
                    href={videoUrl}
                    download={`pomlapse-${new Date().getTime()}.webm`}
                    className="absolute top-4 right-4 bg-black/60 backdrop-blur-md text-white p-3 rounded-full opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
                    title="Download Timelapse"
                  >
                    <Download className="w-5 h-5" />
                  </a>
                </div>
              ) : (
                <div className="w-full aspect-video rounded-2xl bg-surface-container-high flex flex-col items-center justify-center">
                  <RefreshCw className="w-12 h-12 text-on-surface-variant animate-spin mb-4" />
                  <p className="text-on-surface-variant font-headline">Compiling video evidence...</p>
                </div>
              )}
            </div>

            {/* Stats */}
            <div className="space-y-8">
              <div className="bg-surface-container-low p-8 rounded-3xl shadow-xl border-l-8 border-primary relative overflow-hidden">
                <div className="absolute top-[-20%] right-[-10%] opacity-5">
                  <Activity className="w-64 h-64" />
                </div>
                <h3 className="text-sm font-bold uppercase tracking-widest text-on-surface-variant mb-2">Focus Score</h3>
                <div className="flex items-baseline gap-4">
                  <span className={cn("text-8xl font-black font-headline", currentFocusScore > 70 ? "text-primary" : "text-error")}>
                    {currentFocusScore}
                  </span>
                  <span className="text-2xl text-on-surface-variant font-headline font-light">/ 100</span>
                </div>
                <p className="mt-4 text-on-surface-variant">
                  {currentFocusScore > 90 ? "Incredible focus." : currentFocusScore > 70 ? "Good job, but you can do better." : "You were heavily distracted. Try again."}
                </p>
              </div>

              <div className="bg-error-container text-on-error-container p-8 rounded-3xl shadow-xl relative overflow-hidden">
                <div className="absolute top-[-20%] right-[-10%] opacity-10">
                  <Eye className="w-64 h-64" />
                </div>
                <h3 className="text-sm font-bold uppercase tracking-widest text-on-error-container/80 mb-2">Accumulated Shame</h3>
                <span className="text-7xl font-black font-headline">
                  {shameScore}
                </span>
                <p className="mt-4 text-sm font-medium">Incremented when you lose window focus or look away.</p>
              </div>

              <button 
                onClick={() => {
                  setTimeLeft(POMODORO_TIME);
                  setShameScore(0);
                  setSessionState('idle');
                }}
                className="w-full py-6 bg-tertiary-fixed text-on-tertiary-fixed rounded-2xl font-black font-headline text-xl uppercase tracking-widest hover:scale-[1.02] transition-transform shadow-[0_0_40px_rgba(98,250,227,0.3)] active:scale-95 flex items-center justify-center gap-3"
              >
                <RotateCcw className="w-6 h-6" /> Restore Honor (Start over)
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface font-body text-on-surface antialiased flex flex-col items-center">
       {/* Background Lofi Audio (Royalty free stream/file) */}
       <audio ref={audioRef} src="https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3?filename=lofi-study-112191.mp3" preload="auto" />

      {/* Header */}
      <header className="w-full max-w-7xl mx-auto flex justify-between items-center px-8 py-8">
        <div className="flex items-center gap-3">
          <div className="bg-primary text-white p-2 rounded-xl">
            <Timer className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tighter text-on-surface font-headline leading-none">PomLapse</h1>
            <p className="text-on-surface-variant text-xs mt-1 font-bold uppercase tracking-widest">Focus • Record • Shame</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 bg-surface-container-high px-4 py-2 rounded-full">
            <Volume2 className="w-4 h-4 text-primary" />
            <span className="text-xs font-bold text-primary uppercase tracking-widest">Lofi Beats</span>
          </div>
        </div>
      </header>

      {/* Main Content Dashboard */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-8 pb-12 grid grid-cols-1 lg:grid-cols-12 gap-12">
        
        {/* Left Column: Pomodoro & Actions */}
        <div className="col-span-1 lg:col-span-7 flex flex-col justify-center gap-12">
          
          <div className="relative group">
            <div className={cn(
              "absolute -inset-1 rounded-[3rem] blur-2xl opacity-40 transition-all duration-1000",
              sessionState === 'running' ? "bg-error animate-pulse" : "bg-primary"
            )}></div>
            <div className="relative bg-surface-container-lowest p-16 rounded-[3rem] shadow-xl text-center border border-outline-variant/10">
              
              <div className="absolute top-8 left-0 right-0 flex justify-center">
                <div className={cn(
                  "px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-[0.3em]",
                  sessionState === 'running' ? "bg-error/10 text-error" : "bg-primary/10 text-primary"
                )}>
                  {sessionState === 'running' ? '• Surveillance Active' : 'Ready to Focus'}
                </div>
              </div>

              <div className="text-[9rem] md:text-[12rem] font-headline font-black text-on-surface leading-none tracking-tighter mt-8 tabular-nums">
                {formatTime(timeLeft)}
              </div>

              {sessionState === 'running' && (
                <div className="mt-4 flex flex-col items-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <p className="text-sm font-bold uppercase tracking-widest text-on-surface-variant mb-2">Shame Score</p>
                  <p className="text-6xl font-black text-error font-headline">{shameScore}</p>
                  <p className="text-xs text-on-surface-variant mt-2 max-w-xs text-center">
                    Increments dynamically. Do not switch tabs. Do not lose focus!
                  </p>
                </div>
              )}

              <div className="mt-16 relative z-10">
                {sessionState === 'idle' ? (
                  <button 
                    onClick={startSession}
                    disabled={!stream || !!error}
                    className="group relative w-full sm:w-auto px-16 py-6 rounded-full bg-primary text-white font-black font-headline text-xl uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100 shadow-[0_20px_40px_-15px_rgba(12,20,39,0.5)] overflow-hidden"
                  >
                    <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
                    <span className="relative flex items-center justify-center gap-3">
                      <Play className="w-6 h-6 fill-current" /> Start Pomodoro
                    </span>
                  </button>
                ) : (
                  <button 
                    onClick={stopSession}
                    className="w-full sm:w-auto px-16 py-6 rounded-full bg-surface-container-highest text-error font-black font-headline text-xl uppercase tracking-widest transition-all hover:bg-error hover:text-white active:scale-95 flex items-center justify-center gap-3 mx-auto"
                  >
                    <StopCircle className="w-6 h-6 fill-current" /> Surrender 
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Live Feed & Settings */}
        <div className="col-span-1 lg:col-span-5 flex flex-col gap-6">
          
          <div className="bg-surface-container-lowest p-5 rounded-3xl shadow-lg border border-outline-variant/10">
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-primary" />
                <h3 className="font-headline font-bold text-xs uppercase tracking-widest">Watcher Feed</h3>
              </div>
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  {sessionState === 'running' && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-error opacity-75"></span>}
                  <span className={cn("relative inline-flex rounded-full h-2 w-2", sessionState === 'running' ? "bg-error" : "bg-primary")}></span>
                </span>
                <span className="text-[10px] font-mono text-on-surface-variant font-bold uppercase">{sessionState === 'running' ? 'REC' : 'STANDBY'}</span>
              </div>
            </div>
            
            <div className="aspect-video bg-black rounded-2xl overflow-hidden relative border border-outline-variant/10">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover transform -scale-x-100"
              />
              <canvas ref={canvasRef} className="hidden" />
              
              {!stream && !error && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <RefreshCw className="w-8 h-8 text-white/40 animate-spin" />
                </div>
              )}

              {/* Creepy eye overlay when running */}
              {sessionState === 'running' && (
                 <div className="absolute top-4 right-4 text-white/50 animate-pulse">
                    <Eye className="w-6 h-6" />
                 </div>
              )}
            </div>

            {error && (
              <div className="mt-4 p-3 bg-error-container rounded-xl flex items-start gap-2 text-on-error-container text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="font-medium font-body leading-relaxed">{error}</p>
              </div>
            )}
          </div>

          {/* Settings Section */}
          <div className="bg-surface-container-low p-6 rounded-3xl opacity-80 hover:opacity-100 transition-opacity">
            <h3 className="text-[10px] font-black font-headline uppercase tracking-[0.2em] text-on-surface-variant mb-4">
              Hardware Setup
            </h3>
            
            <div>
              <label className="block text-[10px] font-bold text-on-surface-variant uppercase tracking-widest mb-2">
                Camera Input
              </label>
              <div className="relative">
                <select
                  disabled={sessionState === 'running'}
                  value={selectedDeviceId}
                  onChange={e => setSelectedDeviceId(e.target.value)}
                  className="w-full bg-surface-container-highest border-none rounded-xl py-3 px-4 appearance-none focus:ring-2 focus:ring-primary font-headline text-on-surface text-sm disabled:opacity-50 transition-all shadow-inner"
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
          </div>
          
        </div>
      </main>
    </div>
  );
}
