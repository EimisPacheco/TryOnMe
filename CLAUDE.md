# Project: Gemini TryOnMe Everything

## Architecture Overview

Chrome extension (Manifest V3) + Node.js backend on Cloud Run + Python smart search service.

### Outfit Builder Flow

The outfit builder supports **6 categories**: top, bottom, shoes, necklace, earrings, bracelet.

1. **popup.js** reads all 6 fields and passes them as URL params to `wardrobe.html`
2. **wardrobe.js** fires up to 6 parallel `SMART_SEARCH` requests (one per category)
3. Items are rendered: tops/bottoms as hangers, shoes on a rack, accessories in a ceiling bar
4. User selects one item per category, clicks "Try On"
5. **wardrobe.js** sends a single `TRY_ON_OUTFIT` message with all selected garment images
6. **background.js** forwards to `POST /api/try-on/outfit` with the garments array
7. **tryOn.js `/outfit`** preprocesses all garments in parallel, then calls `geminiOutfitTryOn()` with 7 images: user profile photo + 6 garment images

## CRITICAL: Do NOT Change These Settings

### Models
- **Try-on generation**: `gemini-3-pro-image-preview` (in `backend/services/gemini.js`)
- **Background removal / inpainting / accessories**: `gemini-2.5-flash-image` (in `backend/services/imageProcessor.js`)
- Do NOT change these model names. They were validated to work. Previous bugs were caused by using non-existent model names.

### Smart Search Concurrency
- `backend/routes/smartSearch.js` has a concurrency limiter: **MAX_CONCURRENT = 2**
- This prevents OOM crashes on Cloud Run when 6 outfit builder searches hit simultaneously
- Each Playwright browser uses ~400MB; 6 concurrent = 2.4GB > old 2GB limit
- Do NOT remove this limiter or increase MAX_CONCURRENT above 2

### Cloud Run Deploy Settings
- Memory: **4Gi** (required for concurrent Playwright browsers)
- CPU: 2
- Timeout: 600s
- Deploy command:
  ```
  cd backend && gcloud run deploy geminitryonme-backend --source . --region us-central1 --project project-4213188d-5b34-47c7-84e --allow-unauthenticated --timeout=600 --memory=4Gi --cpu=2 --min-instances=0 --max-instances=4
  ```
- Do NOT reduce memory below 4Gi — it will cause OOM crashes

### Outfit Builder UI
- The wardrobe UI files (`extension/outfit-builder/wardrobe.html`, `.css`, `.js`) were copied from the reference implementation at `/reference/extension/outfit-builder/`
- Accessories (necklace, earrings, bracelets) are displayed in a ceiling bar, NOT on the shoe rack
- Accessories skip background removal entirely — they render with original images
- Do NOT restructure the accessory bar layout

### 6 Categories — All Required
- URL params: `top`, `bottom`, `shoes`, `necklace`, `earrings`, `bracelets` (plural)
- `popup.js` must read all 6 input fields and pass them as URL params
- `wardrobe.js` must handle all 6 categories in `initWardrobe()`, `searchCategory()`, `selectItem()`, and `handleTryOn()`
- Try-on requires top AND bottom selected (shoes required only if shoes query was specified)
- Do NOT reduce the number of categories below 6

### Voice Agent (Giselle Live) — CRITICAL Configuration
- **Model**: `gemini-2.5-flash-native-audio-latest` (in `backend/services/giselleLive.js`)
- This is a **native audio** model — it generates speech directly, NOT text-to-speech
- Do NOT change this model name. Other models (e.g. `gemini-2.0-flash`, `gemini-2.0-flash-live-001`) do NOT support native audio and will cause 1008 WebSocket errors
- **sessionResumption config**:
  - First connect: pass empty object `{}` — do NOT pass `{ handle: null }` (causes 1008 "Operation not implemented" error)
  - Reconnect: pass `{ handle: resumptionHandle }` with the handle received from `goAway` event
  - Code: `sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {}`
- **Required config fields** (do NOT remove any):
  - `responseModalities: [Modality.AUDIO]`
  - `inputAudioTranscription: {}`
  - `outputAudioTranscription: {}`
  - `speechConfig` with `voiceName: "Aoede"`
- **Known issues that were fixed**:
  - Passing `sessionResumption: { handle: null }` on first connect → 1008 disconnect
  - Using wrong model names (hallucinated names) → 1008 "model not found"
  - `contextWindowCompression` is NOT needed and was removed
- **WebSocket path**: `/ws/voice-live` (in `backend/server.js`)
- **Vision**: Images sent via `sendImage()` using `session.sendClientContent()` with `inlineData` parts
- Do NOT switch to ADK (Agent Development Kit) — the app uses `@google/genai` SDK's `ai.live.connect()` directly

## Tests
- Run: `cd backend && npm test`
- `__tests__/outfitBuilder.test.js` — validates 6-category search, concurrency limiter, outfit try-on with 7 images, URL param parsing, ASIN extraction
- `__tests__/circuitBreaker.test.js` — validates circuit breaker state machine
- `__tests__/validation.test.js` — validates image payload validation
