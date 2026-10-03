import { FaceMemory } from './face-memory.mjs';
import { CenterFaceDetector } from './centerface.mjs?v=photo-worker-1';
import { coverageAt, scaleBox, scanChecks, videoOutputSize, videoScanPlan } from './video-coverage.mjs';
import { detectWithFallback } from './video-detection.mjs';
import { defaultFastMode } from './video-mode.mjs';
import { photoOutputSize } from './photo-processing.mjs';

const $ = (id) => document.getElementById(id);
const ui = {
  file: $('file-input'), drop: $('drop-zone'), canvasWrap: $('canvas-wrap'), canvas: $('canvas'),
  overlay: $('draw-overlay'), video: $('source-video'), resultVideo: $('result-video'), timeline: $('timeline'), seek: $('seek'),
  time: $('time-display'), status: $('status'), progress: $('progress-track'),
  progressBar: $('progress-bar'), progressText: $('progress-text'), name: $('file-name'),
  kind: $('file-kind'), fastMode: $('fast-mode'), maskColor: $('mask-color'), maskColorValue: $('mask-color-value'),
  padding: $('padding'), paddingValue: $('padding-value'),
  maskList: $('mask-list'), maskCount: $('mask-count'), download: $('download'),
  processVideo: $('process-video'), editVideo: $('edit-video')
};

const ctx = ui.canvas.getContext('2d', { willReadFrequently: false });
const sourceCanvas = document.createElement('canvas');
const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: false });
const compactDevice = defaultFastMode({
  viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
  screenWidth: window.screen?.width ?? window.innerWidth,
  screenHeight: window.screen?.height ?? window.innerHeight,
  touchPoints: navigator.maxTouchPoints ?? 0,
  coarsePointer: window.matchMedia?.('(any-pointer: coarse)')?.matches ?? false
});
ui.fastMode.checked = compactDevice;
let fastModeChoice = ui.fastMode.checked;
let detectorPromise;
const faceMemory = new FaceMemory();
const centerFace = new CenterFaceDetector();
let file;
let fileUrl;
let image;
let photoDetections = null;
let selectionId = 0;
let mediaKind;
let masks = [];
let videoAnalysis = [];
let analysisComplete = false;
let processedVideoBlob;
let processedVideoUrl;
let processedMime;
let dragging;
let exporting = false;
let renderBusy = false;
let renderIdleResolvers = [];
let recorder;
let outputStream;
let audioContext;
let audioSource;
let audioDestination;
let audioIncluded = false;
let coveredErrorFrames = 0;

function setStatus(message) { ui.status.textContent = message; }
function updateVideoModeLabel() {
  if (mediaKind === 'video') ui.kind.textContent = ui.fastMode.checked ? 'VIDÉO · MODE RAPIDE' : 'VIDÉO · MODE MINUTIEUX';
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function updateTime() {
  ui.time.textContent = `${formatTime(ui.video.currentTime)} / ${formatTime(ui.video.duration)}`;
  if (Number.isFinite(ui.video.duration) && ui.video.duration > 0)
    ui.seek.value = Math.round(ui.video.currentTime / ui.video.duration * 1000);
}
function updateOverlaySize() {
  const rect = ui.canvas.getBoundingClientRect();
  const parent = ui.canvasWrap.getBoundingClientRect();
  ui.overlay.style.left = `${rect.left - parent.left}px`;
  ui.overlay.style.top = `${rect.top - parent.top}px`;
  ui.overlay.style.width = `${rect.width}px`;
  ui.overlay.style.height = `${rect.height}px`;
}
new ResizeObserver(updateOverlaySize).observe(ui.canvas);

async function loadDetector() {
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    await centerFace.load();
    setStatus('Prêt. Choisissez une photo ou une vidéo.');
  })().catch((error) => {
    detectorPromise = null;
    console.error(error);
    setStatus('NOFACE n’a pas pu lancer la recherche des visages. Rechargez la page et réessayez.');
    throw error;
  });
  return detectorPromise;
}

function resetMedia() {
  faceMemory.reset();
  ui.video.pause();
  ui.video.removeAttribute('src');
  ui.video.load();
  ui.resultVideo.pause();
  ui.resultVideo.removeAttribute('src');
  ui.resultVideo.load();
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  if (processedVideoUrl) URL.revokeObjectURL(processedVideoUrl);
  fileUrl = null;
  processedVideoUrl = null;
  processedVideoBlob = null;
  processedMime = null;
  videoAnalysis = [];
  analysisComplete = false;
  if (image?.close) image.close();
  image = null;
  photoDetections = null;
  masks = [];
  renderMaskList();
  ui.download.disabled = true;
  ui.download.hidden = false;
  ui.processVideo.hidden = true;
  ui.editVideo.hidden = true;
  ui.canvas.hidden = false;
  ui.overlay.hidden = false;
  ui.resultVideo.hidden = true;
  ui.timeline.hidden = true;
  ui.progress.hidden = true;
  ui.progressText.textContent = '';
  ui.progressBar.style.width = '0%';
}

async function chooseFile(nextFile) {
  if (!nextFile || exporting) return;
  const kind = nextFile.type.startsWith('image/') ? 'image' : nextFile.type.startsWith('video/') ? 'video' : null;
  if (!kind) { setStatus('Choisissez une photo ou une vidéo.'); return; }
  const currentSelection = ++selectionId;
  ui.fastMode.checked = fastModeChoice;
  resetMedia();
  file = nextFile;
  mediaKind = kind;
  ui.name.textContent = nextFile.name;
  ui.kind.textContent = kind === 'image' ? 'PHOTO' : 'VIDÉO';
  updateVideoModeLabel();
  ui.drop.hidden = true;
  ui.canvasWrap.hidden = false;
  setStatus('Ouverture du fichier…');
  try {
    if (kind === 'image') {
      const decoded = await createImageBitmap(nextFile, { imageOrientation: 'from-image' });
      if (currentSelection !== selectionId) { decoded.close?.(); return; }
      image = decoded;
      const size = photoOutputSize(image.width, image.height, compactDevice);
      ui.canvas.width = size.width;
      ui.canvas.height = size.height;
      paintCover({ x: 0, y: 0, width: size.width, height: size.height });
      setStatus('Recherche des visages sur la photo…');
      await new Promise((resolve) => requestAnimationFrame(resolve));
    } else {
      fileUrl = URL.createObjectURL(nextFile);
      ui.video.src = fileUrl;
      await new Promise((resolve, reject) => {
        ui.video.onloadedmetadata = resolve;
        ui.video.onerror = () => reject(new Error('Ce navigateur ne peut pas ouvrir cette vidéo. Essayez un fichier MP4 ou WebM.'));
      });
      setVideoCanvasSize();
      updateTime();
      await seekSource(0.001);
    }
    updateOverlaySize();
    if (!centerFace.session) await loadDetector();
    if (currentSelection !== selectionId) return;
    if (kind === 'video') {
      await processVideo();
    } else {
      setStatus('Recherche des visages sur la photo…');
      const detected = await centerFace.detect(image, 1280);
      if (currentSelection !== selectionId) return;
      photoDetections = detected;
      const rendered = await renderCurrent();
      ui.download.disabled = !rendered;
      if (rendered) {
        const resized = ui.canvas.width !== image.width || ui.canvas.height !== image.height;
        setStatus(`Vérifiez la photo. Ajoutez un rectangle si un visage est encore visible.${resized ? ` Photo réduite à ${ui.canvas.width} × ${ui.canvas.height} pixels.` : ''}`);
      }
    }
  } catch (error) {
    if (currentSelection !== selectionId) return;
    if (kind === 'image') {
      paintCover({ x: 0, y: 0, width: ui.canvas.width, height: ui.canvas.height });
      setStatus('La photo n’a pas pu être traitée. Elle reste entièrement couverte. Rechargez la page et réessayez.');
    } else setStatus(error.message || 'Impossible d’ouvrir ce fichier.');
  }
}

function setCanvasSize(width, height) {
  if (!width || !height) throw new Error('Ce fichier ne contient aucune image lisible.');
  ui.canvas.width = sourceCanvas.width = width;
  ui.canvas.height = sourceCanvas.height = height;
}
function setVideoCanvasSize() {
  const size = videoOutputSize(ui.video.videoWidth, ui.video.videoHeight, ui.fastMode.checked);
  setCanvasSize(size.width, size.height);
  sourceCanvas.width = ui.video.videoWidth;
  sourceCanvas.height = ui.video.videoHeight;
}
async function seekSource(time) {
  await new Promise((resolve, reject) => {
    const video = ui.video;
    const target = Math.max(0, Math.min(time, Math.max(0, video.duration - 0.001)));
    if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) { resolve(); return; }
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Impossible de se déplacer dans la vidéo.')); };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = target;
  });
}
function paddedBox(box) {
  const p = Number(ui.padding.value) / 100;
  const growX = box.width * p / 2;
  const growY = box.height * p / 2;
  const x = Math.max(0, box.originX - growX);
  const y = Math.max(0, box.originY - growY);
  return {
    x, y,
    width: Math.min(ui.canvas.width - x, box.width + growX * 2),
    height: Math.min(ui.canvas.height - y, box.height + growY * 2)
  };
}
function opaqueMaskColor() {
  return /^#[0-9a-f]{6}$/i.test(ui.maskColor.value) ? ui.maskColor.value : '#161616';
}
function paintCover(box) {
  const { x, y, width, height } = box;
  if (width < 1 || height < 1) return;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = opaqueMaskColor();
  ctx.fillRect(x, y, width, height);
  ctx.restore();
}
function paintManualMasks() {
  for (const mask of masks) paintCover({
    x: mask.x * ui.canvas.width, y: mask.y * ui.canvas.height,
    width: mask.width * ui.canvas.width, height: mask.height * ui.canvas.height
  });
}
function paintCachedVideoFrame(time) {
  ctx.drawImage(ui.video, 0, 0, ui.canvas.width, ui.canvas.height);
  for (const box of coverageAt(videoAnalysis, time)) {
    const scaled = scaleBox(box, ui.video.videoWidth, ui.video.videoHeight, ui.canvas.width, ui.canvas.height);
    paintCover(paddedBox(scaled));
  }
  paintManualMasks();
}
async function renderCurrent() {
  if (!file || !centerFace.session || renderBusy) return;
  renderBusy = true;
  try {
    if (mediaKind === 'video') {
      if (!videoAnalysis.length) return false;
      paintCachedVideoFrame(ui.video.currentTime);
      updateTime();
      return true;
    }
    if (photoDetections === null) {
      paintCover({ x: 0, y: 0, width: ui.canvas.width, height: ui.canvas.height });
      return false;
    }
    ctx.drawImage(image, 0, 0, ui.canvas.width, ui.canvas.height);
    for (const box of photoDetections) {
      const scaled = scaleBox(box, image.width, image.height, ui.canvas.width, ui.canvas.height);
      paintCover(paddedBox(scaled));
    }
    paintManualMasks();
    return true;
  } catch (error) {
    paintCover({ x: 0, y: 0, width: ui.canvas.width, height: ui.canvas.height });
    console.error(error);
    setStatus('Impossible de chercher les visages. La photo a été entièrement couverte par précaution. Réessayez.');
    return false;
  } finally {
    renderBusy = false;
    for (const resolve of renderIdleResolvers.splice(0)) resolve();
  }
}

function clearProcessedVideo() {
  ui.resultVideo.pause();
  ui.resultVideo.removeAttribute('src');
  ui.resultVideo.load();
  if (processedVideoUrl) URL.revokeObjectURL(processedVideoUrl);
  processedVideoUrl = null;
  processedVideoBlob = null;
  processedMime = null;
  ui.download.disabled = true;
  ui.editVideo.hidden = true;
  ui.processVideo.hidden = false;
}

async function enterVideoEditor(clearAnalysis = false) {
  if (mediaKind !== 'video' || exporting) return;
  const time = ui.resultVideo.hidden ? ui.video.currentTime : ui.resultVideo.currentTime;
  clearProcessedVideo();
  if (clearAnalysis) { videoAnalysis = []; analysisComplete = false; }
  ui.resultVideo.hidden = true;
  ui.canvas.hidden = false;
  ui.overlay.hidden = false;
  ui.timeline.hidden = !videoAnalysis.length;
  await seekSource(time);
  if (videoAnalysis.length) await renderCurrent();
  else paintCover({ x: 0, y: 0, width: ui.canvas.width, height: ui.canvas.height });
  updateOverlaySize();
  setStatus('Changements enregistrés. Touchez « Refaire la vidéo » pour créer le nouveau résultat.');
}

function renderMaskList() {
  ui.maskCount.textContent = `${masks.length} zone${masks.length > 1 ? 's' : ''}`;
  ui.maskList.replaceChildren();
  masks.forEach((_, index) => {
    const button = document.createElement('button');
    button.className = 'mask-chip';
    button.type = 'button';
    button.textContent = `Zone ${index + 1} ×`;
    button.setAttribute('aria-label', `Supprimer la zone ${index + 1}`);
    button.onclick = async () => {
      masks.splice(index, 1);
      renderMaskList();
      if (mediaKind === 'video') await enterVideoEditor();
      else renderCurrent();
    };
    ui.maskList.append(button);
  });
}
function pointOnOverlay(event) {
  const rect = ui.overlay.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
}
ui.overlay.addEventListener('pointerdown', (event) => {
  if (!file || exporting || ui.overlay.hidden) return;
  ui.overlay.setPointerCapture(event.pointerId);
  dragging = { start: pointOnOverlay(event), end: pointOnOverlay(event) };
});
ui.overlay.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  dragging.end = pointOnOverlay(event);
  renderCurrent().then(() => {
    if (!dragging) return;
    const a = dragging.start, b = dragging.end;
    ctx.save(); ctx.strokeStyle = '#c52922'; ctx.lineWidth = Math.max(2, ui.canvas.width / 450);
    ctx.strokeRect(Math.min(a.x,b.x)*ui.canvas.width, Math.min(a.y,b.y)*ui.canvas.height, Math.abs(a.x-b.x)*ui.canvas.width, Math.abs(a.y-b.y)*ui.canvas.height); ctx.restore();
  });
});
ui.overlay.addEventListener('pointerup', async (event) => {
  if (!dragging) return;
  dragging.end = pointOnOverlay(event);
  const a = dragging.start, b = dragging.end;
  dragging = null;
  const mask = { x: Math.min(a.x,b.x), y: Math.min(a.y,b.y), width: Math.abs(a.x-b.x), height: Math.abs(a.y-b.y) };
  if (mask.width > .005 && mask.height > .005) masks.push(mask);
  if (mediaKind === 'video') clearProcessedVideo();
  renderMaskList(); await renderCurrent();
});

ui.file.addEventListener('change', () => chooseFile(ui.file.files[0]));
ui.drop.addEventListener('dragover', (event) => { event.preventDefault(); ui.drop.classList.add('dragging'); });
ui.drop.addEventListener('dragleave', () => ui.drop.classList.remove('dragging'));
ui.drop.addEventListener('drop', (event) => { event.preventDefault(); ui.drop.classList.remove('dragging'); chooseFile(event.dataTransfer.files[0]); });
ui.maskColor.addEventListener('input', async () => {
  ui.maskColorValue.textContent = opaqueMaskColor().toUpperCase();
  if (mediaKind === 'video') { await enterVideoEditor(); return; }
  if (renderBusy) await new Promise((resolve) => renderIdleResolvers.push(resolve));
  renderCurrent();
});
ui.fastMode.addEventListener('change', async () => {
  fastModeChoice = ui.fastMode.checked;
  if (mediaKind === 'video') {
    updateVideoModeLabel();
    setVideoCanvasSize();
    await enterVideoEditor(true);
  }
});
ui.padding.addEventListener('input', async () => {
  ui.paddingValue.textContent = `${ui.padding.value}%`;
  if (mediaKind === 'video') { await enterVideoEditor(); return; }
  renderCurrent();
});
ui.seek.addEventListener('change', async () => {
  if (exporting || !videoAnalysis.length) return;
  await seekSource(Number(ui.seek.value) / 1000 * ui.video.duration);
  await renderCurrent();
});
ui.editVideo.addEventListener('click', () => { enterVideoEditor().catch((error) => setStatus(error.message)); });
ui.processVideo.addEventListener('click', () => {
  // Start playback inside the tap handler so mobile browsers can authorize it.
  // The processing pass seeks back to the start before recording.
  if (analysisComplete) {
    audioContext?.resume().catch(() => {});
    const started = ui.video.play();
    started.then(() => {
      ui.video.pause();
      processVideo();
    }, () => processVideo());
  } else {
    processVideo();
  }
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
async function exportPhoto() {
  await renderCurrent();
  const blob = await new Promise((resolve) => ui.canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Impossible de créer la photo.');
  downloadBlob(blob, `${file.name.replace(/\.[^.]+$/, '')}-anonymise.png`);
  setStatus('Photo téléchargée. Ouvrez-la en grand avant de la partager.');
}
async function analyzeVideo(fast) {
  const plan = videoScanPlan(ui.video.duration, fast ? 'fast' : 'careful');
  const checks = scanChecks(plan);
  videoAnalysis = [];
  analysisComplete = false;
  coveredErrorFrames = 0;
  faceMemory.reset();
  let consecutiveErrors = 0;
  const detectorState = { smallChecksFailed: false };
  const detailFrames = [];
  const scannedByMillisecond = new Map();
  const totalChecks = checks.length;
  let completedChecks = 0;
  const detectAt = async (time, side) => {
    await seekSource(time);
    sourceCtx.drawImage(ui.video, 0, 0, sourceCanvas.width, sourceCanvas.height);
    try {
      const boxes = await detectWithFallback(centerFace, sourceCanvas, side, detectorState);
      consecutiveErrors = 0;
      return boxes;
    } catch (error) {
      console.error(error);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        const detail = String(error?.message || 'erreur inconnue').split('\n')[0].slice(0, 150);
        throw new Error(`La recherche des visages s’est arrêtée. Détail : ${detail}`);
      }
      coveredErrorFrames++;
      return [{ originX: 0, originY: 0, width: ui.video.videoWidth, height: ui.video.videoHeight }];
    }
  };
  const reportProgress = () => {
    completedChecks++;
    const percent = Math.round(completedChecks / totalChecks * 70);
    ui.progressBar.style.width = `${percent}%`;
    ui.progressText.textContent = `${percent}%`;
    setStatus(`${fast ? 'Mode rapide' : 'Mode minutieux'} · Recherche des visages : ${completedChecks} sur ${totalChecks}…`);
  };
  for (let index = 0; index < checks.length; index++) {
    const { time, maxSide, detail } = checks[index];
    const frame = { time, boxes: await detectAt(time, maxSide) };
    const key = Math.round(time * 1000);
    scannedByMillisecond.set(key, frame);
    if (detail) detailFrames.push(frame);
    reportProgress();
    if (index % 3 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (const time of plan.times) {
    const key = Math.round(time * 1000);
    const nearbyDetail = detailFrames.length ? coverageAt(detailFrames, time, { sweep: false }) : [];
    const detected = scannedByMillisecond.get(key).boxes;
    const boxes = faceMemory.update([...detected, ...nearbyDetail], time);
    videoAnalysis.push({ time, boxes, detections: detected });
  }
  analysisComplete = true;
  await seekSource(0);
}

async function recordProcessedVideo(fast) {
  if (!ui.canvas.captureStream || !window.MediaRecorder)
    throw new Error('Ce navigateur ne peut pas créer la vidéo.');
  const outputFps = fast ? 24 : 30;
  const mime = (fast ? [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp8,opus', 'video/webm', 'video/webm;codecs=vp9,opus'
  ] : [
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm'
  ]).find((type) => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error('Ce navigateur ne peut pas créer la vidéo.');

  await seekSource(0);
  paintCachedVideoFrame(0);
  outputStream = ui.canvas.captureStream(0);
  let captureTrack = outputStream.getVideoTracks()[0];
  if (!captureTrack?.requestFrame) {
    outputStream.getTracks().forEach((track) => track.stop());
    outputStream = ui.canvas.captureStream(outputFps);
    captureTrack = outputStream.getVideoTracks()[0];
  }
  if (!captureTrack) throw new Error('Impossible de créer la vidéo.');

  audioIncluded = false;
  try {
    audioContext ||= new AudioContext();
    audioDestination ||= audioContext.createMediaStreamDestination();
    if (!audioSource) {
      audioSource = audioContext.createMediaElementSource(ui.video);
      audioSource.connect(audioDestination);
    }
    await audioContext.resume();
    for (const track of audioDestination.stream.getAudioTracks()) {
      outputStream.addTrack(track);
      audioIncluded = true;
    }
  } catch (error) {
    console.error(error);
  }

  const chunks = [];
  recorder = new MediaRecorder(outputStream, { mimeType: mime, videoBitsPerSecond: fast ? 2_500_000 : 5_000_000 });
  const finished = new Promise((resolve, reject) => {
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => reject(new Error('L’enregistrement de la vidéo a échoué.'));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });
  let callbackId;
  let animationId;
  let stopWatching;
  let nextCaptureTime = 1 / outputFps;
  try {
    recorder.start(1000);
    captureTrack.requestFrame?.();
    const playbackFinished = new Promise((resolve, reject) => {
      const video = ui.video;
      const cleanup = () => {
        video.removeEventListener('ended', onEnded);
        video.removeEventListener('error', onError);
        if (callbackId !== undefined) video.cancelVideoFrameCallback?.(callbackId);
        if (animationId !== undefined) cancelAnimationFrame(animationId);
      };
      stopWatching = cleanup;
      const onEnded = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('La lecture a échoué pendant la création de la vidéo.')); };
      const tick = (_now, metadata) => {
        try {
          const time = metadata?.mediaTime ?? video.currentTime;
          if (!fast || time + 0.003 >= nextCaptureTime) {
            paintCachedVideoFrame(time);
            captureTrack.requestFrame?.();
            while (nextCaptureTime <= time + 0.003) nextCaptureTime += 1 / outputFps;
          }
          const percent = Math.min(99, 70 + Math.round(time / video.duration * 29));
          ui.progressBar.style.width = `${percent}%`;
          ui.progressText.textContent = `${percent}%`;
          setStatus('Création du fichier vidéo…');
          if (!video.ended) {
            if (video.requestVideoFrameCallback) callbackId = video.requestVideoFrameCallback(tick);
            else animationId = requestAnimationFrame(tick);
          }
        } catch (error) { cleanup(); reject(error); }
      };
      video.addEventListener('ended', onEnded);
      video.addEventListener('error', onError);
      if (video.ended) { onEnded(); return; }
      if (video.requestVideoFrameCallback) callbackId = video.requestVideoFrameCallback(tick);
      else animationId = requestAnimationFrame(tick);
    });
    try { await ui.video.play(); }
    catch (error) { stopWatching?.(); throw error; }
    await playbackFinished;
    paintCachedVideoFrame(ui.video.currentTime);
    captureTrack.requestFrame?.();
    await new Promise((resolve) => setTimeout(resolve, 150));
    recorder.stop();
    const blob = await finished;
    if (!blob.size) throw new Error('La vidéo créée est vide.');
    return { blob, mime };
  } finally {
    ui.video.pause();
    if (recorder?.state === 'recording') recorder.stop();
    outputStream?.getVideoTracks().forEach((track) => track.stop());
    outputStream = null;
  }
}

async function processVideo() {
  if (mediaKind !== 'video' || exporting || !centerFace.session) return;
  const fast = fastModeChoice;
  ui.fastMode.checked = fast;
  setVideoCanvasSize();
  updateVideoModeLabel();
  exporting = true;
  ui.download.disabled = true;
  ui.processVideo.disabled = true;
  ui.editVideo.disabled = true;
  ui.file.disabled = true;
  ui.fastMode.disabled = true;
  ui.padding.disabled = true;
  ui.maskColor.disabled = true;
  ui.progress.hidden = false;
  ui.progressBar.style.width = '0%';
  ui.progressText.textContent = '0%';
  ui.resultVideo.hidden = true;
  ui.canvas.hidden = false;
  ui.overlay.hidden = true;
  ui.timeline.hidden = true;
  paintCover({ x: 0, y: 0, width: ui.canvas.width, height: ui.canvas.height });
  try {
    if (!analysisComplete) await analyzeVideo(fast);
    ui.progressBar.style.width = '70%';
    ui.progressText.textContent = '70%';
    setStatus('Création du fichier vidéo…');
    const { blob, mime } = await recordProcessedVideo(fast);
    processedVideoBlob = blob;
    processedMime = mime;
    processedVideoUrl = URL.createObjectURL(blob);
    ui.resultVideo.src = processedVideoUrl;
    ui.resultVideo.hidden = false;
    ui.canvas.hidden = true;
    ui.editVideo.hidden = false;
    ui.processVideo.hidden = true;
    ui.download.disabled = false;
    ui.progressBar.style.width = '100%';
    ui.progressText.textContent = '100%';
    const sound = audioIncluded ? 'avec le son' : 'sans le son';
    const covered = coveredErrorFrames ? ` ${coveredErrorFrames} image(s) entièrement couverte(s) après un problème pendant le traitement.` : '';
    setStatus(`Vidéo prête ${sound} (${fast ? 'mode rapide' : 'mode minutieux'}). Regardez-la entièrement avant de la partager.${covered}`);
  } catch (error) {
    console.error(error);
    ui.processVideo.hidden = false;
    ui.download.disabled = true;
    setStatus(`${error.message || 'La vidéo n’a pas pu être créée.'} Touchez « Refaire la vidéo » pour réessayer.`);
  } finally {
    exporting = false;
    ui.processVideo.disabled = false;
    ui.editVideo.disabled = false;
    ui.file.disabled = false;
    ui.fastMode.disabled = false;
    ui.padding.disabled = false;
    ui.maskColor.disabled = false;
  }
}

ui.download.addEventListener('click', async () => {
  if (!file || exporting || !centerFace.session) return;
  if (mediaKind === 'video') {
    if (!processedVideoBlob) return;
    const extension = processedMime.startsWith('video/mp4') ? 'mp4' : 'webm';
    downloadBlob(processedVideoBlob, `${file.name.replace(/\.[^.]+$/, '')}-anonymise.${extension}`);
    return;
  }
  exporting = true;
  ui.download.disabled = true;
  ui.maskColor.disabled = true;
  setStatus('Création de la photo…');
  try { await exportPhoto(); }
  catch (error) { setStatus(error.message || 'La photo n’a pas pu être créée.'); }
  finally {
    exporting = false;
    ui.download.disabled = false;
    ui.maskColor.disabled = false;
  }
});

ui.fastMode.disabled = false;
loadDetector().catch(() => {});
