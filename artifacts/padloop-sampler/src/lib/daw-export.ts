export type MidiPadSettings = {
  probability: number;
  volume: number;
  ratchets: number;
  flam: boolean;
};

type MidiEvent = { tick: number; bytes: number[]; order: number };

function variableLength(value: number) {
  let buffer = value & 0x7f;
  const bytes: number[] = [];
  while ((value >>= 7) > 0) {
    buffer <<= 8;
    buffer |= ((value & 0x7f) | 0x80);
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

function push16(target: number[], value: number) {
  target.push((value >> 8) & 0xff, value & 0xff);
}

function push32(target: number[], value: number) {
  target.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

export function buildMidiFile(
  bpm: number,
  patterns: boolean[][][],
  arrangement: number[],
  padSettings: MidiPadSettings[],
  swing = 0,
) {
  const events: MidiEvent[] = [];
  const microsecondsPerBeat = Math.round(60_000_000 / bpm);
  events.push({ tick: 0, bytes: [0xff, 0x51, 0x03, (microsecondsPerBeat >> 16) & 0xff, (microsecondsPerBeat >> 8) & 0xff, microsecondsPerBeat & 0xff], order: -3 });
  events.push({ tick: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8], order: -2 });
  const ticksPerStep = 30;
  let seed = 91;

  arrangement.forEach((patternIndex, bar) => {
    const pattern = patterns[patternIndex] ?? patterns[0];
    if (!pattern) return;
    for (let pad = 0; pad < 16; pad++) {
      const settings = padSettings[pad] ?? { probability: 100, volume: 0.85, ratchets: 1, flam: false };
      const note = 36 + pad;
      for (let step = 0; step < 16; step++) {
        if (!pattern[pad]?.[step]) continue;
        seed = (seed * 16807) % 2147483647;
        if ((seed / 2147483647) * 100 > settings.probability) continue;
        const swingTicks = step % 2 ? Math.round(ticksPerStep * Math.max(0, Math.min(0.6, swing)) * 0.45) : 0;
        const baseTick = bar * 480 + step * ticksPerStep + swingTicks;
        const ratchets = Math.max(1, Math.min(4, settings.ratchets));
        const subdivision = Math.max(1, Math.floor(ticksPerStep / ratchets));
        const velocity = Math.max(1, Math.min(127, Math.round(settings.volume * 108)));
        for (let hit = 0; hit < ratchets; hit++) {
          const tick = baseTick + hit * subdivision;
          const noteLength = Math.max(1, Math.floor(subdivision * 0.72));
          events.push({ tick, bytes: [0x99, note, velocity], order: 1 });
          events.push({ tick: tick + noteLength, bytes: [0x89, note, 0], order: 0 });
        }
        if (settings.flam) {
          const flamTick = baseTick + 5;
          events.push({ tick: flamTick, bytes: [0x99, note, Math.max(1, Math.round(velocity * 0.68))], order: 1 });
          events.push({ tick: flamTick + 3, bytes: [0x89, note, 0], order: 0 });
        }
      }
    }
  });

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track: number[] = [];
  let lastTick = 0;
  for (const event of events) {
    track.push(...variableLength(Math.max(0, event.tick - lastTick)), ...event.bytes);
    lastTick = event.tick;
  }
  track.push(...variableLength(0), 0xff, 0x2f, 0x00);

  const file: number[] = [];
  file.push(0x4d, 0x54, 0x68, 0x64);
  push32(file, 6);
  push16(file, 0);
  push16(file, 1);
  push16(file, 120);
  file.push(0x4d, 0x54, 0x72, 0x6b);
  push32(file, track.length);
  file.push(...track);
  return new Blob([new Uint8Array(file)], { type: 'audio/midi' });
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function joinBytes(parts: Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

export async function buildZip(files: { name: string; data: Blob | Uint8Array }[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.data instanceof Blob ? new Uint8Array(await file.data.arrayBuffer()) : file.data;
    const checksum = crc32(data);
    const local: number[] = [0x50, 0x4b, 0x03, 0x04];
    push16(local, 20); push16(local, 0); push16(local, 0); push16(local, 0); push16(local, 0);
    push32(local, checksum); push32(local, data.length); push32(local, data.length);
    push16(local, name.length); push16(local, 0);
    const localRecord = joinBytes([new Uint8Array(local), name, data]);
    localParts.push(localRecord);

    const central: number[] = [0x50, 0x4b, 0x01, 0x02];
    push16(central, 20); push16(central, 20); push16(central, 0); push16(central, 0);
    push16(central, 0); push16(central, 0); push32(central, checksum);
    push32(central, data.length); push32(central, data.length);
    push16(central, name.length); push16(central, 0); push16(central, 0);
    push16(central, 0); push16(central, 0); push32(central, 0); push32(central, localOffset);
    const centralRecord = joinBytes([new Uint8Array(central), name]);
    centralParts.push(centralRecord);
    localOffset += localRecord.length;
  }

  const centralDirectory = joinBytes(centralParts);
  const end: number[] = [0x50, 0x4b, 0x05, 0x06];
  push16(end, 0); push16(end, 0); push16(end, files.length); push16(end, files.length);
  push32(end, centralDirectory.length); push32(end, localOffset); push16(end, 0);
  const archive = joinBytes([...localParts, centralDirectory, new Uint8Array(end)]);
  return new Blob([archive.buffer as ArrayBuffer], { type: 'application/zip' });
}
