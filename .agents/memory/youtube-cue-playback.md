---
name: YouTube cue playback
description: Product and technical boundaries for YouTube-linked cues in PadLoop.
---

Keep YouTube cues as playback in the visible YouTube player; do not extract the media or include it in local WAV/MIDI exports.

**Why:** YouTube cue pads store a video link and time range, not an owned, decoded audio buffer. The embed can seek and play the range but does not provide audio data for offline rendering.

**How to apply:** Preserve browser playback and cue-link persistence. Keep downloadable exports limited to local audio files unless the user supplies an independent local sample.
