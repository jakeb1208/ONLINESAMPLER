export type EditableSample = {
  trimStart: number;
  trimEnd: number;
  reverse: boolean;
};

export type RenderSampleOptions = EditableSample & {
  pitch: number;
  fadeIn: number;
  fadeOut: number;
};

export function renderSample(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  options: RenderSampleOptions,
) {
  const startFrame = Math.floor(buffer.length * Math.max(0, Math.min(0.99, options.trimStart)));
  const endFrame = Math.max(startFrame + 1, Math.floor(buffer.length * Math.max(options.trimStart + 0.01, Math.min(1, options.trimEnd))));
  const rate = 2 ** (options.pitch / 12);
  const outputLength = Math.max(1, Math.ceil((endFrame - startFrame) / rate));
  const rendered = context.createBuffer(buffer.numberOfChannels, outputLength, buffer.sampleRate);
  const fadeInFrames = Math.max(0, Math.floor(options.fadeIn * buffer.sampleRate));
  const fadeOutFrames = Math.max(0, Math.floor(options.fadeOut * buffer.sampleRate));

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const source = buffer.getChannelData(channel);
    const target = rendered.getChannelData(channel);
    for (let index = 0; index < outputLength; index++) {
      const position = options.reverse
        ? endFrame - 1 - index * rate
        : startFrame + index * rate;
      const left = Math.max(startFrame, Math.min(endFrame - 1, Math.floor(position)));
      const right = Math.max(startFrame, Math.min(endFrame - 1, left + (options.reverse ? -1 : 1)));
      const mix = Math.abs(position - left);
      let sample = source[left] * (1 - mix) + source[right] * mix;
      const fadeIn = fadeInFrames ? Math.min(1, index / fadeInFrames) : 1;
      const fadeOut = fadeOutFrames ? Math.min(1, (outputLength - index - 1) / fadeOutFrames) : 1;
      sample *= Math.max(0, Math.min(fadeIn, fadeOut));
      target[index] = sample;
    }
  }
  return rendered;
}

export function reverseBuffer(context: BaseAudioContext, buffer: AudioBuffer) {
  const reversed = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const source = buffer.getChannelData(channel);
    const target = reversed.getChannelData(channel);
    for (let index = 0; index < source.length; index++) target[index] = source[source.length - index - 1];
  }
  return reversed;
}

export function detectBpm(buffer: AudioBuffer): number | null {
  const data = buffer.getChannelData(0);
  const frameSize = Math.max(1, Math.floor(buffer.sampleRate * 0.01));
  const frameCount = Math.min(6000, Math.floor(data.length / frameSize));
  if (frameCount < 100) return null;

  const energy = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameSize;
    const end = Math.min(data.length, start + frameSize);
    let sum = 0;
    for (let sample = start; sample < end; sample++) sum += data[sample] * data[sample];
    energy[frame] = Math.sqrt(sum / Math.max(1, end - start));
  }

  const onset = new Float32Array(frameCount);
  for (let index = 1; index < frameCount; index++) onset[index] = Math.max(0, energy[index] - energy[index - 1]);

  let bestBpm = 0;
  let bestScore = 0;
  for (let bpm = 60; bpm <= 180; bpm++) {
    const lag = Math.round(6000 / bpm);
    let score = 0;
    for (let frame = lag; frame < frameCount; frame++) score += onset[frame] * onset[frame - lag];
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  return bestScore > 0 ? bestBpm : null;
}

export function sliceBuffer(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  count: number,
  start = 0,
  end = 1,
) {
  const safeStart = Math.max(0, Math.min(0.999, start));
  const safeEnd = Math.max(safeStart + 0.001, Math.min(1, end));
  const startFrame = Math.floor(buffer.length * safeStart);
  const endFrame = Math.max(startFrame + count, Math.floor(buffer.length * safeEnd));
  const sliceLength = endFrame - startFrame;
  const slices: AudioBuffer[] = [];

  for (let part = 0; part < count; part++) {
    const partStart = startFrame + Math.floor((sliceLength * part) / count);
    const partEnd = Math.min(endFrame, startFrame + Math.floor((sliceLength * (part + 1)) / count));
    const length = Math.max(1, partEnd - partStart);
    const slice = context.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      slice.getChannelData(channel).set(buffer.getChannelData(channel).subarray(partStart, partStart + length));
    }
    slices.push(slice);
  }
  return slices;
}

export function stretchBuffer(context: BaseAudioContext, buffer: AudioBuffer, factor: number) {
  const stretch = Math.max(0.5, Math.min(2, factor));
  if (Math.abs(stretch - 1) < 0.015) return buffer;

  const grainSize = Math.min(4096, Math.max(1024, Math.round(buffer.sampleRate * 0.075)));
  const outputLength = Math.max(grainSize, Math.round(buffer.length * stretch));
  const output = context.createBuffer(buffer.numberOfChannels, outputLength, buffer.sampleRate);
  const window = new Float32Array(grainSize);
  for (let index = 0; index < grainSize; index++) {
    window[index] = 0.5 - 0.5 * Math.cos((Math.PI * 2 * index) / grainSize);
  }
  const weight = new Float32Array(outputLength);
  const outputHop = Math.floor(grainSize / 2);

  for (let outStart = 0; outStart < outputLength; outStart += outputHop) {
    const inStart = Math.floor(outStart / stretch);
    for (let index = 0; index < grainSize && outStart + index < outputLength && inStart + index < buffer.length; index++) {
      weight[outStart + index] += window[index];
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        output.getChannelData(channel)[outStart + index] += buffer.getChannelData(channel)[inStart + index] * window[index];
      }
    }
  }

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = output.getChannelData(channel);
    for (let index = 0; index < samples.length; index++) {
      if (weight[index] > 0.0001) samples[index] /= weight[index];
    }
  }
  return output;
}

export function makeImpulse(context: BaseAudioContext, seconds = 1.2) {
  const length = Math.floor(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index++) {
      const decay = Math.pow(1 - index / length, 2.5);
      data[index] = (Math.random() * 2 - 1) * decay;
    }
  }
  return impulse;
}
