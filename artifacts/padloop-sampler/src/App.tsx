import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Activity, AudioLines, Download, FileAudio2, Headphones, Pause, Play, Plus, Repeat, Upload, Volume2, X } from 'lucide-react';
import { buildMidiFile, buildZip } from './lib/daw-export';
import { detectBpm, makeImpulse, renderSample, reverseBuffer, sliceBuffer, stretchBuffer } from './lib/sampler-audio';

type YouTubePlayer = {
  getCurrentTime: () => number;
  getDuration: () => number;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  destroy: () => void;
};

type YouTubeApi = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
        onError?: () => void;
      };
    },
  ) => YouTubePlayer;
  PlayerState: { PLAYING: number };
};

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApiPromise: Promise<void> | null = null;

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise<void>((resolve, reject) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      youtubeApiPromise = null;
      reject(new Error('YouTube preview could not load. Check your connection or use a local video file.'));
    };
    document.head.appendChild(script);
  });
  return youtubeApiPromise;
}

function parseYouTubeId(value: string) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0]?.match(/^[\w-]{11}$/)?.[0] ?? null;
    if (!['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) return null;
    const path = url.pathname.split('/').filter(Boolean);
    const id = url.searchParams.get('v') ?? (['embed', 'shorts', 'live'].includes(path[0] ?? '') ? path[1] : null);
    return id?.match(/^[\w-]{11}$/)?.[0] ?? null;
  } catch {
    return null;
  }
}

type Pad = {
  name: string;
  duration: number;
  buffer: AudioBuffer | null;
  bars: number[];
  loop: boolean;
  volume: number;
  triggerMode: 'one-shot' | 'gate';
  velocitySensitive: boolean;
  chokeGroup: string;
  trimStart: number;
  trimEnd: number;
  fadeIn: number;
  fadeOut: number;
  reverse: boolean;
  pitch: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  filterCutoff: number;
  distortion: number;
  probability: number;
  ratchets: number;
  flam: boolean;
  detectedBpm: number | null;
};

type PresetVoice = {
  name: string;
  kind: 'kick' | 'snare' | 'closed-hat' | 'open-hat' | 'clap' | 'rim' | 'tom' | 'perc' | '808' | 'bounce';
  frequency?: number;
  duration: number;
};

const PAD_KEYS = ['Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V', '1', '2', '3', '4'];
const padColors = ['#f1b95e', '#e88e70', '#75c9a4', '#a4a1dc', '#e9829c', '#79b9dc', '#d3a66d', '#78c8ad', '#db8d66', '#90b5da', '#b4a2d9', '#d5bd6b', '#75c6b1', '#df8e87', '#86b7dc', '#b1a0d5'];
const emptyPad = (): Pad => ({
  name: '', duration: 0, buffer: null, bars: [], loop: false, volume: 0.85,
  triggerMode: 'one-shot', velocitySensitive: true, chokeGroup: '',
  trimStart: 0, trimEnd: 1, fadeIn: 0.005, fadeOut: 0.03, reverse: false, pitch: 0,
  attack: 0.005, decay: 0.08, sustain: 0.85, release: 0.15,
  filterCutoff: 18000, distortion: 0, probability: 100, ratchets: 1, flam: false,
  detectedBpm: null,
});
const makePads = () => Array.from({ length: 16 }, emptyPad);
const makeEmptyPattern = () => Array.from({ length: 16 }, () => Array(16).fill(false) as boolean[]);
const DB_NAME = 'padloop-local-kit';
const DB_STORE = 'samples';
const KIT_STORE = 'kits';

type SavedKit = {
  name: string;
  savedAt: string;
  tempo: number;
  master: number;
  swing: number;
  quantize: number;
  effects: { reverb: number; delay: number };
  patterns: boolean[][][];
  arrangement: number[];
  pads: Array<Omit<Pad, 'buffer' | 'bars'> & { sample: Blob | null }>;
};

const BOUNCY_808_VOICES: PresetVoice[] = [
  { name: 'Punch Kick.wav', kind: 'kick', duration: 0.72 },
  { name: 'Dry Snare.wav', kind: 'snare', duration: 0.48 },
  { name: 'Closed Hat.wav', kind: 'closed-hat', duration: 0.2 },
  { name: 'Open Hat.wav', kind: 'open-hat', duration: 0.62 },
  { name: 'Clap.wav', kind: 'clap', duration: 0.48 },
  { name: 'Rim Click.wav', kind: 'rim', duration: 0.24 },
  { name: 'Low Tom.wav', kind: 'tom', frequency: 118, duration: 0.48 },
  { name: 'Perc Tick.wav', kind: 'perc', frequency: 940, duration: 0.2 },
  { name: '808 Sub C.wav', kind: '808', frequency: 65.41, duration: 1.35 },
  { name: '808 Sub A.wav', kind: '808', frequency: 55, duration: 1.35 },
  { name: '808 Sub D.wav', kind: '808', frequency: 73.42, duration: 1.25 },
  { name: '808 Sub G.wav', kind: '808', frequency: 49, duration: 1.45 },
  { name: 'Bounce Bass A.wav', kind: 'bounce', frequency: 55, duration: 0.42 },
  { name: 'Bounce Bass C.wav', kind: 'bounce', frequency: 65.41, duration: 0.42 },
  { name: 'Bounce Bass D.wav', kind: 'bounce', frequency: 73.42, duration: 0.42 },
  { name: 'Bounce Bass G.wav', kind: 'bounce', frequency: 49, duration: 0.46 },
];

function synthesizePresetVoice(audio: AudioContext, voice: PresetVoice) {
  const sampleRate = audio.sampleRate;
  const buffer = audio.createBuffer(1, Math.max(1, Math.floor(sampleRate * voice.duration)), sampleRate);
  const output = buffer.getChannelData(0);
  const baseFrequency = voice.frequency ?? 60;
  let phase = 0;
  let previousNoise = 0;
  let seed = 7619 + Math.round(baseFrequency * 17);
  const randomNoise = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 1073741823.5) - 1;
  };

  for (let index = 0; index < output.length; index++) {
    const time = index / sampleRate;
    const noise = randomNoise();
    const highNoise = noise - previousNoise;
    previousNoise = noise;
    let sample = 0;

    switch (voice.kind) {
      case 'kick': {
        const frequency = 44 + 112 * Math.exp(-time * 19);
        phase += (Math.PI * 2 * frequency) / sampleRate;
        sample = (Math.sin(phase) * Math.exp(-time * 6.8) + noise * 0.09 * Math.exp(-time * 52)) * 0.92;
        break;
      }
      case 'snare': {
        phase += (Math.PI * 2 * (190 - 34 * Math.min(time, 0.2))) / sampleRate;
        sample = noise * 0.58 * Math.exp(-time * 17) + Math.sin(phase) * 0.34 * Math.exp(-time * 9);
        break;
      }
      case 'closed-hat':
      case 'open-hat': {
        const decay = voice.kind === 'closed-hat' ? 34 : 5.4;
        sample = highNoise * 0.43 * Math.exp(-time * decay);
        break;
      }
      case 'clap': {
        const burst = [0, 0.014, 0.029, 0.047].reduce((level, onset) =>
          level + (time >= onset ? Math.exp(-(time - onset) * 52) : 0), 0);
        sample = noise * Math.min(1, burst) * 0.62 + noise * 0.13 * Math.exp(-time * 9);
        break;
      }
      case 'rim': {
        phase += (Math.PI * 2 * 1580) / sampleRate;
        sample = (Math.sin(phase) * 0.7 + noise * 0.22) * Math.exp(-time * 30);
        break;
      }
      case 'tom': {
        const frequency = baseFrequency + 70 * Math.exp(-time * 10);
        phase += (Math.PI * 2 * frequency) / sampleRate;
        sample = Math.sin(phase) * 0.72 * Math.exp(-time * 7.2) + noise * 0.08 * Math.exp(-time * 45);
        break;
      }
      case 'perc': {
        phase += (Math.PI * 2 * baseFrequency) / sampleRate;
        sample = (Math.sin(phase) * 0.58 + highNoise * 0.28) * Math.exp(-time * 26);
        break;
      }
      case '808': {
        const frequency = baseFrequency * (1 + 1.7 * Math.exp(-time * 12));
        phase += (Math.PI * 2 * frequency) / sampleRate;
        sample = Math.tanh((Math.sin(phase) + Math.sin(phase * 2) * 0.12) * 1.8) * 0.7 * Math.exp(-time * 2.45);
        break;
      }
      case 'bounce': {
        phase += (Math.PI * 2 * baseFrequency) / sampleRate;
        sample = (Math.sin(phase) + Math.sin(phase * 2) * 0.32 + Math.sin(phase * 3) * 0.13)
          * 0.43 * Math.exp(-time * 5.2) * (1 - Math.exp(-time * 90));
        break;
      }
    }

    output[index] = Math.max(-1, Math.min(1, sample));
  }
  return buffer;
}

function createBouncy808Preset(audio: AudioContext) {
  const pads = BOUNCY_808_VOICES.map((voice) => {
    const buffer = synthesizePresetVoice(audio, voice);
    return { ...emptyPad(), name: voice.name, duration: buffer.duration, buffer, bars: makeWave(buffer) };
  });
  const steps = Array.from({ length: 16 }, () => Array(16).fill(false) as boolean[]);
  const hits: [number, number[]][] = [
    [0, [0, 7, 8, 14]],
    [1, [4, 12]],
    [2, [2, 6, 10, 14]],
    [3, [14]],
    [4, [4, 12]],
    [5, [7, 15]],
    [6, [11]],
    [8, [0, 10]],
    [9, [8]],
    [10, [6, 14]],
    [11, [12]],
    [12, [0, 3, 8, 11]],
    [13, [4]],
    [14, [10, 15]],
    [15, [6]],
  ];
  hits.forEach(([pad, positions]) => positions.forEach((step) => { steps[pad][step] = true; }));
  return { pads, steps };
}

function openSampleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('Local sample storage is unavailable in this browser.'));
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
      if (!request.result.objectStoreNames.contains(KIT_STORE)) request.result.createObjectStore(KIT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local sample storage.'));
  });
}

async function listSavedKits() {
  const db = await openSampleDb();
  const names = await new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(KIT_STORE, 'readonly').objectStore(KIT_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result.map(String).sort((a, b) => a.localeCompare(b)));
    request.onerror = () => reject(request.error);
  });
  db.close();
  return names;
}

async function saveKitRecord(name: string, kit: SavedKit) {
  const db = await openSampleDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(KIT_STORE, 'readwrite').objectStore(KIT_STORE).put(kit, name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  db.close();
}

async function readKitRecord(name: string) {
  const db = await openSampleDb();
  const kit = await new Promise<SavedKit | undefined>((resolve, reject) => {
    const request = db.transaction(KIT_STORE, 'readonly').objectStore(KIT_STORE).get(name);
    request.onsuccess = () => resolve(request.result as SavedKit | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return kit ?? null;
}

async function deleteKitRecord(name: string) {
  const db = await openSampleDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(KIT_STORE, 'readwrite').objectStore(KIT_STORE).delete(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  db.close();
}

async function persistSample(index: number, file: File) {
  const db = await openSampleDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(file, index);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  db.close();
}

async function removePersistedSample(index: number) {
  try {
    const db = await openSampleDb();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(index);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch { /* Removing a sample from the live kit should still work without IndexedDB. */ }
}

async function restoreSamples(context: AudioContext) {
  const db = await openSampleDb();
  const tx = db.transaction(DB_STORE, 'readonly');
  const store = tx.objectStore(DB_STORE);
  const [keys, files] = await Promise.all([
    new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),
    new Promise<Blob[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),
  ]);
  const result: { index: number; pad: Pad }[] = [];
  for (let position = 0; position < keys.length; position++) {
    const key = keys[position];
    const file = files[position];
    try {
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      result.push({ index: Number(key), pad: { ...emptyPad(), name: file instanceof File ? file.name : `sample-${Number(key) + 1}.wav`, duration: buffer.duration, buffer, bars: makeWave(buffer) } });
    } catch { /* A stale or unsupported local file is skipped safely. */ }
  }
  db.close();
  return result;
}

function makeWave(buffer: AudioBuffer) {
  const channel = buffer.getChannelData(0);
  const bars: number[] = [];
  const stride = Math.max(1, Math.floor(channel.length / 42));
  for (let i = 0; i < 42; i++) {
    let peak = 0;
    for (let j = i * stride; j < Math.min(channel.length, (i + 1) * stride); j++) peak = Math.max(peak, Math.abs(channel[j]));
    bars.push(Math.max(13, Math.round(peak * 100)));
  }
  return bars;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

function encodeWav(buffer: AudioBuffer) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const sampleCount = buffer.length;
  const dataSize = sampleCount * channels * 2;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, dataSize, true);
  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let i = 0; i < sampleCount; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][i]));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
  }
  return new Blob([output], { type: 'audio/wav' });
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function App() {
  const [pads, setPads] = useState<Pad[]>(makePads);
  const [patterns, setPatterns] = useState<boolean[][][]>(() => Array.from({ length: 4 }, makeEmptyPattern));
  const [currentPattern, setCurrentPattern] = useState(0);
  const [arrangement, setArrangement] = useState([0, 1, 0, 1]);
  const [selected, setSelected] = useState(0);
  const [tempo, setTempo] = useState(96);
  const [master, setMaster] = useState(.8);
  const [swing, setSwing] = useState(0);
  const [quantize, setQuantize] = useState(1);
  const [recordMode, setRecordMode] = useState(false);
  const [songPlaying, setSongPlaying] = useState(false);
  const [effects, setEffects] = useState({ reverb: 0.08, delay: 0.04 });
  const [playing, setPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [ready, setReady] = useState(false);
  const [activePads, setActivePads] = useState<Set<number>>(() => new Set());
  const [kitName, setKitName] = useState('My kit');
  const [savedKits, setSavedKits] = useState<string[]>([]);
  const [selectedKit, setSelectedKit] = useState('');
  const [sliceCount, setSliceCount] = useState(8);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeId, setYoutubeId] = useState('');
  const [youtubeReady, setYoutubeReady] = useState(false);
  const [youtubeStart, setYoutubeStart] = useState(0);
  const [youtubeEnd, setYoutubeEnd] = useState(5);
  const [youtubeLoop, setYoutubeLoop] = useState(false);
  const [youtubeMessage, setYoutubeMessage] = useState('');
  const [localVideoUrl, setLocalVideoUrl] = useState('');
  const [localVideoName, setLocalVideoName] = useState('');
  const [localVideoDuration, setLocalVideoDuration] = useState(0);
  const [clipStart, setClipStart] = useState(0);
  const [clipEnd, setClipEnd] = useState(3);
  const [localVideoLoop, setLocalVideoLoop] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoMessage, setVideoMessage] = useState('');
  const [videoSliceCount, setVideoSliceCount] = useState(4);
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const sourceRefs = useRef<Map<number, AudioBufferSourceNode>>(new Map());
  const voiceSourcesRef = useRef<Map<number, Set<AudioBufferSourceNode>>>(new Map());
  const voiceGainRefs = useRef<Map<number, GainNode>>(new Map());
  const reverbSendRef = useRef<GainNode | null>(null);
  const delaySendRef = useRef<GainNode | null>(null);
  const delayFeedbackRef = useRef<GainNode | null>(null);
  const delayTimeRef = useRef<DelayNode | null>(null);
  const reverseBuffersRef = useRef<WeakMap<AudioBuffer, AudioBuffer>>(new WeakMap());
  const scheduledTimersRef = useRef<Set<number>>(new Set());
  const pointerVelocityRef = useRef<Map<number, number>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const localVideoInputRef = useRef<HTMLInputElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoObjectUrlRef = useRef('');
  const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
  const youtubePlayerHostRef = useRef<HTMLDivElement>(null);
  const youtubeLoopTimerRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const seqIndexRef = useRef(-1);
  const selectedRef = useRef(0);
  const padsRef = useRef(pads);
  const patternsRef = useRef(patterns);
  const steps = patterns[currentPattern];
  const stepsRef = useRef(steps);
  const currentPatternRef = useRef(currentPattern);
  const arrangementRef = useRef(arrangement);
  const swingRef = useRef(swing);
  const tempoRef = useRef(tempo);
  const masterValueRef = useRef(master);
  const effectsRef = useRef(effects);
  padsRef.current = pads; patternsRef.current = patterns; stepsRef.current = steps;
  selectedRef.current = selected; currentPatternRef.current = currentPattern;
  arrangementRef.current = arrangement; swingRef.current = swing; tempoRef.current = tempo;
  masterValueRef.current = master; effectsRef.current = effects;

  useEffect(() => {
    if (!youtubeId) return;
    let disposed = false;
    setYoutubeReady(false);
    void loadYouTubeApi().then(() => {
      const API = window.YT;
      const host = youtubePlayerHostRef.current;
      if (disposed || !API || !host) return;
      youtubePlayerRef.current = new API.Player(host, {
        videoId: youtubeId,
        playerVars: { controls: 1, playsinline: 1, rel: 0, origin: window.location.origin },
        events: {
          onReady: () => {
            if (disposed) return;
            setYoutubeReady(true);
            setYoutubeMessage('Preview ready · set start and end cues below');
            const duration = youtubePlayerRef.current?.getDuration() ?? 0;
            if (duration > 0) setYoutubeEnd(Math.min(5, duration));
          },
          onError: () => setYoutubeMessage('This video cannot be embedded. Try another link or load a local video file.'),
        },
      });
    }).catch(reason => setYoutubeMessage(reason instanceof Error ? reason.message : 'YouTube preview could not load.'));
    return () => {
      disposed = true;
      if (youtubeLoopTimerRef.current !== null) window.clearInterval(youtubeLoopTimerRef.current);
      youtubeLoopTimerRef.current = null;
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
    };
  }, [youtubeId]);

  useEffect(() => {
    if (!youtubeLoop || !youtubeReady) {
      if (youtubeLoopTimerRef.current !== null) window.clearInterval(youtubeLoopTimerRef.current);
      youtubeLoopTimerRef.current = null;
      return;
    }
    youtubeLoopTimerRef.current = window.setInterval(() => {
      const player = youtubePlayerRef.current;
      if (player && player.getCurrentTime() >= youtubeEnd) {
        player.seekTo(youtubeStart, true);
        player.playVideo();
      }
    }, 120);
    return () => {
      if (youtubeLoopTimerRef.current !== null) window.clearInterval(youtubeLoopTimerRef.current);
      youtubeLoopTimerRef.current = null;
    };
  }, [youtubeLoop, youtubeReady, youtubeStart, youtubeEnd]);

  useEffect(() => () => {
    if (localVideoObjectUrlRef.current) URL.revokeObjectURL(localVideoObjectUrlRef.current);
    if (youtubeLoopTimerRef.current !== null) window.clearInterval(youtubeLoopTimerRef.current);
    youtubePlayerRef.current?.destroy();
  }, []);

  const context = useCallback(() => {
    if (!audioRef.current) {
      const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextConstructor) throw new Error('Web Audio is not supported by this browser.');
      audioRef.current = new AudioContextConstructor();
      const gain = audioRef.current.createGain();
      gain.gain.value = masterValueRef.current;
      gain.connect(audioRef.current.destination);
      masterRef.current = gain;
      const convolver = audioRef.current.createConvolver();
      convolver.buffer = makeImpulse(audioRef.current);
      const reverbInput = audioRef.current.createGain();
      const reverbWet = audioRef.current.createGain();
      reverbInput.gain.value = effectsRef.current.reverb;
      reverbInput.connect(convolver);
      convolver.connect(reverbWet);
      reverbWet.gain.value = 0.32;
      reverbWet.connect(gain);
      const delayInput = audioRef.current.createGain();
      const delay = audioRef.current.createDelay(1.5);
      const feedback = audioRef.current.createGain();
      const delayWet = audioRef.current.createGain();
      delayInput.gain.value = effectsRef.current.delay;
      delay.delayTime.value = 0.28;
      feedback.gain.value = 0.26;
      delayWet.gain.value = 0.45;
      delayInput.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(delayWet);
      delayWet.connect(gain);
      reverbSendRef.current = reverbInput;
      delaySendRef.current = delayInput;
      delayFeedbackRef.current = feedback;
      delayTimeRef.current = delay;
    }
    return audioRef.current;
  }, []);

  const unlockAudio = useCallback(async () => {
    try {
      const audio = context();
      if (audio.state !== 'running') await audio.resume();
      setReady(true);
      setError('');
      if (padsRef.current.every(pad => !pad.buffer)) {
        try {
          const restored = await restoreSamples(audio);
          if (restored.length) {
            setPads(old => {
              const next = [...old];
            restored.forEach(item => {
              const settings = next[item.index];
              next[item.index] = {
                ...item.pad,
                ...settings,
                buffer: item.pad.buffer,
                bars: item.pad.bars,
                duration: item.pad.duration,
                name: item.pad.name,
              };
            });
              padsRef.current = next;
              return next;
            });
            setNotice(`Restored ${restored.length} local sample${restored.length === 1 ? '' : 's'}`);
          }
        } catch { /* Storage may be disabled; the live sampler remains available. */ }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Audio could not start. Check your browser audio permissions.');
    }
  }, [context]);

  const loadBouncyPreset = useCallback(async () => {
    const hadLoadedSamples = padsRef.current.some(pad => pad.buffer);
    if (hadLoadedSamples && !window.confirm('Load Bouncy 808? This replaces the current 16 pads and step pattern.')) return;
    await unlockAudio();
    const audio = audioRef.current;
    if (!audio || audio.state !== 'running') return;
    if (!hadLoadedSamples && padsRef.current.some(pad => pad.buffer)
      && !window.confirm('Your saved samples were restored. Load Bouncy 808 and replace them with the preset?')) return;

    try {
      const preset = createBouncy808Preset(audio);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      scheduledTimersRef.current.forEach(timer => window.clearTimeout(timer));
      scheduledTimersRef.current.clear();
      timerRef.current = null;
      setPlaying(false);
      setSongPlaying(false);
      setCurrentStep(-1);
      seqIndexRef.current = -1;
      voiceSourcesRef.current.forEach(voices => voices.forEach(source => { try { source.stop(); } catch { /* already stopped */ } }));
      voiceSourcesRef.current.clear();
      sourceRefs.current.forEach(source => { try { source.stop(); } catch { /* already stopped */ } });
      sourceRefs.current.clear();
      voiceGainRefs.current.clear();
      setActivePads(new Set());
      setPads(preset.pads);
      padsRef.current = preset.pads;
      const presetPatterns = [preset.steps, makeEmptyPattern(), makeEmptyPattern(), makeEmptyPattern()];
      setPatterns(presetPatterns);
      patternsRef.current = presetPatterns;
      setCurrentPattern(0);
      stepsRef.current = preset.steps;
      setArrangement([0, 1, 0, 1]);
      arrangementRef.current = [0, 1, 0, 1];
      setTempo(104);
      setSelected(0);
      const saves = await Promise.allSettled(preset.pads.map((pad, index) => {
        if (!pad.buffer) return Promise.resolve();
        const wav = new File([encodeWav(pad.buffer)], pad.name, { type: 'audio/wav' });
        return persistSample(index, wav);
      }));
      const allSaved = saves.every(result => result.status === 'fulfilled');
      setNotice(allSaved
        ? 'Bouncy 808 loaded · 16 sounds + starter groove saved on this device'
        : 'Bouncy 808 loaded · local browser storage unavailable; session only');
      window.setTimeout(() => setNotice(''), 3200);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The Bouncy 808 preset could not be loaded.');
    }
  }, [unlockAudio]);

  const playPad = useCallback(async (index: number, velocity = 1, gateDuration?: number) => {
    const pad = padsRef.current[index];
    if (!pad?.buffer) {
      setSelected(index);
      return;
    }
    try {
      const audio = context();
      if (audio.state !== 'running') await audio.resume();
      const isLooping = pad.loop || pad.triggerMode === 'gate';
      if (pad.chokeGroup) {
        const chokedPads: number[] = [];
        sourceRefs.current.forEach((activeSource, activeIndex) => {
          if (activeIndex !== index && padsRef.current[activeIndex]?.chokeGroup === pad.chokeGroup) {
            const voices = voiceSourcesRef.current.get(activeIndex);
            if (voices?.size) voices.forEach(voice => { try { voice.stop(); } catch { /* already stopped */ } });
            else { try { activeSource.stop(); } catch { /* already stopped */ } }
            sourceRefs.current.delete(activeIndex);
            voiceSourcesRef.current.delete(activeIndex);
            voiceGainRefs.current.delete(activeIndex);
            chokedPads.push(activeIndex);
          }
        });
        if (chokedPads.length) setActivePads(old => {
          const next = new Set(old);
          chokedPads.forEach(activeIndex => next.delete(activeIndex));
          return next;
        });
      }
      const previous = sourceRefs.current.get(index);
      const previousVoices = voiceSourcesRef.current.get(index);
      if (previousVoices?.size) previousVoices.forEach(voice => { try { voice.stop(); } catch { /* already stopped */ } });
      else if (previous) { try { previous.stop(); } catch { /* already stopped */ } }
      voiceSourcesRef.current.delete(index);
      sourceRefs.current.delete(index);
      voiceGainRefs.current.delete(index);

      let sample = pad.buffer;
      if (pad.reverse) {
        let reversed = reverseBuffersRef.current.get(sample);
        if (!reversed) {
          reversed = reverseBuffer(audio, sample);
          reverseBuffersRef.current.set(sample, reversed);
        }
        sample = reversed;
      }
      const trimStart = Math.max(0, Math.min(0.99, pad.trimStart));
      const trimEnd = Math.max(trimStart + 0.01, Math.min(1, pad.trimEnd));
      const regionDuration = (trimEnd - trimStart) * sample.duration;
      const offset = pad.reverse ? (1 - trimEnd) * sample.duration : trimStart * sample.duration;
      const playbackRate = 2 ** (pad.pitch / 12);
      const now = audio.currentTime + 0.005;
      const duration = regionDuration / playbackRate;
      const velocityGain = pad.volume * (pad.velocitySensitive ? Math.max(0.08, Math.min(1, velocity)) : 1);
      const source = audio.createBufferSource();
      const gain = audio.createGain();
      const filter = audio.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = pad.filterCutoff;
      source.buffer = sample;
      source.playbackRate.value = playbackRate;
      source.loop = isLooping;
      if (isLooping) {
        source.loopStart = pad.reverse ? (1 - trimEnd) * sample.duration : trimStart * sample.duration;
        source.loopEnd = pad.reverse ? (1 - trimStart) * sample.duration : trimEnd * sample.duration;
      }

      let lastNode: AudioNode = filter;
      source.connect(filter);
      if (pad.distortion > 0) {
        const shaper = audio.createWaveShaper();
        const amount = 1 + pad.distortion * 75;
        const curve = new Float32Array(2048);
        for (let point = 0; point < curve.length; point++) {
          const x = (point * 2) / (curve.length - 1) - 1;
          curve[point] = Math.tanh(x * amount) / Math.tanh(amount);
        }
        shaper.curve = curve;
        shaper.oversample = '2x';
        lastNode.connect(shaper);
        lastNode = shaper;
      }
      lastNode.connect(gain);
      gain.connect(masterRef.current ?? audio.destination);
      if (reverbSendRef.current) { gain.connect(reverbSendRef.current); reverbSendRef.current.gain.value = effectsRef.current.reverb; }
      if (delaySendRef.current) { gain.connect(delaySendRef.current); delaySendRef.current.gain.value = effectsRef.current.delay; }
      const attack = pad.triggerMode === 'gate' ? pad.attack : pad.fadeIn;
      const decay = Math.min(pad.decay, Math.max(0, duration - attack));
      const sustainLevel = velocityGain * pad.sustain;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(velocityGain, now + Math.max(0.001, attack));
      gain.gain.linearRampToValueAtTime(sustainLevel, now + Math.max(0.002, attack + decay));
      if (!isLooping) {
        const fade = Math.min(pad.fadeOut, duration);
        const fadeStart = Math.max(now + attack + decay, now + duration - fade);
        gain.gain.setValueAtTime(sustainLevel, fadeStart);
        gain.gain.linearRampToValueAtTime(0, now + duration);
      }
      sourceRefs.current.set(index, source);
      const voices = voiceSourcesRef.current.get(index) ?? new Set<AudioBufferSourceNode>();
      voices.add(source);
      voiceSourcesRef.current.set(index, voices);
      voiceGainRefs.current.set(index, gain);
      setActivePads(old => new Set(old).add(index));
      source.onended = () => {
        const activeVoices = voiceSourcesRef.current.get(index);
        activeVoices?.delete(source);
        if (sourceRefs.current.get(index) === source) {
          const latest = activeVoices?.values().next().value as AudioBufferSourceNode | undefined;
          if (latest) sourceRefs.current.set(index, latest);
          else sourceRefs.current.delete(index);
        }
        if (!activeVoices?.size) {
          voiceSourcesRef.current.delete(index);
          voiceGainRefs.current.delete(index);
          setActivePads(old => { const next = new Set(old); next.delete(index); return next; });
        }
      };
      if (gateDuration !== undefined && isLooping) {
        const releaseAt = now + gateDuration;
        gain.gain.setValueAtTime(sustainLevel, releaseAt);
        gain.gain.linearRampToValueAtTime(0, releaseAt + pad.release);
        source.start(now, offset);
        source.stop(releaseAt + pad.release + 0.01);
      } else if (isLooping) {
        source.start(now, offset);
      } else {
        source.start(now, offset, regionDuration);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This sound could not be played.');
    }
  }, [context]);

  const releasePad = useCallback((index: number) => {
    const pad = padsRef.current[index];
    if (pad?.triggerMode !== 'gate') return;
    const audio = audioRef.current;
    const source = sourceRefs.current.get(index);
    const gain = voiceGainRefs.current.get(index);
    if (!audio || !source || !gain) return;
    const stopAt = audio.currentTime + pad.release;
    gain.gain.cancelScheduledValues(audio.currentTime);
    gain.gain.setTargetAtTime(0, audio.currentTime, Math.max(0.008, pad.release / 4));
    try { source.stop(stopAt + 0.02); } catch { /* already stopped */ }
  }, []);

  const stopPad = useCallback((index: number) => {
    const voices = voiceSourcesRef.current.get(index);
    if (voices?.size) voices.forEach(source => { try { source.stop(); } catch { /* already stopped */ } });
    else {
      const source = sourceRefs.current.get(index);
      if (source) { try { source.stop(); } catch { /* already stopped */ } }
    }
    voiceSourcesRef.current.delete(index);
    sourceRefs.current.delete(index);
    voiceGainRefs.current.delete(index);
    setActivePads(old => { const next = new Set(old); next.delete(index); return next; });
  }, []);

  const updatePad = (index: number, changes: Partial<Pad>) => {
    setPads(old => old.map((pad, slot) => slot === index ? { ...pad, ...changes } : pad));
  };

  const updateCurrentPattern = (updater: (pattern: boolean[][]) => boolean[][]) => {
    setPatterns(old => old.map((pattern, index) => index === currentPattern ? updater(pattern) : pattern));
  };

  const saveCurrentKit = async () => {
    const name = kitName.trim();
    if (!name) { setError('Give this kit a name before saving.'); return; }
    try {
      const record: SavedKit = {
        name,
        savedAt: new Date().toISOString(),
        tempo,
        master,
        swing,
        quantize,
        effects,
        patterns,
        arrangement,
        pads: pads.map(({ buffer, bars: _bars, ...settings }) => ({ ...settings, sample: buffer ? encodeWav(buffer) : null })),
      };
      await saveKitRecord(name, record);
      const names = await listSavedKits();
      setSavedKits(names);
      setSelectedKit(name);
      setError('');
      setNotice(`“${name}” saved on this device`);
      window.setTimeout(() => setNotice(''), 2600);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This kit could not be saved in browser storage.');
    }
  };

  const loadSavedKit = async () => {
    if (!selectedKit) return;
    if (padsRef.current.some(pad => pad.buffer) && !window.confirm(`Load “${selectedKit}”? This replaces the current pads and session settings.`)) return;
    await unlockAudio();
    const audio = audioRef.current;
    if (!audio || audio.state !== 'running') return;
    try {
      const record = await readKitRecord(selectedKit);
      if (!record) throw new Error('That saved kit is no longer available.');
      const loadedPads = await Promise.all(record.pads.map(async ({ sample, ...settings }) => {
        const buffer = sample ? await audio.decodeAudioData(await sample.arrayBuffer()) : null;
        return { ...emptyPad(), ...settings, buffer, duration: buffer?.duration ?? 0, bars: buffer ? makeWave(buffer) : [] };
      }));
      stopSequence();
      voiceSourcesRef.current.forEach(voices => voices.forEach(source => { try { source.stop(); } catch { /* already stopped */ } }));
      voiceSourcesRef.current.clear();
      sourceRefs.current.forEach(source => { try { source.stop(); } catch { /* already stopped */ } });
      sourceRefs.current.clear();
      voiceGainRefs.current.clear();
      setActivePads(new Set());
      setPads(loadedPads);
      padsRef.current = loadedPads;
      setPatterns(record.patterns);
      patternsRef.current = record.patterns;
      setCurrentPattern(0);
      stepsRef.current = record.patterns[0] ?? makeEmptyPattern();
      setArrangement(record.arrangement);
      arrangementRef.current = record.arrangement;
      setTempo(record.tempo);
      tempoRef.current = record.tempo;
      setMaster(record.master);
      setSwing(record.swing ?? 0);
      setQuantize(record.quantize ?? 1);
      setEffects(record.effects);
      setKitName(record.name);
      setSelected(0);
      setError('');
      setNotice(`Loaded “${selectedKit}”`);
      window.setTimeout(() => setNotice(''), 2600);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This kit could not be loaded.');
    }
  };

  const removeSavedKit = async () => {
    if (!selectedKit) return;
    if (!window.confirm(`Delete the saved kit “${selectedKit}” from this device?`)) return;
    try {
      await deleteKitRecord(selectedKit);
      const names = await listSavedKits();
      setSavedKits(names);
      setSelectedKit(names[0] ?? '');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This kit could not be deleted.');
    }
  };

  useEffect(() => {
    try {
      const saved = localStorage.getItem('padloop-kit-meta');
      if (saved) {
        const meta = JSON.parse(saved) as {
          tempo?: number; master?: number; steps?: boolean[][]; patterns?: boolean[][][];
          currentPattern?: number; arrangement?: number[]; swing?: number; quantize?: number;
          effects?: { reverb?: number; delay?: number }; pads?: Partial<Pad>[];
        };
        if (meta.tempo) setTempo(Math.min(180, Math.max(50, meta.tempo)));
        if (meta.master !== undefined) setMaster(meta.master);
        if (meta.patterns?.length === 4 && meta.patterns.every(pattern => pattern.length === 16)) setPatterns(meta.patterns);
        else if (meta.steps?.length === 16) setPatterns(old => old.map((pattern, index) => index === 0 ? meta.steps! : pattern));
        if (meta.currentPattern !== undefined) setCurrentPattern(Math.max(0, Math.min(3, meta.currentPattern)));
        if (meta.arrangement?.length === 4) setArrangement(meta.arrangement.map(value => Math.max(0, Math.min(3, value))));
        if (meta.swing !== undefined) setSwing(Math.max(0, Math.min(0.6, meta.swing)));
        if (meta.quantize !== undefined) setQuantize(Math.max(1, Math.min(4, meta.quantize)));
        if (meta.effects) setEffects({ reverb: meta.effects.reverb ?? 0.08, delay: meta.effects.delay ?? 0.04 });
        if (meta.pads?.length === 16) setPads(old => old.map((pad, index) => ({ ...pad, ...meta.pads?.[index] })));
      }
    } catch { /* Ignore malformed browser-local metadata. */ }
  }, []);

  useEffect(() => {
    const metadata = {
      tempo, master, patterns, currentPattern, arrangement, swing, quantize, effects,
      pads: pads.map(({ buffer: _buffer, bars: _bars, ...settings }) => settings),
    };
    try { localStorage.setItem('padloop-kit-meta', JSON.stringify(metadata)); } catch { /* Storage can be disabled or full. */ }
  }, [tempo, master, patterns, currentPattern, arrangement, swing, quantize, effects, pads]);

  useEffect(() => {
    void listSavedKits().then(setSavedKits).catch(() => setSavedKits([]));
  }, []);

  useEffect(() => {
    if (masterRef.current) masterRef.current.gain.setTargetAtTime(master, audioRef.current?.currentTime ?? 0, .015);
  }, [master]);

  useEffect(() => {
    if (reverbSendRef.current) reverbSendRef.current.gain.setTargetAtTime(effects.reverb, audioRef.current?.currentTime ?? 0, .025);
    if (delaySendRef.current) delaySendRef.current.gain.setTargetAtTime(effects.delay, audioRef.current?.currentTime ?? 0, .025);
  }, [effects]);

  const stopSequence = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    scheduledTimersRef.current.forEach(timer => window.clearTimeout(timer));
    scheduledTimersRef.current.clear();
    timerRef.current = null;
    setPlaying(false);
    setSongPlaying(false);
    setCurrentStep(-1);
    seqIndexRef.current = -1;
  }, []);

  const startSequence = useCallback(async (mode: 'pattern' | 'song' = 'pattern') => {
    await unlockAudio();
    const audio = audioRef.current;
    if (!audio || audio.state !== 'running') return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    scheduledTimersRef.current.forEach(timer => window.clearTimeout(timer));
    scheduledTimersRef.current.clear();
    setPlaying(true);
    setSongPlaying(mode === 'song');
    seqIndexRef.current = -1;
    const tick = () => {
      const absoluteStep = seqIndexRef.current + 1;
      const bar = Math.floor(absoluteStep / 16);
      if (mode === 'song' && bar >= arrangementRef.current.length) {
        stopSequence();
        return;
      }
      const patternIndex = mode === 'song' ? arrangementRef.current[bar] : currentPatternRef.current;
      const stepIndex = absoluteStep % 16;
      seqIndexRef.current = absoluteStep;
      if (mode === 'song') setCurrentPattern(patternIndex);
      setCurrentStep(stepIndex);
      const pattern = patternsRef.current[patternIndex] ?? makeEmptyPattern();
      const stepDuration = 60000 / Math.max(50, tempoRef.current) / 4;
      for (let padIndex = 0; padIndex < 16; padIndex++) {
        const pad = padsRef.current[padIndex];
        if (!pattern[padIndex]?.[stepIndex] || Math.random() * 100 > pad.probability) continue;
        void playPad(padIndex, 0.88, stepDuration / 1000);
        const ratchetCount = Math.max(1, Math.min(4, pad.ratchets));
        for (let hit = 1; hit < ratchetCount; hit++) {
          const timer = window.setTimeout(() => {
            scheduledTimersRef.current.delete(timer);
            void playPad(padIndex, Math.max(0.55, 0.9 - hit * 0.08), stepDuration / (ratchetCount * 1000));
          }, (stepDuration * hit) / ratchetCount);
          scheduledTimersRef.current.add(timer);
        }
        if (pad.flam) {
          const timer = window.setTimeout(() => {
            scheduledTimersRef.current.delete(timer);
            void playPad(padIndex, 0.62, stepDuration / 1000);
          }, 28);
          scheduledTimersRef.current.add(timer);
        }
      }
      const isOffbeat = stepIndex % 2 === 1;
      const swingFactor = Math.max(0, Math.min(0.6, swingRef.current));
      const delay = stepDuration * (isOffbeat ? 1 + swingFactor * 0.45 : 1 - swingFactor * 0.45);
      timerRef.current = window.setTimeout(tick, delay);
    };
    tick();
  }, [playPad, stopSequence, unlockAudio]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    scheduledTimersRef.current.forEach(timer => window.clearTimeout(timer));
    voiceSourcesRef.current.forEach(voices => voices.forEach(source => { try { source.stop(); } catch { /* already stopped */ } }));
    sourceRefs.current.forEach(source => { try { source.stop(); } catch { /* already stopped */ } });
    void audioRef.current?.close();
  }, []);

  const importFile = useCallback(async (file: File, index: number) => {
    setError('');
    const accepted = file.type.startsWith('audio/') || /\.(wav|wave|mp3|m4a|aac|ogg|oga|flac|aif|aiff|webm)$/i.test(file.name);
    if (!accepted) { setError('Choose an audio file such as WAV, MP3, M4A, OGG, FLAC, AIFF or WebM.'); return; }
    try {
      const audio = context();
      if (audio.state !== 'running') await audio.resume();
      const buffer = await audio.decodeAudioData(await file.arrayBuffer());
      const updated: Pad = { ...padsRef.current[index], name: file.name, duration: buffer.duration, buffer, bars: makeWave(buffer) };
      setPads(old => old.map((pad, slot) => slot === index ? updated : pad));
      setSelected(index);
      try { await persistSample(index, file); setNotice('Sample loaded · saved on this device'); }
      catch { setNotice('Sample loaded · temporary for this session'); }
      window.setTimeout(() => setNotice(''), 2600);
    } catch {
      setError('This audio could not be decoded. Try an uncompressed WAV or another browser-supported audio file.');
    }
  }, [context]);

  const detectSelectedBpm = () => {
    if (!current.buffer) return;
    const bpm = detectBpm(current.buffer);
    if (!bpm) { setError('Could not find a steady BPM in this sample. Try a drum loop with clear transients.'); return; }
    updatePad(selected, { detectedBpm: bpm });
    setTempo(bpm);
    setError('');
    setNotice(`Detected about ${bpm} BPM`);
    window.setTimeout(() => setNotice(''), 2400);
  };

  const stretchSelectedToTempo = async () => {
    if (!current.buffer) return;
    const audio = context();
    if (audio.state !== 'running') await audio.resume();
    const sourceBpm = current.detectedBpm ?? detectBpm(current.buffer);
    if (!sourceBpm) { setError('Detect BPM first, or use a loop with a clear beat.'); return; }
    try {
      const ratio = sourceBpm / tempo;
      if (ratio < 0.5 || ratio > 2) {
        setError('That tempo change is outside the supported 2× stretch range. Choose a closer target BPM.');
        return;
      }
      let region = sliceBuffer(audio, current.buffer, 1, current.trimStart, current.trimEnd)[0];
      if (current.reverse) region = reverseBuffer(audio, region);
      const stretched = stretchBuffer(audio, region, ratio);
      const updated = { ...current, buffer: stretched, duration: stretched.duration, bars: makeWave(stretched), trimStart: 0, trimEnd: 1, reverse: false, detectedBpm: tempo };
      setPads(old => old.map((pad, index) => index === selected ? updated : pad));
      try {
        await persistSample(selected, new File([encodeWav(stretched)], current.name || `pad-${selected + 1}.wav`, { type: 'audio/wav' }));
        setNotice(`Sample stretched to ${tempo} BPM · pitch preserved`);
      } catch {
        setNotice(`Sample stretched to ${tempo} BPM for this session`);
      }
      setError('');
      window.setTimeout(() => setNotice(''), 2600);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This sample could not be stretched.');
    }
  };

  const sliceSelectedSample = async () => {
    if (!current.buffer) return;
    const targets = Array.from({ length: sliceCount }, (_, index) => (selected + index) % 16);
    if (targets.some(index => index !== selected && pads[index].buffer)
      && !window.confirm(`Slice this sample across ${sliceCount} pads? Existing samples in those slots will be replaced.`)) return;
    const audio = context();
    try {
      let source = current.buffer;
      if (current.reverse) source = reverseBuffer(audio, source);
      const slices = sliceBuffer(audio, source, sliceCount, current.trimStart, current.trimEnd);
      const slicedPads = [...pads];
      slices.forEach((buffer, sliceIndex) => {
        const padIndex = targets[sliceIndex];
        slicedPads[padIndex] = {
          ...emptyPad(),
          name: `${current.name.replace(/\.[^.]+$/, '')} slice ${String(sliceIndex + 1).padStart(2, '0')}.wav`,
          buffer,
          duration: buffer.duration,
          bars: makeWave(buffer),
        };
      });
      setPads(slicedPads);
      padsRef.current = slicedPads;
      setSelected(targets[0]);
      await Promise.allSettled(slices.map((buffer, sliceIndex) => {
        const padIndex = targets[sliceIndex];
        const slicePad = slicedPads[padIndex];
        return persistSample(padIndex, new File([encodeWav(buffer)], slicePad.name, { type: 'audio/wav' }));
      }));
      setNotice(`Split into ${sliceCount} playable slices`);
      setError('');
      window.setTimeout(() => setNotice(''), 2600);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This sample could not be sliced.');
    }
  };

  const handlePadHit = (index: number, velocity = 0.88) => {
    setSelected(index);
    if (recordMode && playing) {
      const grid = Math.max(1, Math.min(4, quantize));
      const quantizedStep = ((Math.round(Math.max(0, currentStep) / grid) * grid) % 16);
      updateCurrentPattern(pattern => pattern.map((row, padIndex) =>
        padIndex === index ? row.map((active, stepIndex) => stepIndex === quantizedStep ? true : active) : row));
    }
    void playPad(index, velocity);
  };

  const loadYoutubePreview = () => {
    const id = parseYouTubeId(youtubeUrl);
    if (!id) {
      setYoutubeMessage('Paste a valid YouTube watch, short, or embed link.');
      setYoutubeId('');
      setYoutubeLoop(false);
      return;
    }
    if (id === youtubeId && youtubePlayerRef.current) {
      youtubePlayerRef.current.seekTo(0, true);
      youtubePlayerRef.current.pauseVideo();
      setYoutubeLoop(false);
      setYoutubeMessage('Preview ready · set start and end cues below');
      return;
    }
    setYoutubeMessage('Loading YouTube preview…');
    setYoutubeStart(0);
    setYoutubeEnd(5);
    setYoutubeLoop(false);
    setYoutubeReady(false);
    setYoutubeId(id);
  };

  const setYoutubeCue = (cue: 'start' | 'end') => {
    const player = youtubePlayerRef.current;
    if (!player) return;
    const time = Math.max(0, player.getCurrentTime());
    if (cue === 'start') {
      setYoutubeStart(Math.min(time, Math.max(0, youtubeEnd - 0.05)));
      setYoutubeMessage(`YouTube in point: ${time.toFixed(2)} seconds`);
    } else {
      setYoutubeEnd(Math.max(time, youtubeStart + 0.05));
      setYoutubeMessage(`YouTube out point: ${time.toFixed(2)} seconds`);
    }
  };

  const toggleYoutubeRange = () => {
    const player = youtubePlayerRef.current;
    if (!player || !youtubeReady) return;
    if (youtubeLoop) {
      setYoutubeLoop(false);
      player.pauseVideo();
      return;
    }
    if (youtubeEnd <= youtubeStart) {
      setYoutubeMessage('Set the out point after the in point.');
      return;
    }
    player.seekTo(youtubeStart, true);
    player.playVideo();
    setYoutubeLoop(true);
  };

  const chooseLocalVideo = (file: File) => {
    if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(file.name)) {
      setVideoMessage('Choose a video file such as MP4, WebM or MOV.');
      return;
    }
    if (localVideoObjectUrlRef.current) URL.revokeObjectURL(localVideoObjectUrlRef.current);
    const url = URL.createObjectURL(file);
    localVideoObjectUrlRef.current = url;
    setLocalVideoUrl(url);
    setLocalVideoName(file.name);
    setLocalVideoDuration(0);
    setClipStart(0);
    setClipEnd(3);
    setLocalVideoLoop(false);
    setVideoMessage('Video ready · the clipper processes this file in your browser.');
  };

  const captureLocalVideoAudio = async (start: number, end: number) => {
    const video = localVideoRef.current;
    if (!video) throw new Error('Load a local video file first.');
    if (!(end > start)) throw new Error('The clip end must be later than its start.');
    if (typeof MediaRecorder === 'undefined') throw new Error('Audio recording is not supported by this browser.');
    const media = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const capture = media.captureStream ?? media.mozCaptureStream;
    if (!capture) throw new Error('This browser cannot capture audio from a local video. Try a current Chrome or Firefox browser.');
    video.pause();
    if (Math.abs(video.currentTime - start) > 0.01) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('The video could not seek to that clip point.')), 4000);
        video.addEventListener('seeked', () => { window.clearTimeout(timeout); resolve(); }, { once: true });
        video.currentTime = start;
      });
    }
    const capturedStream = capture.call(video);
    const audioTracks = capturedStream.getAudioTracks();
    if (!audioTracks.length) {
      capturedStream.getTracks().forEach(track => track.stop());
      throw new Error('This video has no audio track to sample.');
    }
    const audioStream = new MediaStream(audioTracks);
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
      .find(type => MediaRecorder.isTypeSupported(type));
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream);
    } catch {
      capturedStream.getTracks().forEach(track => track.stop());
      throw new Error('This browser cannot record the video’s audio format.');
    }
    const chunks: Blob[] = [];
    const recording = new Promise<Blob>((resolve, reject) => {
      let timer: number | null = null;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => {
        if (timer !== null) window.clearInterval(timer);
        reject(new Error('The video audio capture stopped unexpectedly.'));
      };
      recorder.onstop = () => {
        if (timer !== null) window.clearInterval(timer);
        capturedStream.getTracks().forEach(track => track.stop());
        resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      };
      recorder.start(100);
      void video.play().catch(() => {
        if (recorder.state === 'recording') recorder.stop();
        reject(new Error('Press play on the local video once, then try capturing the clip again.'));
      });
      timer = window.setInterval(() => {
        if (video.currentTime >= end || video.ended) {
          video.pause();
          if (timer !== null) window.clearInterval(timer);
          if (recorder.state === 'recording') recorder.stop();
        }
      }, 20);
    });
    const audioBlob = await recording;
    const audio = context();
    if (audio.state !== 'running') await audio.resume();
    return audio.decodeAudioData(await audioBlob.arrayBuffer());
  };

  const captureVideoClipToPad = async (
    start = clipStart,
    end = clipEnd,
    matchYoutubeCue = false,
  ) => {
    if (!localVideoUrl) return;
    if (start < 0 || end <= start || end > localVideoDuration) {
      setVideoMessage('The selected cue range must fit inside the loaded local video.');
      return;
    }
    setVideoBusy(true);
    setVideoMessage(`${matchYoutubeCue ? 'Capturing matching local-video cue' : 'Capturing'} ${start.toFixed(2)}–${end.toFixed(2)} seconds…`);
    try {
      const buffer = await captureLocalVideoAudio(start, end);
      const name = `${localVideoName.replace(/\.[^.]+$/, '')}${matchYoutubeCue ? ' reference cue' : ''} ${start.toFixed(2)}-${end.toFixed(2)}s.wav`;
      const updated: Pad = { ...padsRef.current[selected], name, duration: buffer.duration, buffer, bars: makeWave(buffer), trimStart: 0, trimEnd: 1 };
      const next = [...padsRef.current];
      next[selected] = updated;
      padsRef.current = next;
      setPads(next);
      setSelected(selected);
      await persistSample(selected, new File([encodeWav(buffer)], name, { type: 'audio/wav' }));
      setVideoMessage(`${matchYoutubeCue ? 'Matching local-video cue' : 'Clip'} added to pad ${String(selected + 1).padStart(2, '0')}.`);
    } catch (reason) {
      setVideoMessage(reason instanceof Error ? reason.message : 'This video clip could not be sampled.');
    } finally {
      setVideoBusy(false);
    }
  };

  const sliceLocalVideoToPads = async () => {
    if (!localVideoUrl) return;
    const sliceDuration = (clipEnd - clipStart) / videoSliceCount;
    if (sliceDuration < 0.06) { setVideoMessage('Choose a longer range to make these slices.'); return; }
    const targets = Array.from({ length: videoSliceCount }, (_, index) => (selected + index) % 16);
    if (targets.some(index => padsRef.current[index].buffer)
      && !window.confirm(`Split this video range into ${videoSliceCount} pads? Loaded samples in those slots will be replaced.`)) return;
    setVideoBusy(true);
    const made: { index: number; buffer: AudioBuffer; name: string }[] = [];
    try {
      for (let part = 0; part < videoSliceCount; part++) {
        const start = clipStart + sliceDuration * part;
        const end = part === videoSliceCount - 1 ? clipEnd : start + sliceDuration;
        setVideoMessage(`Capturing video slice ${part + 1} of ${videoSliceCount}…`);
        const buffer = await captureLocalVideoAudio(start, end);
        made.push({
          index: targets[part],
          buffer,
          name: `${localVideoName.replace(/\.[^.]+$/, '')} slice ${String(part + 1).padStart(2, '0')}.wav`,
        });
      }
      const next = [...padsRef.current];
      made.forEach(({ index, buffer, name }) => {
        next[index] = { ...emptyPad(), name, buffer, duration: buffer.duration, bars: makeWave(buffer) };
      });
      padsRef.current = next;
      setPads(next);
      await Promise.allSettled(made.map(({ index, buffer, name }) =>
        persistSample(index, new File([encodeWav(buffer)], name, { type: 'audio/wav' }))));
      setVideoMessage(`Created ${videoSliceCount} video slices on pads ${String(targets[0] + 1).padStart(2, '0')}–${String(targets[targets.length - 1] + 1).padStart(2, '0')}.`);
    } catch (reason) {
      setVideoMessage(reason instanceof Error ? reason.message : 'The video range could not be sliced.');
    } finally {
      setVideoBusy(false);
    }
  };

  const chooseFile = (index: number) => { setSelected(index); if (inputRef.current) { inputRef.current.value = ''; inputRef.current.click(); } };
  const removePad = (index: number) => {
    stopPad(index);
    setPads(old => old.map((pad, slot) => slot === index ? emptyPad() : pad));
    setPatterns(old => old.map(pattern => pattern.map((row, slot) => slot === index ? Array(16).fill(false) : row)));
    void removePersistedSample(index);
    setError('');
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement)?.tagName ?? '')) return;
      const index = PAD_KEYS.indexOf(event.key.toUpperCase());
      if (index < 0) return;
      event.preventDefault();
      handlePadHit(index, 0.88);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const index = PAD_KEYS.indexOf(event.key.toUpperCase());
      if (index >= 0) releasePad(index);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [handlePadHit, releasePad]);

  const toggleStep = (pad: number, step: number) => updateCurrentPattern(pattern =>
    pattern.map((row, rowIndex) => rowIndex === pad ? row.map((active, index) => index === step ? !active : active) : row));
  const clearSequence = () => {
    updateCurrentPattern(() => makeEmptyPattern());
    setCurrentStep(-1);
  };

  const exportMix = async () => {
    const audioPads = padsRef.current;
    const sequence = arrangementRef.current;
    const hasHits = sequence.some(patternIndex => patternsRef.current[patternIndex]?.some(row => row.some(Boolean)));
    if (!audioPads.some(pad => pad.buffer) || !hasHits) {
      setError('Load a sample and add at least one sequencer hit before exporting.');
      return;
    }
    try {
      const bpm = tempoRef.current;
      const stepSeconds = 60 / bpm / 4;
      const songSeconds = stepSeconds * 16 * sequence.length;
      const length = Math.ceil((songSeconds + 2) * 44100);
      const Offline = window.OfflineAudioContext || (window as typeof window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      if (!Offline) throw new Error('WAV rendering is not supported by this browser.');
      const offline = new Offline(2, length, 44100);
      const masterGain = offline.createGain();
      masterGain.gain.value = masterValueRef.current;
      masterGain.connect(offline.destination);
      const convolver = offline.createConvolver();
      convolver.buffer = makeImpulse(offline, 1.2);
      const reverbBus = offline.createGain();
      reverbBus.gain.value = 0.32;
      convolver.connect(reverbBus);
      reverbBus.connect(masterGain);
      const delayBus = offline.createGain();
      const delay = offline.createDelay(1.5);
      const feedback = offline.createGain();
      delayBus.gain.value = effects.delay;
      delay.delayTime.value = 0.28;
      feedback.gain.value = 0.26;
      delayBus.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(masterGain);
      const renderedPads = audioPads.map(pad => pad.buffer ? renderSample(offline, pad.buffer, pad) : null);
      audioPads.forEach((pad, padIndex) => {
        const sample = renderedPads[padIndex];
        if (!sample) return;
        sequence.forEach((patternIndex, barIndex) => {
          const pattern = patternsRef.current[patternIndex];
          if (!pattern) return;
          pattern[padIndex].forEach((active, stepIndex) => {
            if (!active || Math.random() * 100 > pad.probability) return;
            const swingOffset = stepIndex % 2 ? stepSeconds * swingRef.current * 0.45 : 0;
            const baseTime = barIndex * stepSeconds * 16 + stepIndex * stepSeconds + swingOffset;
            const ratchets = Math.max(1, Math.min(4, pad.ratchets));
            for (let hit = 0; hit < ratchets; hit++) {
              const source = offline.createBufferSource();
              const gain = offline.createGain();
              const filter = offline.createBiquadFilter();
              source.buffer = sample;
              source.loop = pad.loop || pad.triggerMode === 'gate';
              filter.type = 'lowpass';
              filter.frequency.value = pad.filterCutoff;
              const voiceVolume = pad.volume * (hit > 0 ? 0.86 : 1);
              const attack = pad.triggerMode === 'gate' ? pad.attack : pad.fadeIn;
              const decay = Math.min(pad.decay, Math.max(0, stepSeconds - attack));
              gain.gain.setValueAtTime(0, baseTime + (stepSeconds * hit) / ratchets);
              gain.gain.linearRampToValueAtTime(voiceVolume, baseTime + (stepSeconds * hit) / ratchets + Math.max(0.001, attack));
              gain.gain.linearRampToValueAtTime(voiceVolume * pad.sustain, baseTime + (stepSeconds * hit) / ratchets + attack + decay);
              source.connect(filter);
              let lastNode: AudioNode = filter;
              if (pad.distortion > 0) {
                const shaper = offline.createWaveShaper();
                const curve = new Float32Array(1024);
                const amount = 1 + pad.distortion * 75;
                for (let point = 0; point < curve.length; point++) {
                  const x = (point * 2) / (curve.length - 1) - 1;
                  curve[point] = Math.tanh(x * amount) / Math.tanh(amount);
                }
                shaper.curve = curve;
                shaper.oversample = '2x';
                lastNode.connect(shaper);
                lastNode = shaper;
              }
              lastNode.connect(gain);
              gain.connect(masterGain);
              gain.connect(convolver);
              gain.connect(delayBus);
              const at = baseTime + (stepSeconds * hit) / ratchets;
              source.start(at);
              if (source.loop) {
                const releaseAt = at + stepSeconds / ratchets;
                gain.gain.setValueAtTime(voiceVolume * pad.sustain, releaseAt);
                gain.gain.linearRampToValueAtTime(0, releaseAt + pad.release);
                source.stop(releaseAt + pad.release + 0.01);
              }
              if (pad.flam && hit === 0) {
                const flamSource = offline.createBufferSource();
                const flamGain = offline.createGain();
                flamSource.buffer = sample;
                flamGain.gain.value = pad.volume * 0.62;
                flamSource.connect(flamGain);
                flamGain.connect(masterGain);
                flamSource.start(at + 0.028);
              }
            }
          });
        });
      });
      const rendered = await offline.startRendering();
      saveBlob(encodeWav(rendered), `padloop-${bpm}bpm-song.wav`);
      setError('');
      setNotice('Arrangement mixdown downloaded as WAV');
      window.setTimeout(() => setNotice(''), 2600);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The loop could not be rendered.');
    }
  };

  const exportPad = async (index: number) => {
    const buffer = pads[index].buffer;
    if (!buffer) return;
    const rendered = renderSample(context(), buffer, pads[index]);
    saveBlob(encodeWav(rendered), `pad-${String(index + 1).padStart(2, '0')}-${pads[index].name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-')}.wav`);
    setNotice(`Pad ${String(index + 1).padStart(2, '0')} downloaded as WAV`);
    window.setTimeout(() => setNotice(''), 2600);
  };

  const exportMidi = () => {
    const midi = buildMidiFile(tempo, patterns, arrangement, pads, swing);
    saveBlob(midi, `padloop-${tempo}bpm-groove.mid`);
    setNotice('MIDI arrangement exported');
    window.setTimeout(() => setNotice(''), 2600);
  };

  const exportKitZip = async () => {
    if (!pads.some(pad => pad.buffer)) { setError('Load at least one sample before exporting a kit.'); return; }
    try {
      const files: { name: string; data: Blob }[] = [];
      for (let index = 0; index < pads.length; index++) {
        const pad = pads[index];
        if (!pad.buffer) continue;
        const rendered = renderSample(context(), pad.buffer, pad);
        const safeName = pad.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-');
        files.push({ name: `Samples/Pad-${String(index + 1).padStart(2, '0')}-${safeName}.wav`, data: encodeWav(rendered) });
      }
      const Offline = window.OfflineAudioContext || (window as typeof window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      if (!Offline) throw new Error('WAV stem rendering is not supported by this browser.');
      const stepSeconds = 60 / tempo / 4;
      const songSeconds = stepSeconds * 16 * arrangement.length;
      for (let padIndex = 0; padIndex < pads.length; padIndex++) {
        const pad = pads[padIndex];
        if (!pad.buffer || !arrangement.some(patternIndex => patterns[patternIndex]?.[padIndex]?.some(Boolean))) continue;
        const offline = new Offline(2, Math.ceil((songSeconds + 2) * 44100), 44100);
        const stemGain = offline.createGain();
        stemGain.connect(offline.destination);
        const sample = renderSample(offline, pad.buffer, pad);
        arrangement.forEach((patternIndex, barIndex) => {
          const pattern = patterns[patternIndex];
          if (!pattern) return;
          pattern[padIndex].forEach((active, stepIndex) => {
            if (!active || Math.random() * 100 > pad.probability) return;
            const swingOffset = stepIndex % 2 ? stepSeconds * swing * 0.45 : 0;
            const baseTime = barIndex * stepSeconds * 16 + stepIndex * stepSeconds + swingOffset;
            const ratchets = Math.max(1, Math.min(4, pad.ratchets));
            for (let hit = 0; hit < ratchets; hit++) {
              const at = baseTime + (stepSeconds * hit) / ratchets;
              const source = offline.createBufferSource();
              const filter = offline.createBiquadFilter();
              const gain = offline.createGain();
              source.buffer = sample;
              source.loop = pad.loop || pad.triggerMode === 'gate';
              filter.type = 'lowpass';
              filter.frequency.value = pad.filterCutoff;
              gain.gain.value = pad.volume * (hit ? 0.86 : 1);
              source.connect(filter);
              let lastNode: AudioNode = filter;
              if (pad.distortion > 0) {
                const shaper = offline.createWaveShaper();
                const curve = new Float32Array(1024);
                const amount = 1 + pad.distortion * 75;
                for (let point = 0; point < curve.length; point++) {
                  const x = (point * 2) / (curve.length - 1) - 1;
                  curve[point] = Math.tanh(x * amount) / Math.tanh(amount);
                }
                shaper.curve = curve;
                shaper.oversample = '2x';
                lastNode.connect(shaper);
                lastNode = shaper;
              }
              lastNode.connect(gain);
              gain.connect(stemGain);
              source.start(at);
              if (source.loop) {
                source.stop(at + stepSeconds / ratchets + pad.release + 0.01);
              }
              if (pad.flam && hit === 0) {
                const flam = offline.createBufferSource();
                const flamGain = offline.createGain();
                flam.buffer = sample;
                flamGain.gain.value = pad.volume * 0.62;
                flam.connect(flamGain);
                flamGain.connect(stemGain);
                flam.start(at + 0.028);
              }
            }
          });
        });
        const stem = await offline.startRendering();
        const safeName = pad.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-');
        files.push({ name: `Stems/Pad-${String(padIndex + 1).padStart(2, '0')}-${safeName}.wav`, data: encodeWav(stem) });
      }
      files.push({ name: 'Arrangement.mid', data: buildMidiFile(tempo, patterns, arrangement, pads, swing) });
      files.push({
        name: 'PadLoop-kit.json',
        data: new Blob([JSON.stringify({ name: kitName, tempo, swing, quantize, patterns, arrangement, effects, pads: pads.map(({ buffer: _buffer, bars: _bars, ...settings }) => settings) }, null, 2)], { type: 'application/json' }),
      });
      const zip = await buildZip(files);
      saveBlob(zip, `${kitName.trim().replace(/[^a-z0-9-_]+/gi, '-') || 'padloop-kit'}.zip`);
      setError('');
      setNotice('Kit ZIP exported with samples, sequencer stems, MIDI and settings');
      window.setTimeout(() => setNotice(''), 3000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This kit could not be exported.');
    }
  };

  const current = pads[selected];
  const stepCount = steps.reduce((total, row) => total + row.filter(Boolean).length, 0);
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Activity size={20} strokeWidth={2.5} /></div>
          <div><div className="brand-title">PadLoop</div><div className="brand-sub">Sampler · 01</div></div>
        </div>
        <div className="local-pill" data-testid="status-local-only"><i className="local-dot" /> SAMPLES STAY LOCAL <span>·</span> YOUTUBE PREVIEW</div>
      </header>

      <section className="intro">
        <div>
          <div className="eyebrow">YOUR SOUNDS, YOUR POCKET KIT</div>
          <h1>Load it. Tap it. Loop it.</h1>
          <p>A little sampler for the sounds already on your device.</p>
        </div>
        <div className="intro-actions">
          <button className="preset-load" onClick={() => void loadBouncyPreset()} data-testid="button-load-bouncy-808">
            <AudioLines size={15} /> Load Bouncy 808
          </button>
          <button className="start-audio" onClick={() => void unlockAudio()} data-testid="button-start-audio">
            <Headphones size={15} /> {ready ? 'Audio ready' : 'Start audio'} <span aria-hidden="true">↗</span>
          </button>
        </div>
      </section>

      <section className="workspace">
        <div className="panel">
          <div className="panel-head">
            <div className="panel-heading"><span className="section-index">01 /</span><h2>Sound board</h2></div>
            <span className="hint" data-testid="text-pad-count">{pads.filter(pad => pad.buffer).length} / 16 loaded</span>
          </div>
          <div className="pad-grid" data-testid="grid-sample-pads">
            {pads.map((pad, index) => (
              <button
                key={index}
                className={`pad ${pad.buffer ? 'loaded' : ''} ${selected === index ? 'selected' : ''} ${activePads.has(index) ? 'playing' : ''}`}
                style={{ '--pad-color': padColors[index] } as CSSProperties & Record<string, string>}
                onPointerDown={event => {
                  setSelected(index);
                  const velocity = event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : 0.88;
                  pointerVelocityRef.current.set(index, velocity);
                  if (pad.triggerMode === 'gate') handlePadHit(index, velocity);
                }}
                onPointerUp={() => releasePad(index)}
                onPointerLeave={() => releasePad(index)}
                onClick={() => {
                  setSelected(index);
                  if (pad.buffer && pad.triggerMode !== 'gate') handlePadHit(index, pointerVelocityRef.current.get(index) ?? 0.88);
                }}
                onDragOver={event => { event.preventDefault(); setSelected(index); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void importFile(file, index); }}
                data-testid={`button-pad-${index + 1}`}
                aria-label={`Pad ${index + 1}${pad.name ? `, ${pad.name}` : ', empty'}. Keyboard ${PAD_KEYS[index]}`}
              >
                <span className="pad-top"><span>{String(index + 1).padStart(2, '0')}</span><span className="pad-key">{PAD_KEYS[index]}</span></span>
                {pad.name ? <span className="pad-name" data-testid={`text-pad-name-${index + 1}`}>{pad.name}</span> : <span className="pad-name pad-empty">Drop a sound</span>}
                <span className="pad-meta"><span>{pad.buffer ? formatTime(pad.duration) : 'EMPTY SLOT'}</span><span>{pad.triggerMode === 'gate' ? 'GATE' : pad.loop ? 'LOOP' : pad.buffer ? 'ONE SHOT' : '·'}</span></span>
                {pad.buffer && <span className="wave" aria-label={`Waveform for ${pad.name}`} data-testid={`waveform-pad-${index + 1}`}>{pad.bars.map((height, bar) => <i key={bar} style={{ '--bar-height': `${height}%` } as CSSProperties & Record<string, string>} />)}</span>}
              </button>
            ))}
          </div>
          <div className="upload-note">Tap a loaded pad to audition · choose a slot, then drop audio or use the loader. Keys <strong>Q W E R / A S D F / Z X C V / 1 2 3 4</strong></div>
        </div>

        <div className="right-stack">
          <div className="panel selected-panel">
            <div className="selected-head">
              <div className="selected-title"><span className="pad-number">PAD {String(selected + 1).padStart(2, '0')}</span><h2>Sample deck</h2></div>
              {current.buffer && <button className="icon-button" aria-label="Remove sample" title="Remove sample" onClick={() => removePad(selected)} data-testid="button-remove-sample"><X size={15} /></button>}
            </div>
            <div
              className={`sample-drop ${dragging ? 'dragging' : ''}`}
              onDragOver={event => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void importFile(file, selected); }}
              onClick={() => chooseFile(selected)}
              role="button"
              tabIndex={0}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') chooseFile(selected); }}
              data-testid="dropzone-sample"
            >
              {current.buffer ? (
                <><div className="drop-icon"><AudioLines size={19} /></div><div className="sample-detail"><div className="sample-filename" data-testid="text-selected-sample">{current.name}</div><div className="sample-length" data-testid="text-sample-duration">{formatTime(current.duration)} · {current.buffer.numberOfChannels === 1 ? 'MONO' : 'STEREO'} · {Math.round(current.buffer.sampleRate / 1000)} kHz</div></div><button className="small-action" onPointerDown={event => { event.stopPropagation(); if (current.triggerMode === 'gate') void playPad(selected); }} onPointerUp={event => { event.stopPropagation(); releasePad(selected); }} onPointerLeave={() => releasePad(selected)} onClick={event => { event.stopPropagation(); if (current.triggerMode !== 'gate') void playPad(selected); }} data-testid="button-preview-sample"><Play size={13} /> Preview</button>{activePads.has(selected) && <button className="small-action" onClick={event => { event.stopPropagation(); stopPad(selected); }} data-testid="button-stop-sample"><Pause size={13} /> Stop</button>}</>
              ) : (
                <><div className="drop-icon"><Upload size={18} /></div><div className="drop-copy"><strong>Drop a sample here</strong><span>or click to browse · WAV, MP3, M4A, OGG, FLAC, AIFF</span></div><Plus size={16} color="#88918d" /></>
              )}
            </div>
            {current.buffer && <div className="sample-actions" style={{ marginTop: 10 }}>
              <button className="small-action" onClick={() => chooseFile(selected)} data-testid="button-replace-sample"><Upload size={12} /> Replace</button>
              <button className="small-action" onClick={() => exportPad(selected)} data-testid="button-export-selected-pad"><Download size={12} /> Download WAV</button>
            </div>}
            <div className="control-row">
              <div className="volume-control"><Volume2 size={14} color="#969d9e" /><label htmlFor="pad-volume">PAD VOL</label><input id="pad-volume" type="range" min="0" max="1" step=".01" value={current.volume} onChange={event => updatePad(selected, { volume: Number(event.target.value) })} data-testid="input-pad-volume" /></div>
              <select aria-label="Pad playback mode" value={current.triggerMode} onChange={event => updatePad(selected, { triggerMode: event.target.value as Pad['triggerMode'] })} data-testid="select-trigger-mode">
                <option value="one-shot">One-shot</option><option value="gate">Gate / hold</option>
              </select>
              <button className={`loop-toggle ${current.loop ? 'on' : ''}`} onClick={() => updatePad(selected, { loop: !current.loop })} data-testid="button-toggle-loop" aria-pressed={current.loop}><Repeat size={13} /> Loop {current.loop ? 'on' : 'off'}</button>
            </div>
            <label className="checkline"><input type="checkbox" checked={current.velocitySensitive} onChange={event => updatePad(selected, { velocitySensitive: event.target.checked })} data-testid="toggle-velocity" /> Velocity-sensitive pads</label>
            <details className="sampler-advanced">
              <summary>Sample editor & sound shaping</summary>
              <div className="editor-actions">
                <button className="small-action" onClick={() => updatePad(selected, { reverse: !current.reverse })} disabled={!current.buffer} aria-pressed={current.reverse} data-testid="button-reverse-sample">{current.reverse ? 'Reverse on' : 'Reverse'}</button>
                <button className="small-action" onClick={detectSelectedBpm} disabled={!current.buffer} data-testid="button-detect-bpm">Detect BPM</button>
                <button className="small-action" onClick={() => void stretchSelectedToTempo()} disabled={!current.buffer} data-testid="button-stretch-tempo">Stretch to {tempo}</button>
              </div>
              {current.buffer && <div className="sample-length">Source BPM {current.detectedBpm ?? '—'} · {current.reverse ? 'REVERSED' : 'FORWARD'}</div>}
              <div className="range-control">
                <label htmlFor="trim-start">Trim start <span>{Math.round(current.trimStart * 100)}%</span></label>
                <input id="trim-start" type="range" min="0" max={Math.max(0, current.trimEnd - 0.01)} step=".005" value={current.trimStart} disabled={!current.buffer} onChange={event => updatePad(selected, { trimStart: Math.min(Number(event.target.value), current.trimEnd - 0.01) })} data-testid="input-trim-start" />
              </div>
              <div className="range-control">
                <label htmlFor="trim-end">Trim end <span>{Math.round(current.trimEnd * 100)}%</span></label>
                <input id="trim-end" type="range" min={Math.min(1, current.trimStart + 0.01)} max="1" step=".005" value={current.trimEnd} disabled={!current.buffer} onChange={event => updatePad(selected, { trimEnd: Math.max(Number(event.target.value), current.trimStart + 0.01) })} data-testid="input-trim-end" />
              </div>
              <div className="editor-actions">
                <label className="mini-select">Slice count
                  <select value={sliceCount} onChange={event => setSliceCount(Number(event.target.value))} data-testid="select-slice-count">
                    {[2, 4, 8, 16].map(count => <option key={count} value={count}>{count} slices</option>)}
                  </select>
                </label>
                <button className="small-action" onClick={() => void sliceSelectedSample()} disabled={!current.buffer} data-testid="button-slice-sample">Slice across pads</button>
              </div>
              <div className="editor-grid">
                <label>Pitch <span>{current.pitch > 0 ? '+' : ''}{current.pitch} st</span><input type="range" min="-12" max="12" step="1" value={current.pitch} onChange={event => updatePad(selected, { pitch: Number(event.target.value) })} data-testid="input-pitch" /></label>
                <label>Filter <span>{current.filterCutoff >= 1000 ? `${(current.filterCutoff / 1000).toFixed(1)}k` : `${Math.round(current.filterCutoff)} Hz`}</span><input type="range" min="80" max="18000" step="20" value={current.filterCutoff} onChange={event => updatePad(selected, { filterCutoff: Number(event.target.value) })} data-testid="input-filter" /></label>
                <label>Drive <span>{Math.round(current.distortion * 100)}%</span><input type="range" min="0" max="1" step=".01" value={current.distortion} onChange={event => updatePad(selected, { distortion: Number(event.target.value) })} data-testid="input-distortion" /></label>
                <label>Fade in <span>{current.fadeIn.toFixed(2)}s</span><input type="range" min="0" max="1" step=".01" value={current.fadeIn} onChange={event => updatePad(selected, { fadeIn: Number(event.target.value) })} data-testid="input-fade-in" /></label>
                <label>Fade out <span>{current.fadeOut.toFixed(2)}s</span><input type="range" min="0" max="1" step=".01" value={current.fadeOut} onChange={event => updatePad(selected, { fadeOut: Number(event.target.value) })} data-testid="input-fade-out" /></label>
                <label>Attack <span>{current.attack.toFixed(2)}s</span><input type="range" min="0" max="1" step=".01" value={current.attack} onChange={event => updatePad(selected, { attack: Number(event.target.value) })} data-testid="input-envelope-attack" /></label>
                <label>Decay <span>{current.decay.toFixed(2)}s</span><input type="range" min="0" max="1" step=".01" value={current.decay} onChange={event => updatePad(selected, { decay: Number(event.target.value) })} data-testid="input-envelope-decay" /></label>
                <label>Sustain <span>{Math.round(current.sustain * 100)}%</span><input type="range" min="0" max="1" step=".01" value={current.sustain} onChange={event => updatePad(selected, { sustain: Number(event.target.value) })} data-testid="input-envelope-sustain" /></label>
                <label>Release <span>{current.release.toFixed(2)}s</span><input type="range" min=".01" max="1" step=".01" value={current.release} onChange={event => updatePad(selected, { release: Number(event.target.value) })} data-testid="input-envelope-release" /></label>
              </div>
              <div className="editor-actions">
                <label className="mini-select">Choke group
                  <select value={current.chokeGroup} onChange={event => updatePad(selected, { chokeGroup: event.target.value })} data-testid="select-choke-group">
                    <option value="">None</option><option value="A">A</option><option value="B">B</option>
                  </select>
                </label>
                <label className="mini-select">Step chance
                  <select value={current.probability} onChange={event => updatePad(selected, { probability: Number(event.target.value) })} data-testid="select-step-probability">
                    {[100, 75, 50, 25].map(value => <option key={value} value={value}>{value}%</option>)}
                  </select>
                </label>
                <label className="mini-select">Ratchets
                  <select value={current.ratchets} onChange={event => updatePad(selected, { ratchets: Number(event.target.value) })} data-testid="select-ratchets">
                    {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}×</option>)}
                  </select>
                </label>
                <label className="checkline"><input type="checkbox" checked={current.flam} onChange={event => updatePad(selected, { flam: event.target.checked })} data-testid="toggle-flam" /> Flam</label>
              </div>
            </details>
            <div className="keyboard-hint" data-testid="text-keyboard-hint">KEY {PAD_KEYS[selected]} · {current.buffer ? 'Ready to play' : 'Slot ready for a sound'}</div>
          </div>

          <div className="panel video-tools-panel">
            <div className="panel-head">
              <div className="panel-heading"><span className="section-index">V /</span><h2>Video chop station</h2></div>
              <span className="hint">PREVIEW + LOCAL CLIPS</span>
            </div>
            <div className="video-tools-body">
              <div className="video-subhead">YouTube preview</div>
              <div className="video-link-row">
                <input
                  type="url"
                  value={youtubeUrl}
                  onChange={event => setYoutubeUrl(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') loadYoutubePreview(); }}
                  placeholder="Paste a YouTube link"
                  aria-label="YouTube video link"
                  data-testid="input-youtube-link"
                />
                <button className="small-action" onClick={loadYoutubePreview} data-testid="button-load-youtube">Preview</button>
              </div>
              {youtubeId && <div className="youtube-player-frame"><div className="youtube-player-host" ref={youtubePlayerHostRef} /></div>}
              {youtubeId && <div className="cue-controls">
                <label>In <input type="number" min="0" step=".05" value={youtubeStart} onChange={event => setYoutubeStart(Math.max(0, Number(event.target.value) || 0))} data-testid="input-youtube-in" /></label>
                <button className="small-action" onClick={() => setYoutubeCue('start')} disabled={!youtubeReady} data-testid="button-youtube-set-in">Set at playhead</button>
                <label>Out <input type="number" min="0" step=".05" value={youtubeEnd} onChange={event => setYoutubeEnd(Math.max(youtubeStart + 0.05, Number(event.target.value) || 0))} data-testid="input-youtube-out" /></label>
                <button className="small-action" onClick={() => setYoutubeCue('end')} disabled={!youtubeReady} data-testid="button-youtube-set-out">Set at playhead</button>
                <button className="small-action" onClick={toggleYoutubeRange} disabled={!youtubeReady} data-testid="button-youtube-loop">{youtubeLoop ? 'Stop range' : 'Loop range'}</button>
              </div>}
              {youtubeId && <div className="youtube-pad-action">
                <button
                  className="small-action"
                  onClick={() => void captureVideoClipToPad(youtubeStart, youtubeEnd, true)}
                  disabled={!youtubeReady || !localVideoUrl || localVideoDuration < youtubeEnd || videoBusy}
                  data-testid="button-youtube-cue-to-pad"
                >
                  {videoBusy ? 'Capturing…' : `Add local cue to pad ${selected + 1}`}
                </button>
                <span>{!localVideoUrl ? 'Choose a matching local video below to enable.' : localVideoDuration < youtubeEnd ? 'The local video must be at least as long as the cue.' : 'Uses the matching time range from your local video, not YouTube audio.'}</span>
              </div>}
              {youtubeMessage && <p className="video-message" role="status">{youtubeMessage}</p>}
              <p className="video-legal-note">YouTube links play in YouTube’s embedded player; this app can’t extract or export their audio. Load a matching local video file you have rights to sample below to put its cue range on a pad.</p>

              <div className="video-divider" />
              <div className="video-subhead">Chop a local video into pads</div>
              <button className="video-file-button" onClick={() => localVideoInputRef.current?.click()} data-testid="button-choose-video">
                <Upload size={13} /> {localVideoName || 'Choose a video file'}
              </button>
              {localVideoUrl && <video
                className="local-video-player"
                ref={localVideoRef}
                src={localVideoUrl}
                controls
                playsInline
                onLoadedMetadata={event => {
                  const duration = event.currentTarget.duration;
                  setLocalVideoDuration(duration);
                  setClipStart(0);
                  setClipEnd(Math.min(3, duration));
                  setVideoMessage(`Video ready · ${formatTime(duration)} · ${Math.round(event.currentTarget.videoWidth)}×${Math.round(event.currentTarget.videoHeight)}`);
                }}
                onTimeUpdate={event => {
                  const video = event.currentTarget;
                  if (localVideoLoop && video.currentTime >= clipEnd) {
                    video.currentTime = clipStart;
                    void video.play().catch(() => setLocalVideoLoop(false));
                  }
                }}
                onError={() => setVideoMessage('This video format could not be opened by the browser. Try MP4 or WebM.')}
                data-testid="video-local-source"
              />}
              {localVideoUrl && <div className="video-clip-controls">
                <label>Start <input type="number" min="0" max={localVideoDuration || undefined} step=".01" value={clipStart} onChange={event => setClipStart(Math.min(localVideoDuration || 0, Math.max(0, Number(event.target.value) || 0)))} data-testid="input-video-start" /></label>
                <button className="small-action" onClick={() => setClipStart(Math.max(0, Math.min(clipEnd - 0.05, localVideoRef.current?.currentTime ?? 0)))} data-testid="button-video-set-in">Set at playhead</button>
                <label>End <input type="number" min="0.05" max={localVideoDuration || undefined} step=".01" value={clipEnd} onChange={event => setClipEnd(Math.max(clipStart + 0.05, Math.min(localVideoDuration || Infinity, Number(event.target.value) || 0.05)))} data-testid="input-video-end" /></label>
                <button className="small-action" onClick={() => setClipEnd(Math.max(clipStart + 0.05, Math.min(localVideoDuration || Infinity, localVideoRef.current?.currentTime ?? clipEnd)))} data-testid="button-video-set-out">Set at playhead</button>
                <button className="small-action" onClick={() => {
                  const video = localVideoRef.current;
                  if (!video) return;
                  if (localVideoLoop) { setLocalVideoLoop(false); video.pause(); }
                  else { video.currentTime = clipStart; setLocalVideoLoop(true); void video.play().catch(() => setLocalVideoLoop(false)); }
                }} disabled={videoBusy} data-testid="button-video-loop">{localVideoLoop ? 'Stop range' : 'Loop range'}</button>
                <div className="video-slice-row">
                  <label>Split into
                    <select value={videoSliceCount} onChange={event => setVideoSliceCount(Number(event.target.value))} data-testid="select-video-slices">
                      {[2, 4, 8, 16].map(count => <option key={count} value={count}>{count} pads</option>)}
                    </select>
                  </label>
                  <button className="small-action" onClick={() => void sliceLocalVideoToPads()} disabled={videoBusy || localVideoDuration <= 0} data-testid="button-video-slice">{videoBusy ? 'Capturing…' : 'Chop range to pads'}</button>
                  <button className="small-action" onClick={() => void captureVideoClipToPad()} disabled={videoBusy || localVideoDuration <= 0} data-testid="button-video-add-clip">{videoBusy ? 'Capturing…' : `Add clip to pad ${selected + 1}`}</button>
                </div>
              </div>}
              {videoMessage && <p className="video-message" role="status" data-testid="status-video-message">{videoMessage}</p>}
              <p className="video-legal-note">Local video and extracted clips stay on this device. Clip audio is saved as WAV on the selected pads.</p>
            </div>
          </div>

          <div className="panel sequencer-panel">
            <div className="panel-head">
              <div className="panel-heading"><span className="section-index">02 /</span><h2>16-step sequencer</h2></div>
              <span className="hint" data-testid="status-sequencer">{playing ? (songPlaying ? 'SONG PLAYING' : 'PATTERN PLAYING') : 'READY'}</span>
            </div>
            <div className="pattern-tabs" role="tablist" aria-label="Patterns">
              {patterns.map((_, index) => <button key={index} className={currentPattern === index ? 'active' : ''} onClick={() => { setCurrentPattern(index); setCurrentStep(-1); }} role="tab" aria-selected={currentPattern === index} data-testid={`button-pattern-${index + 1}`}>Pattern {String.fromCharCode(65 + index)}</button>)}
            </div>
            <div className="seq-top">
              <label className="tempo-box">BPM <input type="number" min="50" max="180" value={tempo} onChange={event => setTempo(Math.max(50, Math.min(180, Number(event.target.value) || 50)))} data-testid="input-tempo" /></label>
              <div className="seq-actions">
                <button className={`transport ${playing && !songPlaying ? 'stop' : ''}`} onClick={() => playing ? stopSequence() : void startSequence('pattern')} data-testid="button-sequencer-transport">{playing && !songPlaying ? <><Pause size={12} /> Stop</> : <><Play size={12} /> Play pattern</>}</button>
                <button className={`transport ${songPlaying ? 'stop' : ''}`} onClick={() => songPlaying ? stopSequence() : void startSequence('song')} data-testid="button-play-arrangement">{songPlaying ? <><Pause size={12} /> Stop song</> : <><Play size={12} /> Play song</>}</button>
                <button className="text-action" onClick={clearSequence} data-testid="button-clear-sequencer">Clear</button>
              </div>
            </div>
            <div className="groove-controls">
              <label className="range-control">Swing <span>{Math.round(swing * 100)}%</span><input type="range" min="0" max=".6" step=".01" value={swing} onChange={event => setSwing(Number(event.target.value))} data-testid="input-swing" /></label>
              <label className="mini-select">Record quantize
                <select value={quantize} onChange={event => setQuantize(Number(event.target.value))} data-testid="select-quantize">
                  <option value="1">1/16</option><option value="2">1/8</option><option value="4">1/4</option>
                </select>
              </label>
              <button className={`small-action ${recordMode ? 'recording' : ''}`} onClick={() => setRecordMode(!recordMode)} aria-pressed={recordMode} data-testid="button-record-mode">{recordMode ? '● Recording' : '● Record pads'}</button>
            </div>
            <div className="arrangement-row" aria-label="Four-bar song arrangement">
              <span className="arrangement-label">SONG</span>
              {arrangement.map((patternIndex, barIndex) => (
                <label key={barIndex}>Bar {barIndex + 1}
                  <select value={patternIndex} onChange={event => setArrangement(old => old.map((value, index) => index === barIndex ? Number(event.target.value) : value))} data-testid={`select-arrangement-bar-${barIndex + 1}`}>
                    {patterns.map((_, index) => <option key={index} value={index}>Pattern {String.fromCharCode(65 + index)}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <div className="step-scroll">
              <div className="step-header"><span></span>{Array.from({ length: 16 }, (_, i) => <span key={i}>{i % 4 === 0 ? String(i + 1).padStart(2, '0') : '·'}</span>)}</div>
              {pads.map((pad, padIndex) => (
                <div className="seq-row" key={padIndex}>
                  <button className="seq-pad" onClick={() => setSelected(padIndex)} data-testid={`button-sequencer-pad-${padIndex + 1}`} title={`Select pad ${padIndex + 1}`}><b>{String(padIndex + 1).padStart(2, '0')}</b><span>{pad.name ? pad.name.replace(/\.[^.]+$/, '') : '—'}</span></button>
                  {steps[padIndex].map((active, stepIndex) => <button key={stepIndex} className={`step ${active ? 'active' : ''} ${currentStep === stepIndex ? 'current' : ''}`} onClick={() => toggleStep(padIndex, stepIndex)} aria-label={`Pad ${padIndex + 1}, step ${stepIndex + 1}, ${active ? 'on' : 'off'}`} aria-pressed={active} data-testid={`button-step-${padIndex + 1}-${stepIndex + 1}`} />)}
                </div>
              ))}
            </div>
            <div className="step-count"><span data-testid="text-active-step-count">{stepCount} steps lit</span><span>1 BAR · 4/4</span></div>
          </div>
        </div>
      </section>

      <section className="bottom-grid">
        <div className="panel export-panel">
          <div className="bottom-title"><span className="section-index">03 /</span><h2>Take it to your DAW</h2></div>
          <div className="export-actions">
            <button className="export-button" onClick={() => void exportMix()} data-testid="button-export-loop"><Download size={14} /> Export loop mixdown <span className="hint">WAV</span></button>
            <button className="export-button" onClick={() => current.buffer ? exportPad(selected) : setError('Load a sound onto the selected pad to export its WAV.')} disabled={!current.buffer} data-testid="button-export-pad"><FileAudio2 size={14} /> Export selected pad <span className="hint">WAV</span></button>
            <button className="export-button" onClick={exportMidi} data-testid="button-export-midi"><Download size={14} /> Export MIDI arrangement <span className="hint">MIDI</span></button>
            <button className="export-button" onClick={() => void exportKitZip()} data-testid="button-export-kit-zip"><Download size={14} /> Export kit pack <span className="hint">ZIP</span></button>
          </div>
          <div className="kit-manager">
            <div className="kit-manager-title">SAVE & RECALL KITS</div>
            <div className="kit-controls">
              <input aria-label="Kit name" value={kitName} onChange={event => setKitName(event.target.value)} placeholder="Kit name" data-testid="input-kit-name" />
              <button className="small-action" onClick={() => void saveCurrentKit()} data-testid="button-save-kit">Save kit</button>
            </div>
            <div className="kit-controls">
              <select aria-label="Saved kits" value={selectedKit} onChange={event => setSelectedKit(event.target.value)} data-testid="select-saved-kit">
                <option value="">Choose a saved kit</option>
                {savedKits.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
              <button className="small-action" onClick={() => void loadSavedKit()} disabled={!selectedKit} data-testid="button-load-saved-kit">Load</button>
              <button className="text-action" onClick={() => void removeSavedKit()} disabled={!selectedKit} data-testid="button-delete-saved-kit">Delete</button>
            </div>
          </div>
          <div className="global-effects">
            <div className="kit-manager-title">MASTER EFFECTS</div>
            <label>Reverb <span>{Math.round(effects.reverb * 100)}%</span><input type="range" min="0" max=".8" step=".01" value={effects.reverb} onChange={event => setEffects(old => ({ ...old, reverb: Number(event.target.value) }))} data-testid="input-reverb" /></label>
            <label>Delay <span>{Math.round(effects.delay * 100)}%</span><input type="range" min="0" max=".8" step=".01" value={effects.delay} onChange={event => setEffects(old => ({ ...old, delay: Number(event.target.value) }))} data-testid="input-delay" /></label>
          </div>
          <p className="export-caption" data-testid="text-export-guidance">Import these WAV files into FL Studio or Waveform. PadLoop is a browser sampler—not a VST or AU plugin.</p>
          {error && <div className="error-line" role="alert" data-testid="status-error">{error}</div>}
        </div>
        <div className="panel guide-panel">
          <div className="bottom-title"><span className="section-index">i /</span><h2>Made for the session</h2></div>
          <p className="guide-copy"><strong>Your files stay yours.</strong> Samples and local video clips are processed and saved on this device where browser storage allows. YouTube previews load from YouTube; their audio cannot be extracted here. Export WAV or MIDI for FL Studio and Waveform.</p>
          <div className="volume-control" style={{ marginTop: 11 }}><Volume2 size={14} color="#969d9e" /><label htmlFor="master-volume">MASTER</label><input id="master-volume" type="range" min="0" max="1" step=".01" value={master} onChange={event => setMaster(Number(event.target.value))} data-testid="input-master-volume" /><span className="hint">{Math.round(master * 100)}%</span></div>
        </div>
      </section>
      <footer className="footer"><span>PADLOOP SAMPLER · 16 SLOTS · NO INSTALL</span><span>KEYBOARD: Q W E R / A S D F / Z X C V / 1 2 3 4</span></footer>
      <input ref={localVideoInputRef} type="file" accept="video/*,.mp4,.webm,.mov,.m4v,.ogv,.mkv" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) chooseLocalVideo(file); }} data-testid="input-local-video-file" />
      <input ref={inputRef} type="file" accept="audio/*,.wav,.wave,.mp3,.m4a,.aac,.ogg,.oga,.flac,.aif,.aiff,.webm" hidden onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void importFile(file, selectedRef.current); }} data-testid="input-sample-file" />
      {notice && <div className="notice" role="status" data-testid="status-notice">{notice}</div>}
    </main>
  );
}

export default App;
