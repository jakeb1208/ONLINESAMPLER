---
name: Mobile pad audio
description: Touch-first triggering rules for PadLoop's Web Audio pads.
---

Trigger loaded pads from the pointer-down handler on touch devices; release gate pads on pointer-up. Keep an accessible click fallback for keyboard or assistive activation, and suppress its duplicate after a pointer gesture.

**Why:** Web Audio startup can be gated by the browser's active user gesture. Starting from a later click can be unreliable in mobile Safari and embedded webviews.

**How to apply:** Keep `playPad` synchronous through its initial `AudioContext` creation/resume call inside pointer-down. Preserve pointer-up handling for gate mode, and test touch plus keyboard paths when changing pad event handlers.
