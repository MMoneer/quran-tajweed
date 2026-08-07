# Tajweed Mushaf - Interactive Quran Reader

A modern, interactive Quran reader with **Tajweed color coding**, audio playback, and full customization. Built as a lightweight Single Page Application (SPA) using vanilla JavaScript with no framework dependencies.

![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-4CAF50?style=flat&logo=githubpages&logoColor=white)](https://MMoneer.github.io/quran-tajweed)

---

## Features

### Quran Reading
- **Full Quran Text** - All 114 Surahs with Uthmani script
- **Tajweed Color Coding** - 17+ Tajweed rules color-coded for easy learning
- **Page-based Navigation** - Navigate by page (1-604) matching the physical Mushaf
- **Juz Navigation** - Jump to any of the 30 Juz (parts)
- **Surah Index** - Searchable grid with Arabic/English names and metadata

### Tajweed Rules
- **17 Tajweed Rules** with color indicators:
  - **Madd (Elongation)**: Normal, Permissible, Obligatory, Necessary
  - **Noon/Meem Sakinah**: Ghunnah, Ikhfa, Ikhfa Shafawi, Idgham with/without Ghunnah, Iqlab
  - **Pronunciation**: Qalqalah, Tafkhim, Laam Shamsiyah, Hamzat Wasl, Silent Letters
- **Interactive Color Customizer** - Change any rule's color in real-time
- **Tajweed Rules Reference** - Dedicated page with explanations and examples

### Audio Player
- **Recitation Playback** - High-quality Minshawy Murattal recitation
- **Play Modes**:
  - Single Ayah mode
  - Continuous Surah mode
  - Custom Range mode (start-end ayah)
- **Controls**: Play/Pause, Next/Previous Ayah, Forward/Rewind 5s
- **Volume Control** with mute toggle
- **Repeat Mode** - Repeat current ayah or range
- **Prefetching** - Next ayah audio prefetched for seamless playback

### Customization
- **Dark/Light Theme** - Toggle between themes
- **Font Size Adjustment** - Responsive sizing (20px-60px) with per-device defaults
- **Tajweed Color Customizer** - Full color picker for all 17 rules
- **Reset to Defaults** - One-click reset to standard colors

### Responsive Design
- **Mobile** (< 768px) - Optimized touch interface
- **Tablet** (768px - 1100px) - Balanced layout
- **Desktop** (> 1100px) - Full-featured interface

---

## Project Structure

```
quran.com/
├── index.html              # Main HTML entry point (SPA)
├── css/
│   └── styles.css          # Complete stylesheet (2000+ lines)
├── js/
│   ├── api.js              # Quran.com API client with IndexedDB-first reads
│   ├── app.js              # SPA router and lifecycle controller
│   ├── audioPlayer.js      # Audio player component
│   ├── dataStore.js        # IndexedDB storage layer
│   ├── dataImporter.js     # Bulk data import from API to IndexedDB
│   ├── firstRunWizard.js   # First-launch import wizard UI
│   ├── pageRenderer.js     # Tajweed text processing & rendering
│   ├── settings.js         # Settings & color customizer manager
│   ├── surahIndex.js       # Surah index/grid component
│   ├── surahView.js        # Surah reader/viewer component
│   └── tajweedRules.js     # Tajweed rules reference page
├── data/
│   └── juz-data.js         # Juz/Surah page mapping (always bundled)
├── fonts/
│   ├── UthmanicHafs_V20.ttf
│   └── UthmanicHafs_V22.ttf
└── docs/                   # Project documentation
```

---

## Architecture

### Module Pattern (IIFE)
Each component is implemented as a **Revealing Module Pattern** (IIFE) exposing a public API:

| Module | Responsibility |
|--------|---------------|
| `App` | SPA router, global event listeners, component lifecycle |
| `QuranAPI` | API client with IndexedDB-first reads, localStorage fallback |
| `DataStore` | IndexedDB wrapper (`quran_tajweed_db`) for persistent browser-side data storage |
| `DataImporter` | Bulk import from Quran.com API to IndexedDB with retry/cancel |
| `FirstRunWizard` | First-launch modal UI for bulk data import |
| `SettingsManager` | Theme, colors, font size, localStorage persistence |
| `SurahIndex` | Chapter list grid, search/filter functionality |
| `SurahViewer` | Surah reader view, navigation controls |
| `PageRenderer` | Tajweed text processing, Uthmanic script rendering, page division |
| `AudioPlayer` | Audio playback (EveryAyah.com), play modes, progress tracking |
| `TajweedRules` | Rules reference page rendering |

### SPA Routing
Hash-based routing with three views:
- `#` or empty → Surah Index
- `#surah/{id}` → Surah Reader (1-114)
- `#tajweed` → Tajweed Rules Reference

### Data Flow
```
First Run: Quran.com API → DataImporter → IndexedDB
                                              ↓
Normal Load: IndexedDB (fast) → PageRenderer (Tajweed merging)
                                              ↓
                                DOM (tajweed <rule> → <tajweed> elements)
                                              ↓
                                CSS Variables (color theming)
```

### Tajweed Text Processing
The app uses a sophisticated algorithm to merge Tajweed annotations:

1. **Input**: Two text formats per word:
   - `text_qpc_hafs` - QPC Hafs script (for KFGQPC font rendering)
   - `text_uthmani_tajweed` - Tajweed-annotated HTML with `<rule class="...">`

2. **Merging**: `mergeTajweedToQPC()` aligns characters between both formats, transferring Tajweed rules to QPC text

3. **Output**: `<tajweed class="rule-name">` elements styled via CSS variables

---

## API Integration

### Quran.com API v4
- **Base URL**: `https://api.quran.com/api/v4`
- **Endpoints Used**:
  - `GET /chapters` - List all 114 surahs
  - `GET /chapters/{id}` - Surah metadata
  - `GET /verses/by_chapter/{id}?words=true` - Verses with word-level data

### Caching Strategy
- **IndexedDB** (primary) — stores surah data and chapters list for offline use, no size limit
- **localStorage** (fallback) — 7-day TTL, prefix `quran_cache_v1_`, used for API responses when IndexedDB is unavailable
- Automatic fallback to expired cache on network errors
- `clearLocalCache()` method for manual cleanup of localStorage

### Audio Source
- **Provider**: EveryAyah.com
- **Reciter**: Minshawy Murattal (128kbps)
- **URL Pattern**: `https://everyayah.com/data/Minshawy_Murattal_128kbps/{surah}{ayah}.mp3`

---

## Offline Use

No manual data download required — the app fetches everything automatically:

1. **First run**: A wizard imports all 114 surahs from the Quran.com API into IndexedDB (shows progress, cancellable)
2. **Subsequent loads**: Surah data reads from IndexedDB instantly — works offline after the first import
3. **Re-download**: Use the **Re-download data** button in Settings to clear and re-import the full Quran (shows progress)

---

## Getting Started

### Quick Start (No Build Required)
1. Clone or download the repository
2. Open `index.html` in a browser
3. On first launch, follow the import wizard to download the Quran data

### Development
No build tools required. Edit files directly:
- `css/styles.css` - Theme variables, responsive breakpoints
- `js/*.js` - Module files (edit any independently)
- `data/juz-data.js` - Juz/Surah page mapping

---

## Tajweed Rules Reference

| Rule | Arabic | Color | Description |
|------|--------|-------|-------------|
| `madda-normal` | مد طبيعي | Pink | Natural elongation (2 counts) |
| `madda-permissible` | مد جائز | Orange | Permissible elongation (2/4/6 counts) |
| `madda-obligatory` | مد واجب متصل | Hot Pink | Obligatory connected elongation (4-5 counts) |
| `madda-necessary` | مد لازم | Red | Necessary elongation (6 counts) |
| `ghunnah` | غنة | Green | Nasalization sound |
| `ikhafa` | إخفاء | Green | Concealment with nasalization |
| `ikhafa-shafawi` | إخفاء شفوي | Green | Labial concealment |
| `idgham-ghunnah` | إدغام بغنة | Green | Assimilation with nasalization |
| `idgham-shafawi` | إدغام شفوي | Green | Labial assimilation |
| `iqlab` | إقلاب | Green | Conversion to Meem |
| `qalaqah` | قلقلة | Cyan | Vibration of sound |
| `tafkhim` | تفخيم | Blue | Emphatic pronunciation |
| `idgham-wo-ghunnah` | إدغام بلا غنة | Gray | Assimilation without nasalization |
| `idgham-mutajanisayn` | إدغام متجانسين | Gray | Assimilation of similar letters |
| `ham-wasl` | همزة وصل | Gray | Connecting Hamzah |
| `laam-shamsiyah` | لام شمسية | Gray | Solar Laam |
| `slnt` | حرف صامت | Gray | Silent letter |

---

## Browser Support

| Browser | Status |
|---------|--------|
| Chrome 90+ | ✅ Fully Supported |
| Firefox 88+ | ✅ Fully Supported |
| Safari 14+ | ✅ Fully Supported |
| Edge 90+ | ✅ Fully Supported |
| Mobile Chrome | ✅ Fully Supported |
| Mobile Safari | ✅ Fully Supported |

**Note**: Uses classic `<script>` tags (no ES modules). Works with `file://` protocol.

---

## Performance

- **No Build Step** - Direct browser execution
- **Lazy Loading** - Surah data loaded on demand from IndexedDB
- **Audio Prefetching** - Next ayah audio prefetched during playback
- **CSS Variables** - Dynamic theming without reflow
- **Responsive Images** - Font loading with `font-display: swap`

---

## Credits

- **Quran Text**: [Quran.com API](https://quran.com) (Uthmani script)
- **Tajweed Data**: QPC Hafs encoding from Quran.com
- **Audio**: [EveryAyah.com](https://everyayah.com) - Minshawy Murattal recitation
- **Fonts**: KFGQPC HAFS Uthmanic Script
- **Icons**: [Font Awesome 6.4](https://fontawesome.com)
- **UI Fonts**: [Amiri Quran](https://fonts.google.com/specimen/Amiri+Quran), [Tajawal](https://fonts.google.com/specimen/Tajawal), [Outfit](https://fonts.google.com/specimen/Outfit)

---

## License

This project uses publicly available Quran data from Quran.com API. Please respect the terms of service of the data providers.
