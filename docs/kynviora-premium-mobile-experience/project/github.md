repo: Arjun0014/Kynviora
branch: master
path: apps/mobile/src, packages/presentation/src, packages/domain/src

## Last sync

date: 2026-09-08T17:20:00Z

### Updated in this project

- Refined the approved V2 direction into V3: persistent Talk to Kynviora bar, Health rebuilt as a four-layer medical record, Care rebuilt as a household, You rebuilt as a settings hub, and a new change/attention colour language.
- Added lab and annual-checkup experiences (reference bands, latest-vs-previous, year-on-year Change Lens) grounded in the domain vocabulary's evidence and verification concepts.
- V1 and V2 artifacts preserved for comparison. No repo files were modified; this project holds design artifacts only.

## Sync history

- 2026-09-08T09:40:00Z — V2 prototype, artboards and design language from the V2 brief.
- 2026-09-07T13:05:00Z — V1 prototype, artboards and design language from tokens, status vocabulary and the five destinations.

## Screen map

| Project screen | Repo files it was built from |
| --- | --- |
| Tones, surfaces, type (V1–V3) | packages/presentation/src/tokens.ts, packages/presentation/src/status.ts |
| Categories, jurisdictions, evidence/urgency, statuses, capabilities | packages/domain/src/vocabulary.ts |
| V3 Talk bar, eight states, touch-only refusals | packages/agent/src (registry, dispatcher, speech) via VOICE_MODE.md |
| V3 Care permissions and revocation | packages/domain/src/vocabulary.ts (caregiver capabilities) |
| V3 Camera capture | apps/mobile/src/voice/VoiceScreen.tsx, VOICE_MODE.md §7 |
| V1 Today / Shelf / Safety / Care / You | apps/mobile/src/app/(tabs)/*.tsx, apps/mobile/src/features/** |
