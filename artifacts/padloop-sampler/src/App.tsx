import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Activity, AudioLines, Download, FileAudio2, Headphones, Pause, Play, Plus, Repeat, Upload, Volume2, X } from 'lucide-react';

type Pad = {
  name: string;
  duration: number;
  buffer: AudioBuffer | null;
  bars: number[];
  loop: boolean;
  volume: number;
};

const PAD_KEYS = ['Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V', '1', '2', '3', '4'];
const padColors = ['#f1b95e', '#e88e70', '#75c9a4', '#a4a1dc', '#e9829c', '#79b9dc', '#d3a66d', '#78c8ad', '#db8d66', '#90b5da', '#b4a2d9', '#d5bd6b', '#75c6b1', '#df8e87', '#86b7dc', '#b1a0d5'];
const emptyPad = (): Pad => ({ name: '', duration: 0, buffer: null, bars: [], loop: false, volume: 0.85 });
const makePads = () => Array.from({ length: 16 }, emptyPad);
const DB_NAME = 'padloop-local-kit';
const DB_STORE = 'samples';

function openSampleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('Local sample storage is unavailable in this browser.'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local sample storage.'));
  });
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
      result.push({ index: Number(key), pad: { name: file instanceof File ? file.name : `sample-${Number(key) + 1}.wav`, duration: buffer.duration, buffer, bars: makeWave(buffer), loop: false, volume: 0.85 } });
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
  const [steps, setSteps] = useState<boolean[][]>(() => Array.from({ length: 16 }, () => Array(16).fill(false)));
  const [selected, setSelected] = useState(0);
  const [tempo, setTempo] = useState(96);
  const [master, setMaster] = useState(.8);
  const [playing, setPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [ready, setReady] = useState(false);
  const [activePads, setActivePads] = useState<Set<number>>(() => new Set());
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const sourceRefs = useRef<Map<number, AudioBufferSourceNode>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);
  const seqIndexRef = useRef(-1);
  const selectedRef = useRef(0);
  const padsRef = useRef(pads);
  const stepsRef = useRef(steps);
  const masterValueRef = useRef(master);
  padsRef.current = pads; stepsRef.current = steps; selectedRef.current = selected; masterValueRef.current = master;

  const context = useCallback(() => {
    if (!audioRef.current) {
      const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextConstructor) throw new Error('Web Audio is not supported by this browser.');
      audioRef.current = new AudioContextConstructor();
      const gain = audioRef.current.createGain();
      gain.gain.value = masterValueRef.current;
      gain.connect(audioRef.current.destination);
      masterRef.current = gain;
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
              restored.forEach(item => { next[item.index] = item.pad; });
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

  const playPad = useCallback(async (index: number) => {
    const pad = padsRef.current[index];
    if (!pad?.buffer) {
      setSelected(index);
      return;
    }
    try {
      const audio = context();
      if (audio.state !== 'running') await audio.resume();
      const previous = sourceRefs.current.get(index);
      if (previous) { try { previous.stop(); } catch { /* already stopped */ } }
      const source = audio.createBufferSource();
      const gain = audio.createGain();
      source.buffer = pad.buffer;
      source.loop = pad.loop;
      gain.gain.value = pad.volume;
      source.connect(gain);
      gain.connect(masterRef.current ?? audio.destination);
      sourceRefs.current.set(index, source);
      setActivePads(old => new Set(old).add(index));
      source.onended = () => {
        if (sourceRefs.current.get(index) === source) {
          sourceRefs.current.delete(index);
          setActivePads(old => { const next = new Set(old); next.delete(index); return next; });
        }
      };
      source.start();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This sound could not be played.');
    }
  }, [context]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('padloop-kit-meta');
      if (saved) {
        const meta = JSON.parse(saved) as { tempo?: number; master?: number; steps?: boolean[][]; pads?: { volume?: number; loop?: boolean }[] };
        if (meta.tempo) setTempo(Math.min(180, Math.max(50, meta.tempo)));
        if (meta.master !== undefined) setMaster(meta.master);
        if (meta.steps?.length === 16) setSteps(meta.steps);
        if (meta.pads?.length === 16) setPads(old => old.map((pad, index) => ({ ...pad, volume: meta.pads?.[index]?.volume ?? pad.volume, loop: meta.pads?.[index]?.loop ?? pad.loop })));
      }
    } catch { /* Ignore malformed browser-local metadata. */ }
  }, []);

  useEffect(() => {
    const metadata = { tempo, master, steps, pads: pads.map(({ volume, loop }) => ({ volume, loop })) };
    try { localStorage.setItem('padloop-kit-meta', JSON.stringify(metadata)); } catch { /* Storage can be disabled or full. */ }
  }, [tempo, master, steps, pads]);

  useEffect(() => {
    if (masterRef.current) masterRef.current.gain.setTargetAtTime(master, audioRef.current?.currentTime ?? 0, .015);
  }, [master]);

  const stopSequence = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
    setCurrentStep(-1);
    seqIndexRef.current = -1;
  }, []);

  const startSequence = useCallback(async () => {
    await unlockAudio();
    const audio = audioRef.current;
    if (!audio || audio.state !== 'running') return;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    setPlaying(true);
    const tick = () => {
      seqIndexRef.current = (seqIndexRef.current + 1) % 16;
      const index = seqIndexRef.current;
      setCurrentStep(index);
      for (let pad = 0; pad < 16; pad++) if (stepsRef.current[pad][index]) void playPad(pad);
    };
    tick();
    timerRef.current = window.setInterval(tick, 60000 / Math.max(50, tempo) / 4);
  }, [playPad, tempo, unlockAudio]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
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

  const chooseFile = (index: number) => { setSelected(index); if (inputRef.current) { inputRef.current.value = ''; inputRef.current.click(); } };
  const removePad = (index: number) => {
    const source = sourceRefs.current.get(index);
    if (source) { try { source.stop(); } catch { /* already stopped */ } sourceRefs.current.delete(index); }
    setPads(old => old.map((pad, slot) => slot === index ? emptyPad() : pad));
    setSteps(old => old.map((row, slot) => slot === index ? Array(16).fill(false) : row));
    void removePersistedSample(index);
    setError('');
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement)?.tagName ?? '')) return;
      const index = PAD_KEYS.indexOf(event.key.toUpperCase());
      if (index < 0) return;
      event.preventDefault();
      setSelected(index);
      void playPad(index);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playPad]);

  const toggleStep = (pad: number, step: number) => setSteps(old => old.map((row, i) => i === pad ? row.map((active, j) => j === step ? !active : active) : row));
  const clearSequence = () => { setSteps(Array.from({ length: 16 }, () => Array(16).fill(false))); setCurrentStep(-1); };

  const exportMix = async () => {
    const audioPads = padsRef.current;
    const pattern = stepsRef.current;
    if (!audioPads.some((pad, index) => pad.buffer && pattern[index].some(Boolean))) {
      setError('Add a sample and turn on at least one sequencer step before exporting a loop.');
      return;
    }
    try {
      const bpm = tempo;
      const stepSeconds = 60 / bpm / 4;
      const length = Math.ceil(stepSeconds * 16 * 44100);
      const Offline = window.OfflineAudioContext || (window as typeof window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      if (!Offline) throw new Error('WAV rendering is not supported by this browser.');
      const offline = new Offline(2, length, 44100);
      const masterGain = offline.createGain();
      masterGain.gain.value = masterValueRef.current;
      masterGain.connect(offline.destination);
      audioPads.forEach((pad, padIndex) => {
        if (!pad.buffer) return;
        pattern[padIndex].forEach((active, stepIndex) => {
          if (!active) return;
          const source = offline.createBufferSource();
          const gain = offline.createGain();
          source.buffer = pad.buffer;
          source.loop = pad.loop;
          gain.gain.value = pad.volume;
          source.connect(gain); gain.connect(masterGain);
          const at = stepIndex * stepSeconds;
          source.start(at);
          if (pad.loop) source.stop(Math.min(length / 44100, at + stepSeconds));
        });
      });
      const rendered = await offline.startRendering();
      saveBlob(encodeWav(rendered), `padloop-${bpm}bpm-loop.wav`);
      setError('');
      setNotice('Loop mixdown downloaded as WAV');
      window.setTimeout(() => setNotice(''), 2600);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The loop could not be rendered.');
    }
  };

  const exportPad = (index: number) => {
    const buffer = pads[index].buffer;
    if (!buffer) return;
    saveBlob(encodeWav(buffer), `pad-${String(index + 1).padStart(2, '0')}-${pads[index].name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-')}.wav`);
    setNotice(`Pad ${String(index + 1).padStart(2, '0')} downloaded as WAV`);
    window.setTimeout(() => setNotice(''), 2600);
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
        <div className="local-pill" data-testid="status-local-only"><i className="local-dot" /> LOCAL ONLY <span>·</span> NO UPLOADS</div>
      </header>

      <section className="intro">
        <div>
          <div className="eyebrow">YOUR SOUNDS, YOUR POCKET KIT</div>
          <h1>Load it. Tap it. Loop it.</h1>
          <p>A little sampler for the sounds already on your device.</p>
        </div>
        <button className="start-audio" onClick={() => void unlockAudio()} data-testid="button-start-audio">
          <Headphones size={15} /> {ready ? 'Audio ready' : 'Start audio'} <span aria-hidden="true">↗</span>
        </button>
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
                onClick={() => { setSelected(index); if (pad.buffer) void playPad(index); }}
                onDragOver={event => { event.preventDefault(); setSelected(index); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void importFile(file, index); }}
                data-testid={`button-pad-${index + 1}`}
                aria-label={`Pad ${index + 1}${pad.name ? `, ${pad.name}` : ', empty'}. Keyboard ${PAD_KEYS[index]}`}
              >
                <span className="pad-top"><span>{String(index + 1).padStart(2, '0')}</span><span className="pad-key">{PAD_KEYS[index]}</span></span>
                {pad.name ? <span className="pad-name" data-testid={`text-pad-name-${index + 1}`}>{pad.name}</span> : <span className="pad-name pad-empty">Drop a sound</span>}
                <span className="pad-meta"><span>{pad.buffer ? formatTime(pad.duration) : 'EMPTY SLOT'}</span><span>{pad.loop ? 'LOOP' : pad.buffer ? 'ONE SHOT' : '·'}</span></span>
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
                <><div className="drop-icon"><AudioLines size={19} /></div><div className="sample-detail"><div className="sample-filename" data-testid="text-selected-sample">{current.name}</div><div className="sample-length" data-testid="text-sample-duration">{formatTime(current.duration)} · {current.buffer.numberOfChannels === 1 ? 'MONO' : 'STEREO'} · {Math.round(current.buffer.sampleRate / 1000)} kHz</div></div><button className="small-action" onClick={event => { event.stopPropagation(); void playPad(selected); }} data-testid="button-preview-sample"><Play size={13} /> Preview</button>{activePads.has(selected) && <button className="small-action" onClick={event => { event.stopPropagation(); const source = sourceRefs.current.get(selected); if (source) { try { source.stop(); } catch { /* already stopped */ } sourceRefs.current.delete(selected); } setActivePads(old => { const next = new Set(old); next.delete(selected); return next; }); }} data-testid="button-stop-sample"><Pause size={13} /> Stop</button>}</>
              ) : (
                <><div className="drop-icon"><Upload size={18} /></div><div className="drop-copy"><strong>Drop a sample here</strong><span>or click to browse · WAV, MP3, M4A, OGG, FLAC, AIFF</span></div><Plus size={16} color="#88918d" /></>
              )}
            </div>
            {current.buffer && <div className="sample-actions" style={{ marginTop: 10 }}>
              <button className="small-action" onClick={() => chooseFile(selected)} data-testid="button-replace-sample"><Upload size={12} /> Replace</button>
              <button className="small-action" onClick={() => exportPad(selected)} data-testid="button-export-selected-pad"><Download size={12} /> Download WAV</button>
            </div>}
            <div className="control-row">
              <div className="volume-control"><Volume2 size={14} color="#969d9e" /><label htmlFor="pad-volume">PAD VOL</label><input id="pad-volume" type="range" min="0" max="1" step=".01" value={current.volume} onChange={event => setPads(old => old.map((pad, index) => index === selected ? { ...pad, volume: Number(event.target.value) } : pad))} data-testid="input-pad-volume" /></div>
              <button className={`loop-toggle ${current.loop ? 'on' : ''}`} onClick={() => setPads(old => old.map((pad, index) => index === selected ? { ...pad, loop: !pad.loop } : pad))} data-testid="button-toggle-loop" aria-pressed={current.loop}><Repeat size={13} /> Loop {current.loop ? 'on' : 'off'}</button>
            </div>
            <div className="keyboard-hint" data-testid="text-keyboard-hint">KEY {PAD_KEYS[selected]} · {current.buffer ? 'Ready to play' : 'Slot ready for a sound'}</div>
          </div>

          <div className="panel sequencer-panel">
            <div className="panel-head">
              <div className="panel-heading"><span className="section-index">02 /</span><h2>16-step sequencer</h2></div>
              <span className="hint" data-testid="status-sequencer">{playing ? 'PLAYING' : 'READY'}</span>
            </div>
            <div className="seq-top">
              <label className="tempo-box">BPM <input type="number" min="50" max="180" value={tempo} onChange={event => setTempo(Math.max(50, Math.min(180, Number(event.target.value) || 50)))} data-testid="input-tempo" /></label>
              <div className="seq-actions">
                <button className={`transport ${playing ? 'stop' : ''}`} onClick={() => playing ? stopSequence() : void startSequence()} data-testid="button-sequencer-transport">{playing ? <><Pause size={12} /> Stop</> : <><Play size={12} /> Play loop</>}</button>
                <button className="text-action" onClick={clearSequence} data-testid="button-clear-sequencer">Clear</button>
              </div>
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
          </div>
          <p className="export-caption" data-testid="text-export-guidance">Import these WAV files into FL Studio or Waveform. PadLoop is a browser sampler—not a VST or AU plugin.</p>
          {error && <div className="error-line" role="alert" data-testid="status-error">{error}</div>}
        </div>
        <div className="panel guide-panel">
          <div className="bottom-title"><span className="section-index">i /</span><h2>Made for the session</h2></div>
          <p className="guide-copy"><strong>Your files stay yours.</strong> Samples live in this browser tab and are saved locally on this device where browser storage allows. Nothing is sent anywhere. Start audio once, load a sound, tap pads or map a rhythm, then export a standard WAV.</p>
          <div className="volume-control" style={{ marginTop: 11 }}><Volume2 size={14} color="#969d9e" /><label htmlFor="master-volume">MASTER</label><input id="master-volume" type="range" min="0" max="1" step=".01" value={master} onChange={event => setMaster(Number(event.target.value))} data-testid="input-master-volume" /><span className="hint">{Math.round(master * 100)}%</span></div>
        </div>
      </section>
      <footer className="footer"><span>PADLOOP SAMPLER · 16 SLOTS · NO INSTALL</span><span>KEYBOARD: Q W E R / A S D F / Z X C V / 1 2 3 4</span></footer>
      <input ref={inputRef} type="file" accept="audio/*,.wav,.wave,.mp3,.m4a,.aac,.ogg,.oga,.flac,.aif,.aiff,.webm" hidden onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void importFile(file, selectedRef.current); }} data-testid="input-sample-file" />
      {notice && <div className="notice" role="status" data-testid="status-notice">{notice}</div>}
    </main>
  );
}

export default App;
