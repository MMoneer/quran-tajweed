/**
 * Settings and Color Customizer Manager
 */
const SettingsManager = (() => {
  // Default values
  const DEFAULT_COLORS = {
    'ham-wasl': '#aaaaaa',
    'laam-shamsiyah': '#aaaaaa',
    'slnt': '#aaaaaa',
    'madda-normal': '#ffa0a0',
    'madda-permissible': '#ff9100',
    'madda-obligatory': '#ff2d6c',
    'madda-obligatory-monfasel': '#ff9100',
    'madda-necessary': '#d50000',
    'ghunnah': '#169777',
    'ikhafa': '#169777',
    'ikhafa-shafawi': '#169777',
    'idgham-ghunnah': '#169777',
    'idgham-wo-ghunnah': '#aaaaaa',
    'idgham-shafawi': '#169777',
    'iqlab': '#169777',
    'qalaqah': '#00c8ff',
    'tafkhim': '#3a86ff',
    'idgham-mutajanisayn': '#aaaaaa'
  };

  const DEFAULT_SETTINGS = {
    theme: 'dark', // 'dark' or 'light'
    tajweedActive: true,
    reciter: 'Minshawy_Murattal_128kbps',
    fontSize: 30, // px (default for desktop/tablet)
    // Font sizes per media type
    fontSizes: {
      mobile: 24,  // < 768px
      tablet: 30,  // 768px - 1100px
      desktop: 30  // > 1100px
    }
  };

  // Media breakpoints
  const MEDIA_QUERIES = {
    mobile: window.matchMedia('(max-width: 767px)'),
    tablet: window.matchMedia('(min-width: 768px) and (max-width: 1100px)'),
    desktop: window.matchMedia('(min-width: 1101px)')
  };

  let currentMedia = 'desktop';

  // Rule metadata for display
  const RULES_META = [
    // ── حركتان فقط (2 harakat) ──────────────────────────────────
    { id: 'madda-normal', ar: 'المد الطبيعي (الأصلي)', en: 'Natural Madd', cat: 'madd', dur: '2',
      def: 'الذي لا تقوم ذات الحرف إلا به، ولا يتوقف على سبب (همز أو سكون). حروفه: ا، و، ي.',
      example: { before: 'قَ', target: 'ا', after: 'لَ' } },
    { id: 'madda-normal', ar: 'مد البدل', en: 'Badal Madd', cat: 'madd', dur: '2',
      def: 'تقدم الهمز على حرف المد في كلمة واحدة (يُمد حركتان فقط عند الشاطبية).',
      example: { before: '', target: 'آ', after: 'مَنُوا' } },
    { id: 'madda-normal', ar: 'مد العوض', en: 'Ews Madd', cat: 'madd', dur: '2',
      def: 'التعويض عن تنوين النصب وقْفاً بألف مدية.',
      example: { before: 'عَلِي', target: 'مًا', after: '' } },
    { id: 'madda-normal', ar: 'مد الصلة الصغرى', en: 'Minor Sila', cat: 'madd', dur: '2',
      def: 'صلة هاء الضمير للمفرد المذكر الغائب بواو أو ياء مدية إذا وقعت بين متحركين ولم يكن المتحرك الثاني همزة قطع.',
      example: { before: 'إِنَّ', target: 'هُ', after: ' كَانَ' } },
    { id: 'madda-normal', ar: 'مد التمكين', en: 'Tamkin Madd', cat: 'madd', dur: '2',
      def: 'اجتماع واوين أو ياءين أولاهما مشددة مكسورة والثانية ساكنة، أو العكس.',
      example: { before: 'النَّبِيِّ', target: 'ينَ', after: '' } },
    { id: 'madda-normal', ar: 'مد حروف فواتح السور', en: 'Fawatih Madd', cat: 'madd', dur: '2',
      def: 'الحروف المقطعة في أوائل السور والتي هجاؤها على حرفين (ح، ي، ط، هـ، ر).',
      example: { before: '', target: 'طه', after: '' } },

    // ── جائز (4 أو 5 حركات) ─────────────────────────────────────
    { id: 'madda-obligatory-monfasel', ar: 'المد الجائز المنفصل', en: 'Permissible Separated', cat: 'madd', dur: '4-5',
      def: 'يأتي حرف المد في آخر الكلمة الأولى، وهمزة القطع في أول الكلمة الثانية. يُمد 4 حركات (توسط) أو 5 حركات (فويق التوسط).',
      example: { before: 'بِمَ', target: 'ا', after: ' أُنزِلَ' } },
    { id: 'madda-obligatory-monfasel', ar: 'مد الصلة الكبرى', en: 'Major Sila', cat: 'madd', dur: '4-5',
      def: 'وقوع هاء الضمير للمفرد المذكر الغائب بين متحركين، والمتحرك الثاني هو همزة قطع (يُعامل معاملة المد المنفصل).',
      example: { before: 'مَالَ', target: 'هُ', after: ' أَخْلَدَهُ' } },

    // ── واجب (4 أو 5 حركات) ─────────────────────────────────────
    { id: 'madda-obligatory', ar: 'المد الواجب المتصل', en: 'Obligatory Connected', cat: 'madd', dur: '4-5-o',
      def: 'اجتماع حرف المد والهمز في كلمة واحدة. يجب مدّه 4 أو 5 حركات (وصلاً ووقفاً إذا لم تكن الهمزة متطرفة).',
      example: { before: 'السَّمَ', target: 'اءِ', after: '' } },

    // ── جائز (2 أو 4 أو 6 حركات) ────────────────────────────────
    { id: 'madda-permissible', ar: 'المد العارض للسكون', en: 'Temporary Sukun', cat: 'madd', dur: '2-4-6',
      def: 'وقوع حرف سكن سكوناً عارضاً لأجل الوقف بعد حرف المد. يُمد: 2 حركات (قصر)، 4 حركات (توسط)، 6 حركات (إشباع).',
      example: { before: 'الْعَالَمِ', target: 'ي', after: 'نَ' } },
    { id: 'madda-permissible', ar: 'مد اللين', en: 'Layyin Madd', cat: 'madd', dur: '2-4-6',
      def: 'حرف اللين (الواو أو الياء الساكنتان المفتوح ما قبلهما) وبعده حرف سكن سكوناً عارضاً لأجل الوقف.',
      example: { before: 'خَ', target: 'و', after: 'ْفٍ' } },

    // ── لازم (6 حركات) ───────────────────────────────────────────
    { id: 'madda-necessary', ar: 'المد اللازم الكلمي المثقل', en: 'Necessary Heavy Word', cat: 'madd', dur: '6',
      def: 'التي يأتي بعد حرف المد حرف مشدد في كلمة. يُمد 6 حركات وجوباً.',
      example: { before: 'الضَّ', target: 'آلِّ', after: 'ينَ' } },
    { id: 'madda-necessary', ar: 'المد اللازم الكلمي المخفف', en: 'Necessary Light Word', cat: 'madd', dur: '6',
      def: 'التي يأتي بعد حرف المد حرف ساكن سكوناً أصلياً غير مشدد في كلمة (في القرآن لحفص في موضعين بيونس فقط).',
      example: { before: '', target: 'آلْ', after: 'آنَ' } },
    { id: 'madda-necessary', ar: 'المد اللازم الحرفي المثقل', en: 'Necessary Heavy Letter', cat: 'madd', dur: '6',
      def: 'وجود حرف المد في حرف من الحروف المقطعة (نقص عسلكم) وبعده حرف مدغم فيما يليه (مشدد).',
      example: { before: 'ط', target: 'سم', after: '' } },
    { id: 'madda-necessary', ar: 'المد اللازم الحرفي المخفف', en: 'Necessary Light Letter', cat: 'madd', dur: '6',
      def: 'وجود حرف المد في حرف من (نقص عسلكم) وبعده حرف ساكن غير مدغم فيما يليه.',
      example: { before: '', target: 'الم', after: '' } },
    { id: 'madda-necessary', ar: 'مد الفرق', en: 'Fariq Madd', cat: 'madd', dur: '6',
      def: 'دخول همزة الاستفهام على همزة الوصل (المعرفة بـ أل). فيه وجهان: الإبدال (يُمد 6 حركات) والتسهيل.',
      example: { before: '', target: 'آل', after: 'ذَّكَرَيْنِ' } },

    // ── أحكام النون والميم ────────────────────────────────────────
    { id: 'ghunnah', ar: 'غنة', en: 'Ghunnah', cat: 'noon',
      def: 'صوت يخرج من الخيشوم مقدار حركتين عند النون والميم المشددتين.',
      example: { before: 'إِ', target: 'نّ', after: '' } },
    { id: 'ikhafa', ar: 'إخفاء', en: 'Ikhfa', cat: 'noon',
      def: 'إخفاء النون الساكنة والتنوين مع غنة عند خمسة عشر حرفاً.',
      example: { before: 'مِ', target: 'ن ق', after: 'َبلُ' } },
    { id: 'ikhafa-shafawi', ar: 'إخفاء شفوي', en: 'Ikhfa Shafawi', cat: 'noon',
      def: 'إخفاء الميم الساكنة عند الباء مع غنة.',
      example: { before: 'تَرمِيهِ', target: 'م ب', after: 'ِحِجَارَةٍ' } },
    { id: 'idgham-ghunnah', ar: 'إدغام بغنة', en: 'Idgham with Ghunnah', cat: 'noon',
      def: 'إدغام النون الساكنة والتنوين في حروف (ينمو) مع غنة.',
      example: { before: 'مَ', target: 'ن ي', after: 'َعمَل' } },
    { id: 'idgham-shafawi', ar: 'إدغام شفوي', en: 'Idgham Shafawi', cat: 'noon',
      def: 'إدغام الميم الساكنة في الميم مع غنة.',
      example: { before: 'لَهُ', target: 'م مّ', after: 'َا' } },
    { id: 'iqlab', ar: 'إقلاب', en: 'Iqlab', cat: 'noon',
      def: 'قلب النون الساكنة والتنوين ميماً عند الباء مع غنة.',
      example: { before: 'مِ', target: 'ن ب', after: 'َعدِ' } },

    { id: 'qalaqah', ar: 'قلقلة', en: 'Qalqalah', cat: 'pronounce',
      def: 'اضطراب الصوت عند نطق حروف (قطب جد) الساكنة.',
      example: { before: 'أَحَ', target: 'د', after: '' } },
    { id: 'tafkhim', ar: 'تفخيم', en: 'Tafkhim', cat: 'pronounce',
      def: 'تسمين الحرف بحيث يمتلئ الفم بصداه (حروف الاستعلاء والراء المفخّمة).',
      example: { before: '', target: 'رَ', after: 'بِّ' } },
    { id: 'idgham-wo-ghunnah', ar: 'إدغام بلا غنة', en: 'Idgham without Ghunnah', cat: 'pronounce',
      def: 'إدغام النون الساكنة والتنوين في اللام والراء بلا غنة.',
      example: { before: 'مِ', target: 'ن رّ', after: 'َبِّهِم' } },
    { id: 'idgham-mutajanisayn', ar: 'إدغام متجانسين', en: 'Idgham Mutajanisayn', cat: 'pronounce',
      def: 'إدغام حرفين اتحدا مخرجاً واختلفا صفة.',
      example: { before: 'قَ', target: 'د تّ', after: 'َبَيَّنَ' } },
    { id: 'ham-wasl', ar: 'همزة وصل', en: 'Hamzat Wasl', cat: 'pronounce',
      def: 'همزة تثبت ابتداءً وتسقط وصلاً.',
      example: { before: '', target: 'ٱ', after: 'لحَمدُ' } },
    { id: 'laam-shamsiyah', ar: 'لام شمسية', en: 'Laam Shamsiyah', cat: 'pronounce',
      def: 'لام (ال) لا تُنطق وتُدغم في الحرف الشمسي بعدها.',
      example: { before: 'ا', target: 'لشّ', after: 'َمس' } },
    { id: 'slnt', ar: 'حرف صامت', en: 'Silent Letter', cat: 'pronounce',
      def: 'حرف يُرسم ولا يُنطق.',
      example: { before: 'أَنَ', target: 'ا۠', after: '' } }
  ];

  // State
  let state = {
    colors: { ...DEFAULT_COLORS },
    settings: { ...DEFAULT_SETTINGS }
  };

  /**
   * Detect current media type
   */
  function detectMedia() {
    if (MEDIA_QUERIES.mobile.matches) return 'mobile';
    if (MEDIA_QUERIES.tablet.matches) return 'tablet';
    return 'desktop';
  }

  /**
   * Populate the reciter dropdown from the AudioPlayer config
   */
  function populateReciterSelect() {
    const select = document.getElementById('reciter-select');
    if (!select || typeof AudioPlayer === 'undefined' || !AudioPlayer.getReciters) return;
    select.innerHTML = '';
    AudioPlayer.getReciters().forEach(reciter => {
      const option = document.createElement('option');
      option.value = reciter.id;
      option.textContent = reciter.ar;
      select.appendChild(option);
    });
  }

  /**
   * Get font size for current media
   */
  function getFontSizeForMedia(media) {
    return state.settings.fontSizes?.[media] || DEFAULT_SETTINGS.fontSizes[media];
  }

  /**
   * Initialize settings
   */
  function init() {
    loadFromLocalStorage();
    currentMedia = detectMedia();
    
    // Set fontSize based on current media
    state.settings.fontSize = getFontSizeForMedia(currentMedia);

    populateReciterSelect();
    applySettingsToDOM();
    setupEventListeners();
    setupMediaListeners();
    generateLegend();
  }

  /**
   * Load settings and colors from localStorage
   */
  function loadFromLocalStorage() {
    const savedColors = localStorage.getItem('tajweed_custom_colors');
    const savedSettings = localStorage.getItem('tajweed_app_settings');

    if (savedColors) {
      try {
        state.colors = { ...DEFAULT_COLORS, ...JSON.parse(savedColors) };
      } catch (e) {
        console.error('Error parsing custom colors:', e);
      }
    }

    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings);
        // Deep merge fontSizes object
        if (parsed.fontSizes) {
          parsed.fontSizes = { ...DEFAULT_SETTINGS.fontSizes, ...parsed.fontSizes };
        }
        state.settings = { ...DEFAULT_SETTINGS, ...parsed };
      } catch (e) {
        console.error('Error parsing app settings:', e);
      }
    }
  }

  /**
   * Save settings to localStorage
   */
  function saveColorsToLocalStorage() {
    localStorage.setItem('tajweed_custom_colors', JSON.stringify(state.colors));
  }

  function saveSettingsToLocalStorage() {
    localStorage.setItem('tajweed_app_settings', JSON.stringify(state.settings));
  }

  /**
   * Apply settings directly to the DOM (CSS Variables, theme class, active states)
   */
  function applySettingsToDOM() {
    // Apply colors to root CSS variables
    Object.keys(state.colors).forEach(rule => {
      document.documentElement.style.setProperty(`--color-${rule}`, state.colors[rule]);
      
      // Update color picker input if it exists
      const input = document.getElementById(`color-${rule}`);
      if (input) {
        input.value = state.colors[rule];
      }

      // Update color dots in Settings Panel
      const dot = input?.previousElementSibling?.previousElementSibling;
      if (dot && dot.classList.contains('rule-dot')) {
        dot.style.backgroundColor = state.colors[rule];
      }
    });

    // Apply active tajweed mode class
    if (state.settings.tajweedActive) {
      document.body.classList.add('tajweed-active');
    } else {
      document.body.classList.remove('tajweed-active');
    }
    const toggleTajweed = document.getElementById('toggle-tajweed-active');
    if (toggleTajweed) {
      toggleTajweed.checked = state.settings.tajweedActive;
    }

    // Apply selected reciter to the dropdown
    const reciterSelect = document.getElementById('reciter-select');
    if (reciterSelect && state.settings.reciter) {
      reciterSelect.value = state.settings.reciter;
      // Normalize a stale/invalid stored reciter id to the default so the
      // dropdown and AudioPlayer always agree on the active reciter.
      if (reciterSelect.value !== state.settings.reciter) {
        const fallback = typeof AudioPlayer !== 'undefined' && AudioPlayer.getSelectedReciter
          ? AudioPlayer.getSelectedReciter().id
          : DEFAULT_SETTINGS.reciter;
        state.settings.reciter = fallback;
        reciterSelect.value = fallback;
        saveSettingsToLocalStorage();
      }
    }

    // Apply font size variable
    document.documentElement.style.setProperty('--reader-font-size', `${state.settings.fontSize}px`);
    const sizeSlider = document.getElementById('font-size-slider');
    const sizeText = document.getElementById('font-size-text');
    const readerSizeVal = document.getElementById('font-size-value');
    
    if (sizeSlider) sizeSlider.value = state.settings.fontSize;
    if (sizeText) sizeText.textContent = `${state.settings.fontSize}px`;
    const defaultForMedia = DEFAULT_SETTINGS.fontSizes[currentMedia];
    if (readerSizeVal) readerSizeVal.textContent = `${Math.round((state.settings.fontSize / defaultForMedia) * 100)}%`;

    // Apply theme
    if (state.settings.theme === 'light') {
      document.body.classList.add('light-theme');
      document.getElementById('btn-theme').innerHTML = '<i class="fa-solid fa-sun"></i>';
    } else {
      document.body.classList.remove('light-theme');
      document.getElementById('btn-theme').innerHTML = '<i class="fa-solid fa-moon"></i>';
    }
  }

  /**
   * Set up UI controls event listeners
   */
  function setupEventListeners() {
    // Settings Drawer toggles
    const btnSettings = document.getElementById('btn-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const drawer = document.getElementById('settings-drawer');
    const overlay = document.getElementById('drawer-overlay');

    const toggleDrawer = () => {
      drawer.classList.toggle('open');
      overlay.classList.toggle('visible');
    };

    btnSettings?.addEventListener('click', toggleDrawer);
    btnCloseSettings?.addEventListener('click', toggleDrawer);
    overlay?.addEventListener('click', toggleDrawer);

    // Color Pickers (deduplicate by rule ID)
    const boundPickerIds = new Set();
    RULES_META.forEach(rule => {
      if (boundPickerIds.has(rule.id)) return;
      boundPickerIds.add(rule.id);

      const input = document.getElementById(`color-${rule.id}`);
      input?.addEventListener('input', (e) => {
        const val = e.target.value;
        state.colors[rule.id] = val;
        
        // Dynamic DOM Updates
        document.documentElement.style.setProperty(`--color-${rule.id}`, val);
        
        // Update local dot color
        const dot = input.closest('.rule-color-item')?.querySelector('.rule-dot');
        if (dot) {
          dot.style.backgroundColor = val;
        }

        // Update corresponding dot in legend
        const legendDot = document.querySelector(`.legend-color-dot[data-rule="${rule.id}"]`);
        if (legendDot) {
          legendDot.style.backgroundColor = val;
        }

        saveColorsToLocalStorage();
      });
    });

    // Font size slider
    const sizeSlider = document.getElementById('font-size-slider');
    sizeSlider?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      state.settings.fontSize = val;
      document.documentElement.style.setProperty('--reader-font-size', `${val}px`);
      
      const sizeText = document.getElementById('font-size-text');
      const readerSizeVal = document.getElementById('font-size-value');
      if (sizeText) sizeText.textContent = `${val}px`;
      const defaultForMedia = DEFAULT_SETTINGS.fontSizes[currentMedia];
      if (readerSizeVal) readerSizeVal.textContent = `${Math.round((val / defaultForMedia) * 100)}%`;
      
      // Save font size for current media
      state.settings.fontSizes[currentMedia] = val;
      saveSettingsToLocalStorage();
    });

    // Tajweed toggle
    const toggleTajweed = document.getElementById('toggle-tajweed-active');
    toggleTajweed?.addEventListener('change', (e) => {
      state.settings.tajweedActive = e.target.checked;
      if (state.settings.tajweedActive) {
        document.body.classList.add('tajweed-active');
      } else {
        document.body.classList.remove('tajweed-active');
      }
      saveSettingsToLocalStorage();
    });

    // Theme toggle
    const btnTheme = document.getElementById('btn-theme');
    btnTheme?.addEventListener('click', () => {
      state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
      applySettingsToDOM();
      saveSettingsToLocalStorage();
    });

    // Reciter dropdown
    const reciterSelect = document.getElementById('reciter-select');
    reciterSelect?.addEventListener('change', (e) => {
      state.settings.reciter = e.target.value;
      saveSettingsToLocalStorage();
      if (typeof AudioPlayer !== 'undefined' && typeof AudioPlayer.reloadCurrent === 'function') {
        AudioPlayer.reloadCurrent();
      }
    });

    // Reset colors
    const btnReset = document.getElementById('btn-reset-colors');
    btnReset?.addEventListener('click', () => {
      state.colors = { ...DEFAULT_COLORS };
      saveColorsToLocalStorage();
      applySettingsToDOM();
      generateLegend();
    });

    // Reader Font Buttons (+ / -)
    const btnInc = document.getElementById('btn-increase-font');
    const btnDec = document.getElementById('btn-decrease-font');

    btnInc?.addEventListener('click', () => {
      if (state.settings.fontSize < 60) {
        state.settings.fontSize += 1;
        state.settings.fontSizes[currentMedia] = state.settings.fontSize;
        applySettingsToDOM();
        saveSettingsToLocalStorage();
      }
    });

    btnDec?.addEventListener('click', () => {
      if (state.settings.fontSize > 20) {
        state.settings.fontSize -= 1;
        state.settings.fontSizes[currentMedia] = state.settings.fontSize;
        applySettingsToDOM();
        saveSettingsToLocalStorage();
      }
    });

    // Legend header toggle (collapse/expand)
    const legendHeader = document.querySelector('.legend-header');
    const legend = document.getElementById('tajweed-legend');
    legendHeader?.addEventListener('click', () => {
      legend.classList.toggle('collapsed');
      updateReaderPadding();
    });

    // Re-fetch data button
    const btnRefetch = document.getElementById('btn-refetch-data');
    btnRefetch?.addEventListener('click', () => {
      if (!confirm('هل تريد إعادة تحميل جميع بيانات القرآن؟ قد يستغرق هذا بضع دقائق.')) return;

      const progressArea = document.getElementById('refetch-progress-area');
      const progressFill = document.getElementById('refetch-progress-fill');
      const progressText = document.getElementById('refetch-progress-text');
      progressArea.style.display = 'block';

      DataImporter.startImport(
        (progress) => {
          const pct = Math.round((progress.current / progress.total) * 100);
          progressFill.style.width = `${pct}%`;
          progressText.textContent = `جاري التحميل... ${progress.current}/${progress.total}`;
        },
        (result) => {
          progressText.textContent = `اكتمل التحميل! ${result.success} سورة.`;
          progressFill.style.width = '100%';
          setTimeout(() => { progressArea.style.display = 'none'; }, 3000);
        },
        (error) => {
          progressText.textContent = `حدث خطأ: ${error.message}`;
        }
      );
    });
  }

  /**
   * Set up media change listeners to reset font size on media change
   */
  function setupMediaListeners() {
    const handleMediaChange = (e) => {
      const newMedia = detectMedia();
      if (newMedia !== currentMedia) {
        currentMedia = newMedia;
        // Reset font size to default for new media
        state.settings.fontSize = getFontSizeForMedia(currentMedia);
        applySettingsToDOM();
        saveSettingsToLocalStorage();
      }
    };

    MEDIA_QUERIES.mobile.addEventListener('change', handleMediaChange);
    MEDIA_QUERIES.tablet.addEventListener('change', handleMediaChange);
    MEDIA_QUERIES.desktop.addEventListener('change', handleMediaChange);
  }

  /**
   * Update reader card bottom padding based on legend visibility/state
   */
  function updateReaderPadding() {
    const readerCard = document.querySelector('.surah-viewer-card');
    if (!readerCard) return;
    
    if (readerCard.style.paddingBottom) {
      const legend = document.getElementById('tajweed-legend');
      if (legend && legend.classList.contains('visible')) {
        const height = legend.offsetHeight;
        readerCard.style.paddingBottom = `${height + 10}px`;
      } else {
        readerCard.style.paddingBottom = '';
      }
    }
  }

  /**
   * Generate the footer Tajweed Legend dynamically based on current colors
   */
  function generateLegend() {
    const container = document.getElementById('legend-items-container');
    if (!container) return;

    container.innerHTML = '';
    
    RULES_META.forEach(rule => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.setAttribute('title', `${rule.en} - اضغط لتعديل اللون`);
      
      const dot = document.createElement('span');
      dot.className = 'legend-color-dot';
      dot.setAttribute('data-rule', rule.id);
      dot.style.backgroundColor = state.colors[rule.id];
      
      const text = document.createElement('span');
      text.className = 'legend-text';
      text.textContent = rule.ar;

      item.appendChild(dot);
      item.appendChild(text);

      // Clicking a legend item opens settings panel and highlights that picker
      item.addEventListener('click', () => {
        const drawer = document.getElementById('settings-drawer');
        const overlay = document.getElementById('drawer-overlay');
        
        // Open drawer if closed
        if (!drawer.classList.contains('open')) {
          drawer.classList.add('open');
          overlay.classList.add('visible');
        }

        // Scroll to the input item and highlight it temporarily
        const inputItem = document.getElementById(`color-${rule.id}`)?.parentElement;
        if (inputItem) {
          inputItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
          inputItem.style.boxShadow = '0 0 10px rgba(212, 175, 55, 0.4)';
          inputItem.style.borderColor = 'var(--accent)';
          
          setTimeout(() => {
            inputItem.style.boxShadow = '';
            inputItem.style.borderColor = '';
          }, 1500);
        }
      });

      container.appendChild(item);
    });
  }

  return {
    init,
    state,
    RULES_META,
    applySettingsToDOM,
    generateLegend
  };
})();
