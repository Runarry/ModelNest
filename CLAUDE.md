# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ModelNest is an Electron-based desktop application for managing and browsing generative AI image models (Stable Diffusion, Flux, etc.). It supports multiple data sources including local file systems and WebDAV servers, with a sophisticated two-level caching system for performance.

## Development Commands

```bash
# Start development mode
npm start

# Build renderer and start
npm run dev

# Watch mode for renderer changes
npm run watch:renderer

# Build distribution package
npm run dist

# Build unpacked version
npm run pack

# Rebuild native modules after dependency changes
npm run rebuild
```

## Architecture Overview

### Process Architecture
- **Main Process** (`main.js`): Manages app lifecycle, windows, services, and IPC
- **Renderer Process** (`src/renderer/`): UI components using vanilla JavaScript with virtual scrolling
- **Preload Script** (`preload.js`): Secure bridge between main and renderer using contextBridge

### Layer Structure
1. **IPC Layer** (`src/ipc/`): Handles all inter-process communication
   - `appIPC.js`: General app operations
   - `modelLibraryIPC.js`: Model-related operations
   - `modelCrawlerIPC.js`: Civitai integration

2. **Service Layer** (`src/services/`): Business logic and state management
   - Services use dependency injection pattern (initialized in `src/services/index.js`)
   - Key services: ConfigService, ModelService, ModelInfoCacheService, ImageService

3. **Data Layer** (`src/data/`): Data source abstractions
   - `BaseDataSource`: Abstract base class defining interface
   - `LocalDataSource`: Local file system implementation
   - `WebDavDataSource`: WebDAV server implementation

### Caching Architecture
- **L1 Cache**: In-memory cache for frequently accessed data
- **L2 Cache**: SQLite-based persistent cache (`better-sqlite3`)
- **Image Cache**: Separate system for caching model preview images
- Cache location: User data directory (`%APPDATA%/model-nest/cache/`)

### Key Design Patterns
1. **Virtual Scrolling**: Implemented in `src/renderer/js/components/main-view.js` for performance with large model lists
2. **Two-Level Caching**: Memory (L1) + SQLite (L2) for optimal performance
3. **Read-Only Data Sources**: Prevents accidental modifications to model libraries
4. **Async Pool**: Limits concurrent operations to prevent resource exhaustion (`src/common/asyncPool.js`)

## Model File Organization

Models should follow this naming convention:
- Model file: `model_name.safetensors` (or `.ckpt`)
- Preview image: `model_name.png`
- Metadata: `model_name.json`

Metadata JSON format:
```json
{
  "modelType": "LORA",
  "description": "Model description",
  "triggerWord": "trigger word",
  "tags": ["tag1", "tag2"],
  "baseModel": "SD 1.5"
}
```

## Important Implementation Notes

1. **IPC Security**: All IPC calls go through contextBridge - never expose Node.js APIs directly to renderer
2. **Error Handling**: IPC errors are wrapped and sent back to renderer with proper error messages
3. **Resource Management**: Image caching uses LRU eviction and memory limits to prevent excessive memory usage
4. **Native Modules**: Uses `sharp` for image processing and `better-sqlite3` for caching - run `npm run rebuild` after dependency updates
5. **Logging**: Use `electron-log` with component prefixes (e.g., `[ModelService]`) for consistent logging
6. **WebDAV Passwords**: Stored securely using `keytar` system keychain integration

## Testing Approach

The project uses manual testing. When making changes:
1. Test with both local and WebDAV data sources
2. Verify caching behavior (check cache stats in settings)
3. Test with large model collections for performance
4. Verify read-only mode prevents modifications
5. Check both light and dark themes
6. Test both zh-CN and en-US locales