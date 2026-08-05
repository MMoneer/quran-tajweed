const AudioPlayer = (() => {
  let audioEl = null;
  let currentSurahId = null;
  let currentAyahId = 1;        // per-surah local (1-N)
  let currentGlobalAyahId = 1;  // global verse ID
  let totalAyahs = 0;
  let isPlaying = false;
  let isRepeatOn = false;
  let playMode = 'surah'; // 'ayah', 'surah', or 'range'
  let rangeStart = null;
  let rangeEnd = null;
  let isMuted = false;
  let previousVolume = 0.8;
  let surahVerses = [];

  let playerEl = null;
  let playBtn = null;
  let surahNameEl = null;
  let ayahInfoEl = null;
  let progressFill = null;
  let progressContainer = null;
  let timeCurrent = null;
  let timeDuration = null;
  let prevBtn = null;
  let nextBtn = null;
  let rewindBtn = null;
  let forwardBtn = null;
  let volumeSlider = null;
  let volumeBtn = null;
  let repeatBtn = null;
  let playModeBtn = null;
  let rangeStartInput = null;
  let rangeEndInput = null;

  function pad3(n) {
    return String(n).padStart(3, '0');
  }

  function buildAudioUrl(surahId, ayahId) {
    return `https://everyayah.com/data/Minshawy_Murattal_128kbps/${pad3(surahId)}${pad3(ayahId)}.mp3`;
  }

  function getEffectiveEnd() {
    if (playMode === 'range' && rangeEnd !== null && rangeEnd <= totalAyahs) {
      return rangeEnd;
    }
    return totalAyahs;
  }

  function getEffectiveStart() {
    if (playMode === 'range' && rangeStart !== null && rangeStart >= 1) {
      return rangeStart;
    }
    return 1;
  }

  function globalToLocal(globalId) {
    if (surahVerses.length > 0) {
      const idx = surahVerses.findIndex(v => v.id === globalId);
      if (idx !== -1) return idx + 1;
    }
    return globalId;
  }

  function localToGlobal(localId) {
    if (surahVerses.length > 0 && localId >= 1 && localId <= surahVerses.length) {
      return surahVerses[localId - 1].id;
    }
    return localId;
  }

  /**
   * Play ayah by LOCAL per-surah number (1-N).
   * Used internally by onAyahEnded, nextAyah, previousAyah.
   */
  function playAyahLocal(localId) {
    if (!currentSurahId || localId < 1 || localId > totalAyahs) return;

    currentAyahId = localId;
    currentGlobalAyahId = localToGlobal(localId);

    const url = buildAudioUrl(currentSurahId, localId);
    audioEl.src = url;

    ayahInfoEl.textContent = `الآية ${localId}/${totalAyahs}`;
    window.dispatchEvent(new CustomEvent('ayahchange', { detail: { ayahId: currentGlobalAyahId } }));

    prefetchNext(currentAyahId + 1);
    isPlaying = true;
    playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    playBtn.classList.add('active');

    const startPlay = () => {
      audioEl.play().catch(err => console.warn('AudioPlayer: play failed', err, url));
    };
    audioEl.removeEventListener('canplay', startPlay);
    audioEl.addEventListener('canplay', startPlay, { once: true });
    audioEl.load();
  }

  /**
   * Set current ayah position without playing (from verse click).
   */
  function setAyahPosition(globalId) {
    if (!currentSurahId) return;
    const localId = globalToLocal(globalId);
    currentAyahId = localId;
    currentGlobalAyahId = globalId;
    ayahInfoEl.textContent = `الآية ${localId}/${totalAyahs}`;
  }

  function init() {
    playerEl = document.getElementById('audio-player');
    playBtn = document.getElementById('btn-play');
    surahNameEl = document.getElementById('player-surah-name');
    ayahInfoEl = document.getElementById('player-ayah-info');
    progressFill = document.getElementById('progress-bar-fill');
    progressContainer = document.getElementById('progress-bar-container');
    timeCurrent = document.getElementById('player-time-current');
    timeDuration = document.getElementById('player-time-duration');
    prevBtn = document.getElementById('btn-prev-ayah');
    nextBtn = document.getElementById('btn-next-ayah');
    rewindBtn = document.getElementById('btn-rewind');
    forwardBtn = document.getElementById('btn-forward');
    volumeSlider = document.getElementById('volume-slider');
    volumeBtn = document.getElementById('btn-volume');
    repeatBtn = document.getElementById('btn-repeat');
    playModeBtn = document.getElementById('btn-play-mode');
    rangeStartInput = document.getElementById('range-start');
    rangeEndInput = document.getElementById('range-end');
    audioEl = document.getElementById('audio-element');

    const savedVolume = localStorage.getItem('audioPlayer_volume');
    if (savedVolume !== null) {
      const vol = parseFloat(savedVolume);
      volumeSlider.value = vol;
      audioEl.volume = vol;
      previousVolume = vol;
    } else {
      audioEl.volume = 0.8;
    }

    playBtn.addEventListener('click', togglePlay);
    prevBtn.addEventListener('click', previousAyah);
    nextBtn.addEventListener('click', nextAyah);
    rewindBtn.addEventListener('click', () => { if (audioEl) audioEl.currentTime = Math.max(0, audioEl.currentTime - 5); });
    forwardBtn.addEventListener('click', () => { if (audioEl) audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 5); });
    volumeSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      audioEl.volume = val;
      localStorage.setItem('audioPlayer_volume', val);
      isMuted = false;
      updateVolumeIcon(val);
    });
    volumeBtn.addEventListener('click', toggleMute);
    repeatBtn.addEventListener('click', toggleRepeat);
    playModeBtn.addEventListener('click', togglePlayMode);

    rangeStartInput.addEventListener('input', onRangeChange);
    rangeStartInput.addEventListener('change', onRangeChange);
    rangeEndInput.addEventListener('input', onRangeChange);
    rangeEndInput.addEventListener('change', onRangeChange);

    audioEl.addEventListener('timeupdate', onTimeUpdate);
    audioEl.addEventListener('ended', onAyahEnded);
    audioEl.addEventListener('loadedmetadata', onLoadedMetadata);

    progressContainer.addEventListener('click', (e) => {
      if (audioEl.duration) {
        const rect = progressContainer.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        audioEl.currentTime = ratio * audioEl.duration;
      }
    });

    audioEl.addEventListener('error', () => {
      console.warn('AudioPlayer: error loading', audioEl.src);
      isPlaying = false;
      playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
      playBtn.classList.remove('active');
      // Try to skip to next ayah on failure (only in surah/range mode)
      if (playMode !== 'ayah' && currentAyahId < totalAyahs) {
        setTimeout(() => {
          playAyahLocal(currentAyahId + 1);
        }, 500);
      }
    });

    updatePlayModeUI();
    updateRepeatUI();
  }

  function loadSurah(surahId, nameArabic, total, startAyah, verses) {
    currentSurahId = surahId;
    currentAyahId = startAyah || 1;
    totalAyahs = total;
    surahVerses = verses || [];
    currentGlobalAyahId = localToGlobal(currentAyahId);
    isPlaying = false;

    rangeStart = null;
    rangeEnd = null;
    if (rangeStartInput) rangeStartInput.value = '';
    if (rangeEndInput) rangeEndInput.value = '';

    surahNameEl.textContent = nameArabic;
    ayahInfoEl.textContent = `الآية ${currentAyahId}/${totalAyahs}`;
    playerEl.classList.remove('hidden');
    playerEl.classList.add('visible');
    document.body.classList.add('audio-active');
    document.querySelector('.app-main')?.classList.add('audio-active');

    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    playBtn.classList.remove('active');

    if (audioEl) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
    }
    progressFill.style.width = '0%';
    timeCurrent.textContent = '٠٠:٠٠';
    timeDuration.textContent = '٠٠:٠٠';
  }

  /**
   * Toggle play/pause. If no audio loaded, starts from current position.
   */
  function togglePlay() {
    if (!audioEl.src) {
      if (playMode === 'range' && rangeStart !== null) {
        playAyahLocal(rangeStart);
      } else {
        playAyahLocal(currentAyahId);
      }
      return;
    }
    if (audioEl.paused) {
      audioEl.play().catch(err => console.warn('AudioPlayer: resume failed', err));
      isPlaying = true;
      playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
      playBtn.classList.add('active');
    } else {
      audioEl.pause();
      isPlaying = false;
      playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
      playBtn.classList.remove('active');
    }
  }

  /**
   * Public API: Play ayah by GLOBAL verse ID (from verse popup click).
   * Converts to local, then plays.
   */
  function playAyah(globalId) {
    if (!currentSurahId) return;
    const localId = globalToLocal(globalId);
    playAyahLocal(localId);
  }

  function prefetchNext(nextLocalId) {
    if (nextLocalId > totalAyahs) return;
    const url = buildAudioUrl(currentSurahId, nextLocalId);
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = url;
    link.id = 'prefetch-link';
    const old = document.getElementById('prefetch-link');
    if (old) old.remove();
    document.head.appendChild(link);
  }

  function nextAyah() {
    if (currentAyahId < totalAyahs) {
      playAyahLocal(currentAyahId + 1);
    }
  }

  function previousAyah() {
    if (currentAyahId > 1) {
      playAyahLocal(currentAyahId - 1);
    }
  }

  function onTimeUpdate() {
    if (audioEl.duration) {
      const pct = (audioEl.currentTime / audioEl.duration) * 100;
      progressFill.style.width = pct + '%';
      timeCurrent.textContent = formatTime(audioEl.currentTime);
    }
  }

  function onLoadedMetadata() {
    timeDuration.textContent = formatTime(audioEl.duration);
  }

  /**
   * Handle ayah ended — advance/repeat/stop based on current mode.
   * All calls use local IDs (via playAyahLocal).
   */
  function onAyahEnded() {
    if (playMode === 'ayah') {
      if (isRepeatOn) {
        playAyahLocal(currentAyahId);
      } else {
        stopPlayback();
      }
    } else if (playMode === 'surah') {
      if (currentAyahId < totalAyahs) {
        playAyahLocal(currentAyahId + 1);
      } else if (isRepeatOn) {
        playAyahLocal(1);
      } else {
        stopPlayback();
      }
    } else if (playMode === 'range') {
      const end = getEffectiveEnd();
      const start = getEffectiveStart();
      if (currentAyahId < end) {
        playAyahLocal(currentAyahId + 1);
      } else if (isRepeatOn) {
        playAyahLocal(start);
      } else {
        stopPlayback();
      }
    }
  }

  function stopPlayback() {
    isPlaying = false;
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    playBtn.classList.remove('active');
    if (audioEl) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
    }
  }

  function toggleRepeat() {
    isRepeatOn = !isRepeatOn;
    updateRepeatUI();
  }

  function updateRepeatUI() {
    if (isRepeatOn) {
      repeatBtn.classList.add('active');
      repeatBtn.title = 'إيقاف التكرار';
    } else {
      repeatBtn.classList.remove('active');
      repeatBtn.title = 'تشغيل متكرر';
    }
  }

  function togglePlayMode() {
    if (playMode === 'ayah') {
      playMode = 'surah';
    } else if (playMode === 'surah') {
      playMode = 'range';
    } else {
      playMode = 'ayah';
    }
    updatePlayModeUI();
  }

  function updatePlayModeUI() {
    if (!playModeBtn) return;
    playModeBtn.classList.remove('surah-mode', 'range-mode');
    if (playMode === 'ayah') {
      playModeBtn.innerHTML = '<i class="fa-solid fa-1"></i>';
      playModeBtn.title = 'الآية الحالية فقط';
    } else if (playMode === 'surah') {
      playModeBtn.innerHTML = '<i class="fa-solid fa-layer-group"></i>';
      playModeBtn.title = 'استمرار للسورة';
      playModeBtn.classList.add('surah-mode');
    } else {
      playModeBtn.innerHTML = '<i class="fa-solid fa-arrows-left-right"></i>';
      playModeBtn.title = 'نطاق محدد';
      playModeBtn.classList.add('range-mode');
    }
  }

  function onRangeChange() {
    const startVal = rangeStartInput.value.trim();
    const endVal = rangeEndInput.value.trim();

    if (startVal === '') {
      rangeStart = null;
    } else {
      const s = parseInt(startVal);
      if (!isNaN(s)) {
        rangeStart = Math.max(1, Math.min(s, totalAyahs));
      }
    }

    if (endVal === '') {
      rangeEnd = null;
    } else {
      const e = parseInt(endVal);
      if (!isNaN(e)) {
        rangeEnd = Math.max(1, Math.min(e, totalAyahs));
      }
    }
  }

  function toggleMute() {
    if (isMuted) {
      audioEl.volume = previousVolume;
      volumeSlider.value = previousVolume;
      isMuted = false;
    } else {
      previousVolume = audioEl.volume || 0.8;
      audioEl.volume = 0;
      volumeSlider.value = 0;
      isMuted = true;
    }
    updateVolumeIcon(audioEl.volume);
  }

  function updateVolumeIcon(vol) {
    const icon = volumeBtn.querySelector('i');
    if (vol === 0 || isMuted) {
      icon.className = 'fa-solid fa-volume-xmark';
    } else if (vol < 0.5) {
      icon.className = 'fa-solid fa-volume-low';
    } else {
      icon.className = 'fa-solid fa-volume-high';
    }
  }

  function formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return '٠٠:٠٠';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function stop() {
    if (audioEl) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
    }
    isPlaying = false;
    currentSurahId = null;
    currentAyahId = 1;
    currentGlobalAyahId = 1;
    totalAyahs = 0;
    surahVerses = [];
    playerEl.classList.remove('visible');
    playerEl.classList.add('hidden');
    document.body.classList.remove('audio-active');
    document.querySelector('.app-main')?.classList.remove('audio-active');
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    playBtn.classList.remove('active');
    progressFill.style.width = '0%';
    timeCurrent.textContent = '٠٠:٠٠';
    timeDuration.textContent = '٠٠:٠٠';
    document.querySelectorAll('.verse.ayah-active').forEach(el => el.classList.remove('ayah-active'));
  }

  return { init, loadSurah, togglePlay, playAyah, setAyahPosition, nextAyah, previousAyah, stop };
})();
