/**
 * Pixel Studio — Application Logic
 * Premium, elegant pastel pink pixel manipulation tool
 */

(function () {
  'use strict';

  // Helper selectors
  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);

  // Constants
  const MAX_MATRIX_ROWS = 100;
  const MAX_MATRIX_COLS = 60;

  // Application State
  let W = 0;
  let H = 0;
  let img = null;              // Current working ImageData
  let originalImg = null;      // Backup for revert operations
  let hits = new Set();        // Set of matched pixel 1D indexes (r * W + c)
  let selectedPixel = null;    // { r, c, val }
  let currentUser = null;      // Logged in user object or null for guest
  let currentAuthToken = localStorage.getItem('pixel_studio_token') || null;
  let currentOperationTag = 'Original Image';
  let pendingDelete = null;    // { type: 'upload' | 'download', id, name }

  // Offscreen master canvas
  const sharedCanvas = $('sharedCanvas');
  const sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });

  // List of canvases across views
  const previewCanvases = {
    home: $('stageCanvas'),
    upload: $('mainCanvasUpload'),
    update: $('mainCanvasUpdate'),
    search: $('mainCanvasSearch'),
    grayscale: $('mainCanvasGrayscale'),
    invert: $('mainCanvasInvert'),
    download: $('mainCanvasDownload')
  };

  // Toast Notification System
  let toastTimer = null;
  function toast(message, isError = false) {
    const el = $('toastNotice');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = 'toast';
    }, 2800);
  }

  // Check if image exists
  function hasImage() {
    if (!img || W === 0 || H === 0) {
      toast('Please upload an image or load sample artwork first.', true);
      return false;
    }
    return true;
  }

  // Calculate intensity (grayscale luminance) for index
  function getPixelIntensity(idx) {
    if (!img) return 0;
    return Math.floor((img.data[idx] + img.data[idx + 1] + img.data[idx + 2]) / 3);
  }

  // Get intensity at (r, c)
  function getValAt(r, c) {
    if (!img || r < 0 || r >= H || c < 0 || c >= W) return 0;
    return getPixelIntensity((r * W + c) * 4);
  }

  // Deep clone ImageData
  function cloneImageData(source) {
    const copy = sharedCtx.createImageData(source.width, source.height);
    copy.data.set(source.data);
    return copy;
  }

  // Save current image state to backup for revert
  function snapshotOriginal() {
    if (img) {
      originalImg = cloneImageData(img);
    }
  }

  // ==========================================================
  // VIEW ROUTING
  // ==========================================================
  const validViews = ['home', 'upload', 'update', 'search', 'grayscale', 'invert', 'matrix', 'download', 'library', 'login', 'register', 'forgot-password', 'profile'];
  
  function getRoute() {
    const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase();
    return validViews.includes(hash) ? hash : 'home';
  }

  function setRoute(view) {
    window.location.hash = '#' + view;
  }

  function renderRoute() {
    const currentView = getRoute();

    // Toggle view panels
    $$('.view-panel').forEach(panel => {
      panel.classList.remove('active');
    });
    const activePanel = $('view-' + currentView);
    if (activePanel) {
      activePanel.classList.add('active');
    }

    // Update Header navigation active states
    const navHome = $('navHome');
    if (navHome) navHome.classList.toggle('active', currentView === 'home');
    const navLibrary = $('navLibrary');
    if (navLibrary) navLibrary.classList.toggle('active', currentView === 'library');

    // Update Header breadcrumb
    const crumb = $('headerCrumb');
    if (crumb) {
      const titles = {
        home: 'Home',
        upload: 'Upload',
        update: 'Update Pixel',
        search: 'Search Pixel',
        grayscale: 'Grayscale',
        invert: 'Invert Image',
        matrix: 'Pixel Matrix',
        download: 'Download & Export',
        library: 'Personal Library',
        login: 'Sign In',
        register: 'Create Account',
        'forgot-password': 'Password Recovery',
        profile: 'User Profile'
      };
      crumb.textContent = titles[currentView] || currentView.charAt(0).toUpperCase() + currentView.slice(1);
    }

    // View-specific data hooks
    if (currentView === 'library') {
      refreshLibraryView();
    } else if (currentView === 'profile') {
      if (!currentUser) {
        setRoute('login');
        return;
      }
      refreshProfileView();
    }

    // Close any open user dropdown
    closeUserDropdown();

    // Refresh rendering for the target view
    syncAllViews();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  window.addEventListener('hashchange', renderRoute);

  // ==========================================================
  // CANVAS & PREVIEW SYNCHRONIZATION
  // ==========================================================
  function syncAllViews() {
    updateStatusBadge();
    
    if (!img) {
      // Show empty states
      toggleEmptyStates(true);
      drawArtisticMosaicOnStage();
      updatePixelDataPanel(170, 120);
      return;
    }

    toggleEmptyStates(false);

    // Update shared offscreen canvas
    sharedCanvas.width = W;
    sharedCanvas.height = H;
    sharedCtx.putImageData(img, 0, 0);

    // Draw to all active visible preview canvases
    Object.entries(previewCanvases).forEach(([key, canvas]) => {
      if (!canvas) return;
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(sharedCanvas, 0, 0);

      // If on search view and we have hits, overlay highlights
      if (key === 'search' && hits.size > 0) {
        overlaySearchHits(ctx);
      }

      canvas.style.display = 'block';
    });

    // Update coordinate field hints
    const rowNote = $('updateRowMaxNote');
    const colNote = $('updateColMaxNote');
    if (rowNote) rowNote.textContent = `Valid rows: 0 to ${H - 1}`;
    if (colNote) colNote.textContent = `Valid cols: 0 to ${W - 1}`;

    const stageDims = $('stageMetaDims');
    if (stageDims) stageDims.textContent = `${W} × ${H} px • Active Studio Buffer`;

    // Re-render matrix table if viewing matrix or updating
    renderMatrixTable();

    // Synchronize left Pixel Data Inspector
    if (selectedPixel && selectedPixel.r < H && selectedPixel.c < W) {
      updatePixelDataPanel(selectedPixel.c, selectedPixel.r);
    } else {
      const midX = Math.floor(W / 2);
      const midY = Math.floor(H / 2);
      selectPixel(midY, midX);
      updatePixelDataPanel(midX, midY);
    }
  }

  function toggleEmptyStates(isEmpty) {
    const emptyIds = ['emptyStateUpload', 'emptyStateUpdate', 'emptyStateSearch', 'emptyStateGrayscale', 'emptyStateInvert', 'emptyStateMatrix', 'emptyStateDownload'];
    emptyIds.forEach(id => {
      const el = $(id);
      if (el) el.style.display = isEmpty ? 'flex' : 'none';
    });

    Object.values(previewCanvases).forEach(canvas => {
      if (canvas && canvas !== previewCanvases.home) {
        canvas.style.display = isEmpty ? 'none' : 'block';
      }
    });
  }

  function updateStatusBadge() {
    const badge = $('imageStatusBadge');
    const dot = $('statusDot');
    const text = $('statusText');
    if (!badge || !dot || !text) return;

    if (img && W > 0 && H > 0) {
      dot.classList.add('active');
      text.textContent = `${W} × ${H} px`;
      badge.title = `Current image resolution: ${W} by ${H} pixels`;
    } else {
      dot.classList.remove('active');
      text.textContent = 'No image loaded';
      badge.title = 'Upload or load an image to begin manipulation';
    }
  }

  // Draw delicate artistic mosaic on homepage stage when no image is loaded
  function drawArtisticMosaicOnStage() {
    const canvas = previewCanvases.home;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = 340;
    canvas.height = 240;
    
    // Draw delicate pastel floral pixel mosaic
    const gridSize = 10;
    const cols = canvas.width / gridSize;
    const rows = canvas.height / gridSize;

    const pastelPalette = [
      '#ffffff', '#fff5f8', '#fce7ed', '#fbd1dd', '#f8bbcd',
      '#f59eb7', '#f48fb1', '#fce4ec', '#f8d7da', '#fae1eb'
    ];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Geometric rose blossom formula
        const dx = c - cols / 2;
        const dy = r - rows / 2;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        const wave = Math.sin(dist * 0.35 - angle * 3.5);

        let colorIndex = Math.floor(Math.abs(wave) * pastelPalette.length) % pastelPalette.length;
        if (dist > 11) colorIndex = (colorIndex + Math.floor(dist)) % 3;

        ctx.fillStyle = pastelPalette[colorIndex];
        ctx.fillRect(c * gridSize, r * gridSize, gridSize - 1, gridSize - 1);
      }
    }

    canvas.style.display = 'block';
  }

  // Highlight search hits on canvas overlay
  function overlaySearchHits(ctx) {
    if (!hits.size) return;
    ctx.fillStyle = 'rgba(226, 114, 149, 0.75)';
    hits.forEach(idx => {
      const r = Math.floor(idx / W);
      const c = idx % W;
      ctx.fillRect(c, r, 1, 1);
    });
  }

  // ==========================================================
  // PIXEL DATA INSPECTOR PANEL (Left Column Visualizer)
  // ==========================================================
  function updatePixelDataPanel(targetX, targetY) {
    const zoomCanvas = $('pixelZoomCanvas');
    const coordXEl = $('pvCoordX');
    const coordYEl = $('pvCoordY');
    const swatchEl = $('pvColorSwatch');
    const colorREl = $('pvColorR');
    const colorGEl = $('pvColorG');
    const colorBEl = $('pvColorB');
    const intensityEl = $('pvIntensity');
    const needleEl = $('intensityNeedle');
    const badgeEl = $('pixelZoomSampleBadge');

    if (!zoomCanvas) return;
    const zCtx = zoomCanvas.getContext('2d');
    const zW = zoomCanvas.width;
    const zH = zoomCanvas.height;
    zCtx.imageSmoothingEnabled = false;

    // Check if we have an active image
    if (img && W > 0 && H > 0) {
      const cx = Math.max(0, Math.min(W - 1, Math.floor(targetX)));
      const cy = Math.max(0, Math.min(H - 1, Math.floor(targetY)));
      const targetIdx = (cy * W + cx) * 4;

      const rVal = img.data[targetIdx];
      const gVal = img.data[targetIdx + 1];
      const bVal = img.data[targetIdx + 2];
      const aVal = img.data[targetIdx + 3];
      const intensity = Math.floor((rVal + gVal + bVal) / 3);

      if (coordXEl) coordXEl.textContent = cx;
      if (coordYEl) coordYEl.textContent = cy;
      if (swatchEl) swatchEl.style.backgroundColor = `rgba(${rVal}, ${gVal}, ${bVal}, ${aVal / 255})`;
      if (colorREl) colorREl.textContent = rVal;
      if (colorGEl) colorGEl.textContent = gVal;
      if (colorBEl) colorBEl.textContent = bVal;
      if (intensityEl) intensityEl.textContent = intensity;
      if (needleEl) {
        const pct = Math.max(0, Math.min(100, (intensity / 255) * 100));
        needleEl.style.left = `${pct}%`;
      }
      if (badgeEl) badgeEl.textContent = `Pixel (${cx}, ${cy})`;

      // Render 11x11 zoomed pixel grid around (cx, cy)
      const gridSize = 11;
      const cellW = zW / gridSize;
      const cellH = zH / gridSize;
      const halfGrid = Math.floor(gridSize / 2);

      zCtx.clearRect(0, 0, zW, zH);

      for (let dy = -halfGrid; dy <= halfGrid; dy++) {
        for (let dx = -halfGrid; dx <= halfGrid; dx++) {
          const px = cx + dx;
          const py = cy + dy;
          const drawX = (dx + halfGrid) * cellW;
          const drawY = (dy + halfGrid) * cellH;

          if (px >= 0 && px < W && py >= 0 && py < H) {
            const pIdx = (py * W + px) * 4;
            const pr = img.data[pIdx];
            const pg = img.data[pIdx + 1];
            const pb = img.data[pIdx + 2];
            const pa = img.data[pIdx + 3] / 255;
            zCtx.fillStyle = `rgba(${pr}, ${pg}, ${pb}, ${pa})`;
          } else {
            // Out-of-bounds checkerboard pattern
            const check = ((dx + halfGrid) + (dy + halfGrid)) % 2 === 0;
            zCtx.fillStyle = check ? '#faf0f4' : '#f5e1e8';
          }
          zCtx.fillRect(drawX, drawY, cellW, cellH);

          // Subtle grid line
          zCtx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
          zCtx.lineWidth = 1;
          zCtx.strokeRect(drawX + 0.5, drawY + 0.5, cellW - 1, cellH - 1);
        }
      }

      // Highlight target pixel at center
      const targetDrawX = halfGrid * cellW;
      const targetDrawY = halfGrid * cellH;
      zCtx.strokeStyle = '#ffffff';
      zCtx.lineWidth = 2;
      zCtx.strokeRect(targetDrawX + 1, targetDrawY + 1, cellW - 2, cellH - 2);
      zCtx.strokeStyle = '#b8335a';
      zCtx.lineWidth = 1;
      zCtx.strokeRect(targetDrawX, targetDrawY, cellW, cellH);

    } else {
      // No custom image loaded yet: sample the artistic mosaic canvas
      const sCanvas = previewCanvases.home;
      if (sCanvas) {
        const sCtx = sCanvas.getContext('2d');
        const cx = Math.max(0, Math.min(sCanvas.width - 1, Math.floor(targetX || sCanvas.width / 2)));
        const cy = Math.max(0, Math.min(sCanvas.height - 1, Math.floor(targetY || sCanvas.height / 2)));
        
        let pData;
        try {
          pData = sCtx.getImageData(cx, cy, 1, 1).data;
        } catch(e) {
          pData = [252, 231, 237, 255];
        }

        const rVal = pData[0];
        const gVal = pData[1];
        const bVal = pData[2];
        const intensity = Math.floor((rVal + gVal + bVal) / 3);

        if (coordXEl) coordXEl.textContent = cx;
        if (coordYEl) coordYEl.textContent = cy;
        if (swatchEl) swatchEl.style.backgroundColor = `rgb(${rVal}, ${gVal}, ${bVal})`;
        if (colorREl) colorREl.textContent = rVal;
        if (colorGEl) colorGEl.textContent = gVal;
        if (colorBEl) colorBEl.textContent = bVal;
        if (intensityEl) intensityEl.textContent = intensity;
        if (needleEl) needleEl.style.left = `${(intensity / 255) * 100}%`;
        if (badgeEl) badgeEl.textContent = 'Mosaic Preview';

        // Render sample mosaic grid
        const gridSize = 11;
        const cellW = zW / gridSize;
        const cellH = zH / gridSize;
        const halfGrid = Math.floor(gridSize / 2);
        zCtx.clearRect(0, 0, zW, zH);

        for (let dy = -halfGrid; dy <= halfGrid; dy++) {
          for (let dx = -halfGrid; dx <= halfGrid; dx++) {
            const px = cx + dx * 2;
            const py = cy + dy * 2;
            const drawX = (dx + halfGrid) * cellW;
            const drawY = (dy + halfGrid) * cellH;

            if (px >= 0 && px < sCanvas.width && py >= 0 && py < sCanvas.height) {
              const smp = sCtx.getImageData(px, py, 1, 1).data;
              zCtx.fillStyle = `rgb(${smp[0]}, ${smp[1]}, ${smp[2]})`;
            } else {
              zCtx.fillStyle = '#faf0f4';
            }
            zCtx.fillRect(drawX, drawY, cellW, cellH);
            zCtx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            zCtx.lineWidth = 1;
            zCtx.strokeRect(drawX + 0.5, drawY + 0.5, cellW - 1, cellH - 1);
          }
        }

        // Reticle on center
        const targetDrawX = halfGrid * cellW;
        const targetDrawY = halfGrid * cellH;
        zCtx.strokeStyle = '#b8335a';
        zCtx.lineWidth = 1.5;
        zCtx.strokeRect(targetDrawX + 0.5, targetDrawY + 0.5, cellW - 1, cellH - 1);
      }
    }
  }

  // Interactive Stage Loupe (Centerpiece)
  const stageCanvas = previewCanvases.home;
  if (stageCanvas) {
    stageCanvas.addEventListener('mousemove', e => {
      const rect = stageCanvas.getBoundingClientRect();
      const scaleX = stageCanvas.width / rect.width;
      const scaleY = stageCanvas.height / rect.height;
      const x = Math.floor((e.clientX - rect.left) * scaleX);
      const y = Math.floor((e.clientY - rect.top) * scaleY);

      const coordsEl = $('loupeCoords');
      const valEl = $('loupeValue');

      if (x >= 0 && x < stageCanvas.width && y >= 0 && y < stageCanvas.height) {
        if (coordsEl) coordsEl.textContent = `X: ${x}  Y: ${y}`;
        if (valEl) {
          if (img) {
            valEl.textContent = `Intensity: ${getValAt(y, x)}`;
          } else {
            valEl.textContent = `Studio Mosaic`;
          }
        }
        updatePixelDataPanel(x, y);
      }
    });

    stageCanvas.addEventListener('click', e => {
      const rect = stageCanvas.getBoundingClientRect();
      const scaleX = stageCanvas.width / rect.width;
      const scaleY = stageCanvas.height / rect.height;
      const x = Math.floor((e.clientX - rect.left) * scaleX);
      const y = Math.floor((e.clientY - rect.top) * scaleY);

      if (x >= 0 && x < stageCanvas.width && y >= 0 && y < stageCanvas.height) {
        if (img) {
          selectPixel(y, x);
          updatePixelDataPanel(x, y);
          toast(`Selected Pixel at X:${x}, Y:${y} (Intensity: ${getValAt(y, x)})`);
        }
      }
    });

    stageCanvas.addEventListener('mouseleave', () => {
      const coordsEl = $('loupeCoords');
      const valEl = $('loupeValue');
      if (selectedPixel && img) {
        if (coordsEl) coordsEl.textContent = `X: ${selectedPixel.c}  Y: ${selectedPixel.r}`;
        if (valEl) valEl.textContent = `Intensity: ${selectedPixel.val}`;
        updatePixelDataPanel(selectedPixel.c, selectedPixel.r);
      } else if (img) {
        if (coordsEl) coordsEl.textContent = 'X: — Y: —';
        if (valEl) valEl.textContent = 'Intensity: —';
        updatePixelDataPanel(Math.floor(W / 2), Math.floor(H / 2));
      } else {
        if (coordsEl) coordsEl.textContent = 'X: — Y: —';
        if (valEl) valEl.textContent = 'Studio Mosaic';
        updatePixelDataPanel(170, 120);
      }
    });
  }

  // Click on Static Polaroid Cards: Load Inspiration Photo into Studio
  $$('.polaroid-card').forEach(card => {
    card.addEventListener('click', () => {
      const imgEl = card.querySelector('img');
      const captionEl = card.querySelector('.polaroid-caption');
      if (imgEl && imgEl.src) {
        const caption = captionEl ? captionEl.textContent.trim() : 'Inspiration Artwork';
        openImageInStudio(imgEl.src, caption);
      }
    });
  });

  // ==========================================================
  // SAMPLE ARTWORK GENERATOR
  // ==========================================================
  function generateSamplePastelArtwork() {
    const sw = 64;
    const sh = 64;
    sharedCanvas.width = sw;
    sharedCanvas.height = sh;
    
    // Draw lovely pastel gradient rose & geometric pattern
    const tempCtx = sharedCanvas.getContext('2d');
    const grad = tempCtx.createRadialGradient(sw / 2, sh / 2, 4, sw / 2, sh / 2, sw / 1.5);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.35, '#fbc4d6');
    grad.addColorStop(0.7, '#e57399');
    grad.addColorStop(1, '#9b3d5a');

    tempCtx.fillStyle = grad;
    tempCtx.fillRect(0, 0, sw, sh);

    // Draw delicate heart/floral geometric curves
    tempCtx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    tempCtx.lineWidth = 1.5;
    tempCtx.beginPath();
    tempCtx.arc(sw / 2 - 12, sh / 2 - 8, 10, Math.PI, 0, false);
    tempCtx.arc(sw / 2 + 12, sh / 2 - 8, 10, Math.PI, 0, false);
    tempCtx.lineTo(sw / 2, sh / 2 + 18);
    tempCtx.closePath();
    tempCtx.fillStyle = 'rgba(255, 240, 245, 0.6)';
    tempCtx.fill();
    tempCtx.stroke();

    W = sw;
    H = sh;
    img = tempCtx.getImageData(0, 0, W, H);
    snapshotOriginal();
    hits.clear();

    syncAllViews();
    toast('Loaded sample pastel artwork.');
    if (getRoute() === 'upload') setRoute('home');
  }

  // ==========================================================
  // FEATURE A: UPLOAD IMAGE
  // ==========================================================
  function handleFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/i.test(file.type)) {
      toast('Please upload a valid PNG or JPG image file.', true);
      return;
    }

    const reader = new FileReader();
    reader.onload = function (evt) {
      const tempImg = new Image();
      tempImg.onload = function () {
        W = tempImg.naturalWidth || tempImg.width;
        H = tempImg.naturalHeight || tempImg.height;

        sharedCanvas.width = W;
        sharedCanvas.height = H;
        sharedCtx.fillStyle = '#ffffff';
        sharedCtx.fillRect(0, 0, W, H);
        sharedCtx.drawImage(tempImg, 0, 0);

        img = sharedCtx.getImageData(0, 0, W, H);
        snapshotOriginal();
        hits.clear();
        currentOperationTag = 'Original Upload';

        syncAllViews();
        if (currentUser) {
          saveUploadToLibrary(file.name, evt.target.result, W, H);
          toast(`Loaded "${file.name}" & saved original to your Personal Library.`);
        } else {
          toast(`Loaded image "${file.name}" (${W}×${H} px) [Guest Session]`);
        }
        setRoute('home');
      };
      tempImg.onerror = function () {
        toast('Unable to decode the selected image.', true);
      };
      tempImg.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  }

  // File input change
  const fileInput = $('fileInput');
  if (fileInput) {
    fileInput.addEventListener('change', e => {
      if (e.target.files && e.target.files[0]) {
        handleFile(e.target.files[0]);
      }
    });
  }

  // Drag and Drop
  const dropZone = $('dropZone');
  if (dropZone) {
    ['dragenter', 'dragover'].forEach(name => {
      dropZone.addEventListener(name, e => {
        e.preventDefault();
        dropZone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropZone.addEventListener(name, e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
      });
    });

    dropZone.addEventListener('drop', e => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFile(e.dataTransfer.files[0]);
      }
    });

    dropZone.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (fileInput) fileInput.click();
      }
    });
  }

  // Sample artwork buttons
  const btnSampleHome = $('btnLoadSampleHome');
  if (btnSampleHome) btnSampleHome.addEventListener('click', generateSamplePastelArtwork);

  const btnSampleUpload = $('btnLoadSampleUpload');
  if (btnSampleUpload) btnSampleUpload.addEventListener('click', generateSamplePastelArtwork);

  // Manual Matrix Import (Java LOAD preservation)
  const btnLoadManual = $('btnLoadManual');
  if (btnLoadManual) {
    btnLoadManual.addEventListener('click', () => {
      const textarea = $('manualMatrixInput');
      if (!textarea) return;
      const raw = textarea.value.trim();
      if (!raw) {
        toast('Please enter at least one row of intensity numbers.', true);
        return;
      }

      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) {
        toast('No rows found.', true);
        return;
      }

      const rows = lines.map(line => line.split(/[\s,]+/).map(Number));
      const colsCount = rows[0].length;

      if (rows.some(r => r.length !== colsCount || r.some(Number.isNaN))) {
        toast('Every row must contain the exact same number of valid numbers.', true);
        return;
      }

      W = colsCount;
      H = rows.length;
      sharedCanvas.width = W;
      sharedCanvas.height = H;
      img = sharedCtx.createImageData(W, H);

      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          let val = rows[r][c];
          if (val < 0 || val > 255) val = 0; // Clamped per Java specification
          const idx = (r * W + c) * 4;
          img.data[idx] = val;
          img.data[idx + 1] = val;
          img.data[idx + 2] = val;
          img.data[idx + 3] = 255;
        }
      }

      snapshotOriginal();
      hits.clear();
      syncAllViews();
      toast(`Loaded raw matrix: ${W} cols × ${H} rows.`);
      setRoute('home');
    });
  }

  // ==========================================================
  // FEATURE B: UPDATE PIXEL
  // ==========================================================
  const updateRow = $('updateRow');
  const updateCol = $('updateCol');
  const updateVal = $('updateVal');
  const updateSlider = $('updateSlider');
  const updateSwatch = $('updateSwatch');
  const targetPixelSummary = $('targetPixelSummary');

  function syncUpdateSwatch(val) {
    const clamped = Math.max(0, Math.min(255, val));
    if (updateSwatch) {
      updateSwatch.style.backgroundColor = `rgb(${clamped}, ${clamped}, ${clamped})`;
    }
  }

  if (updateVal && updateSlider) {
    updateVal.addEventListener('input', () => {
      const v = parseInt(updateVal.value, 10);
      if (!Number.isNaN(v)) {
        updateSlider.value = v;
        syncUpdateSwatch(v);
      }
    });

    updateSlider.addEventListener('input', () => {
      updateVal.value = updateSlider.value;
      syncUpdateSwatch(parseInt(updateSlider.value, 10));
    });
  }

  // Canvas Inspector Click to select coordinate
  const viewportUpdate = $('viewportUpdate');
  const canvasUpdate = previewCanvases.update;

  if (canvasUpdate) {
    canvasUpdate.addEventListener('click', e => {
      if (!img) return;
      const rect = canvasUpdate.getBoundingClientRect();
      const scaleX = canvasUpdate.width / rect.width;
      const scaleY = canvasUpdate.height / rect.height;
      const c = Math.floor((e.clientX - rect.left) * scaleX);
      const r = Math.floor((e.clientY - rect.top) * scaleY);

      if (r >= 0 && r < H && c >= 0 && c < W) {
        selectPixel(r, c);
      }
    });
  }

  function selectPixel(r, c) {
    if (!img) return;
    const intensity = getValAt(r, c);
    if (updateRow) updateRow.value = r;
    if (updateCol) updateCol.value = c;
    if (updateVal) updateVal.value = intensity;
    if (updateSlider) updateSlider.value = intensity;
    syncUpdateSwatch(intensity);

    if (targetPixelSummary) {
      targetPixelSummary.textContent = `Row ${r}, Col ${c} (Current: ${intensity})`;
    }
    selectedPixel = { r, c, val: intensity };
  }

  const btnApplyUpdate = $('btnApplyUpdate');
  if (btnApplyUpdate) {
    btnApplyUpdate.addEventListener('click', () => {
      if (!hasImage()) return;

      const r = parseInt(updateRow.value, 10);
      const c = parseInt(updateCol.value, 10);
      const val = parseInt(updateVal.value, 10);

      // Validation
      if (Number.isNaN(r) || Number.isNaN(c) || Number.isNaN(val)) {
        toast('Please enter valid numeric values for row, column, and intensity.', true);
        return;
      }

      if (r < 0 || r >= H) {
        toast(`Row must be between 0 and ${H - 1}.`, true);
        return;
      }

      if (c < 0 || c >= W) {
        toast(`Column must be between 0 and ${W - 1}.`, true);
        return;
      }

      if (val < 0 || val > 255) {
        toast('Intensity must be between 0 and 255.', true);
        return;
      }

      // Apply update
      const idx = (r * W + c) * 4;
      img.data[idx] = val;
      img.data[idx + 1] = val;
      img.data[idx + 2] = val;
      img.data[idx + 3] = 255;
      currentOperationTag = `Pixel (${r}, ${c}) = ${val}`;

      syncAllViews();
      selectPixel(r, c);
      toast(`Updated pixel at (${r}, ${c}) to intensity ${val}.`);
    });
  }

  // ==========================================================
  // FEATURE C: SEARCH PIXEL
  // ==========================================================
  const btnExecuteSearch = $('btnExecuteSearch');
  if (btnExecuteSearch) {
    btnExecuteSearch.addEventListener('click', () => {
      if (!hasImage()) return;

      const searchValInput = $('searchVal');
      const val = parseInt(searchValInput.value, 10);

      if (Number.isNaN(val) || val < 0 || val > 255) {
        toast('Search value must be an intensity between 0 and 255.', true);
        return;
      }

      hits.clear();
      const matches = [];

      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          if (getValAt(r, c) === val) {
            hits.add(r * W + c);
            matches.push([r, c]);
          }
        }
      }

      // Update search chips and counter
      const countBadge = $('searchResultsCount');
      const chipsBox = $('searchChipsBox');
      const visualizerBadge = $('searchVisualizerBadge');

      if (countBadge) countBadge.textContent = `${matches.length} found`;
      if (visualizerBadge) visualizerBadge.textContent = `${matches.length} matches highlighted`;

      if (!matches.length) {
        if (chipsBox) chipsBox.innerHTML = '<span class="results-empty-hint">No pixels matched intensity ' + val + '.</span>';
        syncAllViews();
        toast(`Pixel intensity ${val} not found in the current image.`);
        return;
      }

      // Render coordinates
      const maxRender = 300;
      const displayMatches = matches.slice(0, maxRender);
      let html = '';
      if (matches.length > maxRender) {
        html += `<span class="results-empty-hint" style="width:100%;margin-bottom:6px;">Showing first ${maxRender} of ${matches.length} matches:</span>`;
      }

      displayMatches.forEach(([r, c]) => {
        html += `<span class="coord-chip" data-r="${r}" data-c="${c}">R:${r} C:${c}</span>`;
      });

      if (chipsBox) {
        chipsBox.innerHTML = html;
      }

      syncAllViews();
      toast(`Found ${matches.length} pixel(s) with intensity ${val}.`);
    });
  }

  // Clicking a coordinate chip navigates to Update view and auto-selects that pixel
  const searchChipsBox = $('searchChipsBox');
  if (searchChipsBox) {
    searchChipsBox.addEventListener('click', e => {
      const chip = e.target.closest('.coord-chip');
      if (!chip) return;
      const r = parseInt(chip.dataset.r, 10);
      const c = parseInt(chip.dataset.c, 10);
      selectPixel(r, c);
      setRoute('update');
      toast(`Selected pixel (${r}, ${c}) in Update Studio.`);
    });
  }

  // ==========================================================
  // FEATURE D: GRAYSCALE
  // ==========================================================
  const btnApplyGrayscale = $('btnApplyGrayscale');
  if (btnApplyGrayscale) {
    btnApplyGrayscale.addEventListener('click', () => {
      if (!hasImage()) return;

      for (let i = 0; i < img.data.length; i += 4) {
        const g = getPixelIntensity(i);
        img.data[i] = g;
        img.data[i + 1] = g;
        img.data[i + 2] = g;
      }

      hits.clear();
      currentOperationTag = 'Grayscale Conversion';
      syncAllViews();
      toast('Applied grayscale filter to the image.');
    });
  }

  const btnRevertGrayscale = $('btnRevertGrayscale');
  if (btnRevertGrayscale) {
    btnRevertGrayscale.addEventListener('click', () => {
      if (!originalImg) {
        toast('No original image state to restore.', true);
        return;
      }
      img = cloneImageData(originalImg);
      hits.clear();
      currentOperationTag = 'Reverted to Original';
      syncAllViews();
      toast('Reverted image to original.');
    });
  }

  // ==========================================================
  // FEATURE E: INVERT IMAGE
  // ==========================================================
  const btnApplyInvert = $('btnApplyInvert');
  if (btnApplyInvert) {
    btnApplyInvert.addEventListener('click', () => {
      if (!hasImage()) return;

      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = 255 - img.data[i];
        img.data[i + 1] = 255 - img.data[i + 1];
        img.data[i + 2] = 255 - img.data[i + 2];
      }

      hits.clear();
      currentOperationTag = 'Color Inversion';
      syncAllViews();
      toast('Inverted image tonal colors.');
    });
  }

  const btnRevertInvert = $('btnRevertInvert');
  if (btnRevertInvert) {
    btnRevertInvert.addEventListener('click', () => {
      if (!originalImg) {
        toast('No original image state to restore.', true);
        return;
      }
      img = cloneImageData(originalImg);
      hits.clear();
      currentOperationTag = 'Reverted to Original';
      syncAllViews();
      toast('Reverted image to original.');
    });
  }

  // ==========================================================
  // FEATURE F: VIEW PIXEL MATRIX
  // ==========================================================
  function renderMatrixTable() {
    const container = $('matrixContainer');
    const dimsBadge = $('matrixDimensionsBadge');
    const rangeNote = $('matrixViewRangeNote');

    if (!container) return;

    if (!img) {
      container.innerHTML = '<div class="empty-state"><p>Upload an image to inspect its pixel matrix values.</p></div>';
      if (dimsBadge) dimsBadge.textContent = '0 × 0 px';
      if (rangeNote) rangeNote.textContent = 'No data';
      return;
    }

    const rowWindow = Math.min(H, MAX_MATRIX_ROWS);
    const colWindow = Math.min(W, MAX_MATRIX_COLS);

    if (dimsBadge) dimsBadge.textContent = `${W} × ${H} px`;
    if (rangeNote) {
      rangeNote.textContent = (rowWindow < H || colWindow < W)
        ? `Displaying ${rowWindow} rows × ${colWindow} cols window (Export includes full ${H}×${W})`
        : `Full matrix displayed (${H} rows × ${W} cols)`;
    }

    let html = '<table class="matrix-table"><thead><tr><th></th>';
    for (let c = 0; c < colWindow; c++) {
      html += `<th>${c}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let r = 0; r < rowWindow; r++) {
      html += `<tr><th>${r}</th>`;
      for (let c = 0; c < colWindow; c++) {
        const isHit = hits.has(r * W + c);
        const intensity = getValAt(r, c);
        const isSelected = selectedPixel && selectedPixel.r === r && selectedPixel.c === c;
        const classes = [
          isHit ? 'hit-cell' : '',
          isSelected ? 'active-cell' : ''
        ].filter(Boolean).join(' ');

        html += `<td data-r="${r}" data-c="${c}" class="${classes}">${intensity}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    container.innerHTML = html;
  }

  // Interactive hover & click on matrix cells
  const matrixContainer = $('matrixContainer');
  if (matrixContainer) {
    matrixContainer.addEventListener('mouseover', e => {
      const td = e.target.closest('td');
      const inspectBox = $('matrixCellInspect');
      if (!td || !inspectBox) return;
      const r = td.dataset.r;
      const c = td.dataset.c;
      inspectBox.textContent = `Pixel at Row ${r}, Col ${c} = ${td.textContent}`;
    });

    matrixContainer.addEventListener('click', e => {
      const td = e.target.closest('td');
      if (!td) return;
      const r = parseInt(td.dataset.r, 10);
      const c = parseInt(td.dataset.c, 10);
      selectPixel(r, c);
      setRoute('update');
      toast(`Selected pixel (${r}, ${c}) in Update Studio.`);
    });
  }

  // ==========================================================
  // FEATURE G: DOWNLOAD IMAGE & EXPORT MATRIX
  // ==========================================================
  function getSanitizedBaseName() {
    const input = $('exportFilename');
    const raw = (input && input.value.trim()) || 'pixel-studio-artwork';
    return raw.replace(/[^a-zA-Z0-9_\-\u00C0-\u017F]/g, '-').replace(/-+/g, '-');
  }

  function triggerDownload(blob, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1200);
  }

  const btnDownloadPng = $('btnDownloadPng');
  if (btnDownloadPng) {
    btnDownloadPng.addEventListener('click', () => {
      if (!hasImage()) return;

      sharedCanvas.width = W;
      sharedCanvas.height = H;
      sharedCtx.putImageData(img, 0, 0);

      sharedCanvas.toBlob(blob => {
        if (!blob) {
          toast('Failed to create PNG blob.', true);
          return;
        }
        const name = getSanitizedBaseName() + '.png';
        triggerDownload(blob, name);

        if (currentUser) {
          const dataUrl = sharedCanvas.toDataURL('image/png');
          saveDownloadToLibrary(name, dataUrl, currentOperationTag || 'Modified Artwork', 'png', W, H);
          toast(`Downloaded "${name}" & saved to your Personal Library.`);
        } else {
          toast(`Downloaded image "${name}".`);
        }
      }, 'image/png');
    });
  }

  const btnExportTxt = $('btnExportTxt');
  if (btnExportTxt) {
    btnExportTxt.addEventListener('click', () => {
      if (!hasImage()) return;

      const lines = [];
      for (let r = 0; r < H; r++) {
        const row = new Array(W);
        for (let c = 0; c < W; c++) {
          row[c] = getValAt(r, c);
        }
        lines.push(row.join(' '));
      }

      const txtContent = lines.join('\n');
      const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
      const name = getSanitizedBaseName() + '_matrix.txt';
      triggerDownload(blob, name);

      if (currentUser) {
        saveDownloadToLibrary(name, null, 'Pixel Matrix Export', 'txt', W, H, txtContent);
        toast(`Exported matrix & saved to your Personal Library.`);
      } else {
        toast(`Exported full pixel matrix (${W}×${H}) as TXT.`);
      }
    });
  }

  // ==========================================================
  // AUTHENTICATION & PERSONAL LIBRARY SYSTEM
  // ==========================================================

  // API Client Helper
  const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';

  function toAbsoluteApiUrl(url) {
    if (!url) return '';
    return url.startsWith('http') ? url : (API_BASE + url);
  }

  async function apiFetch(endpoint, options = {}) {
    options.headers = options.headers || {};
    if (currentAuthToken) {
      options.headers['Authorization'] = 'Bearer ' + currentAuthToken;
    }
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    try {
      const targetUrl = toAbsoluteApiUrl(endpoint);
      const res = await fetch(targetUrl, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      return data;
    } catch (err) {
      throw err;
    }
  }

  // Initial Auth Check
  async function checkAuthState() {
    if (!currentAuthToken) {
      currentUser = null;
      updateHeaderAuthWidget();
      return;
    }

    try {
      const data = await apiFetch('/api/auth/me');
      currentUser = data.user;
    } catch (e) {
      console.warn('Session expired or invalid:', e.message);
      currentUser = null;
      currentAuthToken = null;
      localStorage.removeItem('pixel_studio_token');
    }
    updateHeaderAuthWidget();
  }

  // Update Header Auth Widgets
  function updateHeaderAuthWidget() {
    const guestLinks = $('guestLinks');
    const userMenu = $('userMenu');
    const guestBanner = $('guestLibraryBanner');

    if (currentUser) {
      if (guestLinks) guestLinks.style.display = 'none';
      if (userMenu) userMenu.style.display = 'block';
      if (guestBanner) guestBanner.style.display = 'none';

      const initials = (currentUser.display_name || 'User')
        .split(' ')
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();

      if ($('userAvatarText')) $('userAvatarText').textContent = initials;
      if ($('userDisplayName')) $('userDisplayName').textContent = currentUser.display_name;
      if ($('dropdownUserName')) $('dropdownUserName').textContent = currentUser.display_name;
      if ($('dropdownUserEmail')) $('dropdownUserEmail').textContent = currentUser.email;
    } else {
      if (guestLinks) guestLinks.style.display = 'flex';
      if (userMenu) userMenu.style.display = 'none';
      if (guestBanner) guestBanner.style.display = (getRoute() === 'library') ? 'flex' : 'none';
    }
  }

  // Dropdown toggle
  const avatarTrigger = $('avatarTrigger');
  const userDropdown = $('userDropdownPopup');
  function closeUserDropdown() {
    if (userDropdown) userDropdown.classList.remove('show');
  }

  if (avatarTrigger && userDropdown) {
    avatarTrigger.addEventListener('click', e => {
      e.stopPropagation();
      userDropdown.classList.toggle('show');
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('#authHeaderWidget')) {
        closeUserDropdown();
      }
    });
  }

  // Save Upload to Library
  async function saveUploadToLibrary(filename, dataUrl, width, height) {
    if (!currentUser) return;
    try {
      await apiFetch('/api/library/uploads', {
        method: 'POST',
        body: { filename, dataUrl, width, height }
      });
      updateLibraryCounts();
    } catch (err) {
      console.error('Failed to save upload to personal library:', err);
    }
  }

  // Save Download/Export to Library
  async function saveDownloadToLibrary(filename, dataUrl, operation, format, width, height, textContent = '') {
    if (!currentUser) return;
    try {
      await apiFetch('/api/library/downloads', {
        method: 'POST',
        body: { filename, dataUrl, operation, format, width, height, textContent }
      });
      updateLibraryCounts();
    } catch (err) {
      console.error('Failed to save download record:', err);
    }
  }

  // Update badge counts
  async function updateLibraryCounts() {
    if (!currentUser) return;
    try {
      const data = await apiFetch('/api/auth/me');
      currentUser = data.user;
      if ($('uploadsTabBadge')) $('uploadsTabBadge').textContent = currentUser.uploadsCount || 0;
      if ($('downloadsTabBadge')) $('downloadsTabBadge').textContent = currentUser.downloadsCount || 0;
    } catch (e) {}
  }

  // ==========================================================
  // PERSONAL LIBRARY VIEW CONTROLS
  // ==========================================================
  let activeLibraryTab = 'uploads';

  const tabUploads = $('tabUploads');
  const tabDownloads = $('tabDownloads');
  const panelUploads = $('panelUploads');
  const panelDownloads = $('panelDownloads');

  if (tabUploads && tabDownloads) {
    tabUploads.addEventListener('click', () => switchLibraryTab('uploads'));
    tabDownloads.addEventListener('click', () => switchLibraryTab('downloads'));
  }

  function switchLibraryTab(tab) {
    activeLibraryTab = tab;
    if (tabUploads) tabUploads.classList.toggle('active', tab === 'uploads');
    if (tabDownloads) tabDownloads.classList.toggle('active', tab === 'downloads');
    if (panelUploads) panelUploads.style.display = tab === 'uploads' ? 'block' : 'none';
    if (panelDownloads) panelDownloads.style.display = tab === 'downloads' ? 'block' : 'none';
    refreshLibraryView();
  }

  async function refreshLibraryView() {
    updateHeaderAuthWidget();

    if (!currentUser) {
      // Guest mode library presentation
      if ($('uploadedGalleryGrid')) $('uploadedGalleryGrid').innerHTML = '';
      if ($('downloadsGalleryGrid')) $('downloadsGalleryGrid').innerHTML = '';
      if ($('emptyStateUploads')) $('emptyStateUploads').style.display = 'flex';
      if ($('emptyStateDownloads')) $('emptyStateDownloads').style.display = 'flex';
      if ($('uploadsTabBadge')) $('uploadsTabBadge').textContent = '0';
      if ($('downloadsTabBadge')) $('downloadsTabBadge').textContent = '0';
      return;
    }

    try {
      if (activeLibraryTab === 'uploads') {
        const data = await apiFetch('/api/library/uploads');
        renderUploadedImages(data.uploads || []);
        if ($('uploadsTabBadge')) $('uploadsTabBadge').textContent = data.uploads.length;
      } else {
        const data = await apiFetch('/api/library/downloads');
        renderDownloadedItems(data.downloads || []);
        if ($('downloadsTabBadge')) $('downloadsTabBadge').textContent = data.downloads.length;
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  function renderUploadedImages(items) {
    const grid = $('uploadedGalleryGrid');
    const empty = $('emptyStateUploads');
    if (!grid) return;

    if (!items.length) {
      grid.innerHTML = '';
      if (empty) empty.style.display = 'flex';
      return;
    }

    if (empty) empty.style.display = 'none';

    grid.innerHTML = items.map(item => {
      const dateStr = new Date(item.created_at).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric'
      });
      const sizeKb = (item.size_bytes / 1024).toFixed(1);
      const mediaUrl = toAbsoluteApiUrl(item.url);

      return `
        <div class="lib-card" data-id="${item.id}">
          <div class="lib-card-thumb-wrap">
            <img src="${mediaUrl}" class="lib-card-thumb" alt="${item.filename}" loading="lazy">
          </div>
          <div class="lib-card-body">
            <h4 class="lib-card-title" title="${item.filename}">${item.filename}</h4>
            <div class="lib-card-meta">
              <span>${dateStr}</span>
              <span class="lib-card-badge">${item.width} × ${item.height} px</span>
            </div>
            <div class="lib-card-meta">
              <span>Size: ${sizeKb} KB</span>
              <span>Original Saved</span>
            </div>
          </div>
          <div class="lib-card-actions">
            <button type="button" class="btn-card-action btn-action-primary btn-open-studio" data-url="${mediaUrl}" data-name="${item.filename}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              Open in Studio
            </button>
            <button type="button" class="btn-card-action btn-action-danger btn-delete-item" data-type="upload" data-id="${item.id}" data-name="${item.filename}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              Delete
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderDownloadedItems(items) {
    const grid = $('downloadsGalleryGrid');
    const empty = $('emptyStateDownloads');
    if (!grid) return;

    if (!items.length) {
      grid.innerHTML = '';
      if (empty) empty.style.display = 'flex';
      return;
    }

    if (empty) empty.style.display = 'none';

    grid.innerHTML = items.map(item => {
      const dateStr = new Date(item.created_at).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric'
      });
      const sizeKb = (item.size_bytes / 1024).toFixed(1);
      const isTxt = item.format === 'txt';
      const mediaUrl = toAbsoluteApiUrl(item.url);

      const thumbHtml = isTxt
        ? `<div class="lib-txt-icon-badge">
             <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
               <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
               <polyline points="14 2 14 8 20 8"/>
               <line x1="16" y1="13" x2="8" y2="13"/>
               <line x1="16" y1="17" x2="8" y2="17"/>
             </svg>
             <span>TXT Matrix</span>
           </div>`
        : `<img src="${mediaUrl}" class="lib-card-thumb" alt="${item.filename}" loading="lazy">`;

      return `
        <div class="lib-card" data-id="${item.id}">
          <div class="lib-card-thumb-wrap">
            ${thumbHtml}
          </div>
          <div class="lib-card-body">
            <h4 class="lib-card-title" title="${item.filename}">${item.filename}</h4>
            <div class="lib-card-meta">
              <span>${dateStr}</span>
              <span class="lib-card-badge">${item.operation}</span>
            </div>
            <div class="lib-card-meta">
              <span>Format: ${item.format.toUpperCase()}</span>
              <span>Size: ${sizeKb} KB</span>
            </div>
          </div>
          <div class="lib-card-actions">
            <a href="${mediaUrl}&download=1" download="${item.filename}" class="btn-card-action btn-action-primary">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Download Again
            </a>
            <button type="button" class="btn-card-action btn-action-danger btn-delete-item" data-type="download" data-id="${item.id}" data-name="${item.filename}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              Remove
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Delegate Library Gallery Click Events
  document.addEventListener('click', e => {
    // Open in Studio
    const openBtn = e.target.closest('.btn-open-studio');
    if (openBtn) {
      const url = openBtn.dataset.url;
      const name = openBtn.dataset.name;
      openImageInStudio(url, name);
      return;
    }

    // Delete item click
    const delBtn = e.target.closest('.btn-delete-item');
    if (delBtn) {
      const type = delBtn.dataset.type;
      const id = delBtn.dataset.id;
      const name = delBtn.dataset.name;
      promptDelete(type, id, name);
      return;
    }
  });

  // Load uploaded library image into the studio buffer
  function openImageInStudio(url, name) {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      W = im.naturalWidth || im.width;
      H = im.naturalHeight || im.height;
      sharedCanvas.width = W;
      sharedCanvas.height = H;
      sharedCtx.fillStyle = '#ffffff';
      sharedCtx.fillRect(0, 0, W, H);
      sharedCtx.drawImage(im, 0, 0);

      img = sharedCtx.getImageData(0, 0, W, H);
      snapshotOriginal();
      hits.clear();
      currentOperationTag = `Opened from Library: ${name}`;

      syncAllViews();
      setRoute('home');
      toast(`Opened "${name}" in Studio. Original remains safely preserved in library.`);
    };
    im.onerror = () => {
      toast('Failed to load image from library.', true);
    };
    im.src = toAbsoluteApiUrl(url);
  }

  // ==========================================================
  // DELETE CONFIRMATION MODAL
  // ==========================================================
  const deleteModal = $('deleteConfirmModal');
  const deleteModalMessage = $('deleteModalMessage');
  const btnCancelDelete = $('btnCancelDelete');
  const btnCancelDeleteX = $('btnCancelDeleteX');
  const btnConfirmDelete = $('btnConfirmDelete');

  function promptDelete(type, id, name) {
    pendingDelete = { type, id, name };
    if (deleteModalMessage) {
      deleteModalMessage.textContent = type === 'upload'
        ? `Are you sure you want to permanently delete "${name}" from your uploaded images?`
        : `Are you sure you want to remove "${name}" from your download history?`;
    }
    if (deleteModal) deleteModal.style.display = 'flex';
  }

  function closeDeleteModal() {
    pendingDelete = null;
    if (deleteModal) deleteModal.style.display = 'none';
  }

  if (btnCancelDelete) btnCancelDelete.addEventListener('click', closeDeleteModal);
  if (btnCancelDeleteX) btnCancelDeleteX.addEventListener('click', closeDeleteModal);

  if (btnConfirmDelete) {
    btnConfirmDelete.addEventListener('click', async () => {
      if (!pendingDelete) return;
      const { type, id, name } = pendingDelete;
      closeDeleteModal();

      try {
        const endpoint = type === 'upload' ? `/api/library/uploads/${id}` : `/api/library/downloads/${id}`;
        await apiFetch(endpoint, { method: 'DELETE' });
        toast(`Removed "${name}".`);
        refreshLibraryView();
        updateLibraryCounts();
      } catch (err) {
        toast(`Delete failed: ${err.message}`, true);
      }
    });
  }

  // ==========================================================
  // AUTHENTICATION FORMS & PROFILE LOGIC
  // ==========================================================
  // Login Form
  const formLogin = $('formLogin');
  if (formLogin) {
    formLogin.addEventListener('submit', async () => {
      const email = $('loginEmail').value.trim();
      const password = $('loginPassword').value;
      const submitBtn = $('btnSubmitLogin');

      if (!email || !password) return toast('Please enter both email and password.', true);

      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing in...';

      try {
        const data = await apiFetch('/api/auth/login', {
          method: 'POST',
          body: { email, password }
        });

        currentAuthToken = data.token;
        currentUser = data.user;
        localStorage.setItem('pixel_studio_token', currentAuthToken);

        updateHeaderAuthWidget();
        toast(`Welcome back, ${currentUser.display_name}!`);
        setRoute('library');
      } catch (err) {
        toast(err.message, true);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In to Studio';
      }
    });
  }

  // Register Form
  const formRegister = $('formRegister');
  if (formRegister) {
    formRegister.addEventListener('submit', async () => {
      const display_name = $('regDisplayName').value.trim();
      const email = $('regEmail').value.trim();
      const password = $('regPassword').value;
      const passwordConfirm = $('regPasswordConfirm').value;
      const submitBtn = $('btnSubmitRegister');

      if (!email || !password) return toast('Please fill in all required fields.', true);
      if (password !== passwordConfirm) return toast('Passwords do not match.', true);
      if (password.length < 6) return toast('Password must be at least 6 characters.', true);

      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating account...';

      try {
        const data = await apiFetch('/api/auth/register', {
          method: 'POST',
          body: { display_name, email, password }
        });

        currentAuthToken = data.token;
        currentUser = data.user;
        localStorage.setItem('pixel_studio_token', currentAuthToken);

        updateHeaderAuthWidget();
        toast(`Welcome to Pixel Studio, ${currentUser.display_name}!`);
        setRoute('library');
      } catch (err) {
        toast(err.message, true);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Studio Account';
      }
    });
  }

  // Logout Handlers
  async function performLogout() {
    try {
      if (currentAuthToken) {
        await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      }
    } finally {
      currentAuthToken = null;
      currentUser = null;
      localStorage.removeItem('pixel_studio_token');
      updateHeaderAuthWidget();
      closeUserDropdown();
      toast('Signed out. You are now in Guest Mode.');
      setRoute('home');
    }
  }

  const btnLogoutHeader = $('btnLogoutHeader');
  if (btnLogoutHeader) btnLogoutHeader.addEventListener('click', performLogout);
  const btnLogoutProfile = $('btnLogoutProfile');
  if (btnLogoutProfile) btnLogoutProfile.addEventListener('click', performLogout);

  // Forgot Password
  const formForgotRequest = $('formForgotRequest');
  const formResetSubmit = $('formResetSubmit');
  if (formForgotRequest) {
    formForgotRequest.addEventListener('submit', async () => {
      const email = $('forgotEmail').value.trim();
      if (!email) return toast('Please enter your email.', true);

      try {
        const res = await apiFetch('/api/auth/forgot-password', {
          method: 'POST',
          body: { email }
        });
        toast(res.message);
        if (res.resetToken) {
          $('resetTokenInput').value = res.resetToken;
          toast(`Reset Code generated: ${res.resetToken}`);
        }
        if (formResetSubmit) formResetSubmit.style.display = 'block';
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  if (formResetSubmit) {
    formResetSubmit.addEventListener('submit', async () => {
      const token = $('resetTokenInput').value.trim();
      const new_password = $('resetNewPassword').value;
      if (!token || !new_password) return toast('Please enter reset code and new password.', true);

      try {
        const res = await apiFetch('/api/auth/reset-password', {
          method: 'POST',
          body: { token, new_password }
        });
        toast(res.message);
        setRoute('login');
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // Profile View
  async function refreshProfileView() {
    if (!currentUser) return;
    try {
      const data = await apiFetch('/api/auth/me');
      currentUser = data.user;

      if ($('profileNameDisplay')) $('profileNameDisplay').textContent = currentUser.display_name;
      if ($('profileEmailDisplay')) $('profileEmailDisplay').textContent = currentUser.email;
      if ($('editDisplayName')) $('editDisplayName').value = currentUser.display_name;
      if ($('profileStatUploads')) $('profileStatUploads').textContent = currentUser.uploadsCount || 0;
      if ($('profileStatDownloads')) $('profileStatDownloads').textContent = currentUser.downloadsCount || 0;

      const dateStr = new Date(currentUser.created_at).toLocaleDateString(undefined, {
        month: 'long', year: 'numeric'
      });
      if ($('profileJoinedBadge')) $('profileJoinedBadge').textContent = `Member since ${dateStr}`;

      const initials = (currentUser.display_name || 'U').slice(0, 2).toUpperCase();
      if ($('profileAvatarLarge')) $('profileAvatarLarge').textContent = initials;
    } catch (e) {
      toast('Failed to load profile details.', true);
    }
  }

  // Edit Profile Name
  const formUpdateProfileName = $('formUpdateProfileName');
  if (formUpdateProfileName) {
    formUpdateProfileName.addEventListener('submit', async () => {
      const display_name = $('editDisplayName').value.trim();
      if (!display_name) return toast('Please enter a display name.', true);

      try {
        const res = await apiFetch('/api/auth/profile', {
          method: 'PUT',
          body: { display_name }
        });
        currentUser.display_name = res.user.display_name;
        updateHeaderAuthWidget();
        refreshProfileView();
        toast('Display name updated successfully.');
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // Change Password
  const formChangePassword = $('formChangePassword');
  if (formChangePassword) {
    formChangePassword.addEventListener('submit', async () => {
      const current_password = $('currentPassword').value;
      const new_password = $('newPassword').value;
      if (!current_password || !new_password) return toast('Please enter current and new passwords.', true);

      try {
        await apiFetch('/api/auth/profile', {
          method: 'PUT',
          body: { current_password, new_password }
        });
        $('currentPassword').value = '';
        $('newPassword').value = '';
        toast('Password updated successfully.');
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // Start Auth Check and Route
  checkAuthState().then(() => {
    renderRoute();
  });

})();
