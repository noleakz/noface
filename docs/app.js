import { FaceMemory } from './face-memory.mjs';
import { CenterFaceDetector } from './centerface.mjs';

const $ = (id) => document.getElementById(id);
const ui = {
  file: $('file-input'), drop: $('drop-zone'), canvasWrap: $('canvas-wrap'), canvas: $('canvas'),
  overlay: $('draw-overlay'), video: $('source-video'), timeline: $('timeline'), seek: $('seek'),
  play: $('play-button'), time: $('time-display'), status: $('status'), progress: $('progress-track'),
  progressBar: $('progress-bar'), progressText: $('progress-text'), name: $('file-name'),
  kind: $('file-kind'), detector: $('detector'), maskColor: $('mask-color'), maskColorValue: $('mask-color-value'),
  padding: $('padding'), paddingValue: $('padding-value'),
  maskList: $('mask-list'), maskCount: $('mask-count'), download: $('download')
};

const ctx = ui.canvas.getContext('2d', { willReadFrequently: false });
const sourceCanvas = document.createElement('canvas');
const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: false });
let detector;
let detectorPromise;
let detectorMode = 'IMAGE';
const faceMemory = new FaceMemory();
const centerFace = new CenterFaceDetector();
let file;
let fileUrl;
let image;
let mediaKind;
let masks = [];
let dragging;
let exporting = false;
let renderBusy = false;
let renderIdleResolvers = [];
let frameRequest;
let recorder;
let outputStream;
let audioContext;
let audioSource;
let audioDestination;
let audioIncluded = false;
let coveredErrorFrames = 0;

function setStatus(message) { ui.status.textContent = message; }
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
    const { FaceDetector, FilesetResolver } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite', delegate: 'CPU' },
      runningMode: 'IMAGE', minDetectionConfidence: 0.35
    });
    setStatus('Détecteur prêt. Choisissez un fichier.');
    if (file) await renderCurrent();
  })().catch((error) => {
    detectorPromise = null;
    console.error(error);
    setStatus('Impossible de charger le détecteur de visages. Vérifiez votre connexion.');
    throw error;
  });
  return detectorPromise;
}

function resetMedia() {
  faceMemory.reset();
  ui.video.pause();
  ui.video.removeAttribute('src');
  ui.video.load();
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = null;
  if (image?.close) image.close();
  image = null;
  masks = [];
  renderMaskList();
  ui.download.disabled = true;
  ui.timeline.hidden = true;
  ui.progress.hidden = true;
  ui.progressText.textContent = '';
  ui.progressBar.style.width = '0%';
}

async function chooseFile(nextFile) {
  if (!nextFile || exporting) return;
  const kind = nextFile.type.startsWith('image/') ? 'image' : nextFile.type.startsWith('video/') ? 'video' : null;
  if (!kind) { setStatus('Choisissez une photo ou une vidéo.'); return; }
  resetMedia();
  file = nextFile;
  mediaKind = kind;
  ui.name.textContent = nextFile.name;
  ui.kind.textContent = kind === 'image' ? 'PHOTO' : 'VIDÉO';
  ui.drop.hidden = true;
  ui.canvasWrap.hidden = false;
  setStatus('Ouverture du fichier…');
  try {
    if (kind === 'image') {
      image = await createImageBitmap(nextFile, { imageOrientation: 'from-image' });
      setCanvasSize(image.width, image.height);
    } else {
      fileUrl = URL.createObjectURL(nextFile);
      ui.video.src = fileUrl;
      await new Promise((resolve, reject) => {
        ui.video.onloadedmetadata = resolve;
        ui.video.onerror = () => reject(new Error('Ce navigateur ne peut pas ouvrir cette vidéo. Essayez un fichier MP4 ou WebM.'));
      });
      setCanvasSize(ui.video.videoWidth, ui.video.videoHeight);
      ui.timeline.hidden = false;
      updateTime();
      await seekVideo(0.001);
    }
    updateOverlaySize();
    if (!detector) await loadDetector();
    const rendered = await renderCurrent();
    ui.download.disabled = !rendered;
    if (rendered) setStatus(kind === 'image' ? 'Vérifiez la photo et ajoutez des masques si nécessaire.' : 'Parcourez la vidéo pour repérer les visages oubliés.');
  } catch (error) {
    setStatus(error.message || 'Impossible d’ouvrir ce fichier.');
  }
}

function setCanvasSize(width, height) {
  if (!width || !height) throw new Error('Ce fichier ne contient aucune image lisible.');
  ui.canvas.width = sourceCanvas.width = width;
  ui.canvas.height = sourceCanvas.height = height;
}
async function seekVideo(time) {
  await new Promise((resolve, reject) => {
    const video = ui.video;
    const target = Math.max(0, Math.min(time, Math.max(0, video.duration - 0.001)));
    if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) { resolve(); return; }
    video.addEventListener('seeked', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Impossible de se déplacer dans la vidéo.')), { once: true });
    video.currentTime = target;
  });
  faceMemory.reset();
  if (detector && detectorMode === 'VIDEO') {
    await detector.setOptions({ runningMode: 'IMAGE' });
    detectorMode = 'IMAGE';
  }
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
async function renderCurrent() {
  if (!file || !detector || renderBusy) return;
  renderBusy = true;
  try {
    const subject = mediaKind === 'image' ? image : ui.video;
    const neededMode = mediaKind === 'image' ? 'IMAGE' : 'VIDEO';
    if (detectorMode !== neededMode) {
      await detector.setOptions({ runningMode: neededMode });
      detectorMode = neededMode;
    }
    sourceCtx.drawImage(subject, 0, 0, sourceCanvas.width, sourceCanvas.height);
    const detections = mediaKind === 'image'
      ? detector.detect(image).detections
      : detector.detectForVideo(ui.video, performance.now()).detections;
    const detectedBoxes = detections.map((detection) => detection.boundingBox);
    if (ui.detector.value === 'combined') {
      if (!centerFace.session) setStatus('Chargement de CenterFace…');
      const centerBoxes = await centerFace.detect(sourceCanvas, mediaKind === 'image' ? 1280 : 960);
      detectedBoxes.push(...centerBoxes);
    }
    const boxes = mediaKind === 'video'
      ? faceMemory.update(detectedBoxes, ui.video.currentTime)
      : detectedBoxes;
    ctx.drawImage(sourceCanvas, 0, 0);
    for (const box of boxes) paintCover(paddedBox(box));
    for (const mask of masks) paintCover({
      x: mask.x * ui.canvas.width, y: mask.y * ui.canvas.height,
      width: mask.width * ui.canvas.width, height: mask.height * ui.canvas.height
    });
    if (exporting && outputStream?.getVideoTracks()[0]?.requestFrame)
      outputStream.getVideoTracks()[0].requestFrame();
    updateTime();
    return true;
  } catch (error) {
    // A failed detector must never produce an untouched frame in the exported video.
    paintCover({ x: 0, y: 0, width: ui.canvas.width, height: ui.canvas.height });
    if (exporting) coveredErrorFrames++;
    if (exporting && outputStream?.getVideoTracks()[0]?.requestFrame)
      outputStream.getVideoTracks()[0].requestFrame();
    console.error(error);
    const alternative = ui.detector.value === 'combined' ? ' Choisissez « MediaPipe seul » pour continuer.' : '';
    setStatus(`Détection impossible : ${error.message || 'erreur inconnue'}. L’image a été entièrement recouverte.${alternative}`);
    return false;
  } finally {
    renderBusy = false;
    for (const resolve of renderIdleResolvers.splice(0)) resolve();
  }
}

function renderMaskList() {
  ui.maskCount.textContent = `${masks.length} masque${masks.length > 1 ? 's' : ''}`;
  ui.maskList.replaceChildren();
  masks.forEach((_, index) => {
    const button = document.createElement('button');
    button.className = 'mask-chip';
    button.type = 'button';
    button.textContent = `Masque ${index + 1} ×`;
    button.setAttribute('aria-label', `Supprimer le masque ${index + 1}`);
    button.onclick = () => { masks.splice(index, 1); renderMaskList(); renderCurrent(); };
    ui.maskList.append(button);
  });
}
function pointOnOverlay(event) {
  const rect = ui.overlay.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
}
ui.overlay.addEventListener('pointerdown', (event) => {
  if (!file || exporting) return;
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
  renderMaskList(); await renderCurrent();
});

ui.file.addEventListener('change', () => chooseFile(ui.file.files[0]));
ui.drop.addEventListener('dragover', (event) => { event.preventDefault(); ui.drop.classList.add('dragging'); });
ui.drop.addEventListener('dragleave', () => ui.drop.classList.remove('dragging'));
ui.drop.addEventListener('drop', (event) => { event.preventDefault(); ui.drop.classList.remove('dragging'); chooseFile(event.dataTransfer.files[0]); });
ui.detector.addEventListener('change', async () => {
  faceMemory.reset();
  if (!file) return;
  ui.download.disabled = true;
  if (renderBusy) await new Promise((resolve) => renderIdleResolvers.push(resolve));
  const rendered = await renderCurrent();
  ui.download.disabled = !rendered;
  if (rendered) setStatus('Détecteur changé. Vérifiez le résultat avant de partager.');
});
ui.maskColor.addEventListener('input', async () => {
  ui.maskColorValue.textContent = opaqueMaskColor().toUpperCase();
  if (renderBusy) await new Promise((resolve) => renderIdleResolvers.push(resolve));
  renderCurrent();
});
ui.padding.addEventListener('input', () => { ui.paddingValue.textContent = `${ui.padding.value}%`; renderCurrent(); });
ui.seek.addEventListener('input', async () => {
  if (exporting) return;
  ui.video.pause(); ui.play.textContent = '▶'; ui.play.setAttribute('aria-label', 'Lire la vidéo');
  await seekVideo(Number(ui.seek.value) / 1000 * ui.video.duration);
  await renderCurrent();
});
ui.play.addEventListener('click', async () => {
  if (exporting) return;
  if (ui.video.paused) {
    if (ui.video.ended) await seekVideo(0);
    await ui.video.play(); ui.play.textContent = 'Ⅱ'; ui.play.setAttribute('aria-label', 'Mettre la vidéo en pause');
    const tick = async () => {
      if (ui.video.paused || exporting) return;
      await renderCurrent();
      frameRequest = ui.video.requestVideoFrameCallback(tick);
    };
    frameRequest = ui.video.requestVideoFrameCallback(tick);
  } else {
    ui.video.pause(); ui.play.textContent = '▶'; ui.play.setAttribute('aria-label', 'Lire la vidéo');
    ui.video.cancelVideoFrameCallback?.(frameRequest);
  }
});
ui.video.addEventListener('ended', () => { ui.play.textContent = '▶'; ui.play.setAttribute('aria-label', 'Lire la vidéo'); updateTime(); });

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
  setStatus('Photo téléchargée. Vérifiez-la en taille réelle avant de la partager.');
}
async function exportVideo() {
  if (!ui.canvas.captureStream || !window.MediaRecorder || !ui.video.requestVideoFrameCallback)
    throw new Error('Ce navigateur ne permet pas l’export vidéo.');
  const mime = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm'
  ]
    .find((type) => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error('Ce navigateur ne peut pas encoder de vidéo compatible.');
  ui.video.pause();
  ui.video.cancelVideoFrameCallback?.(frameRequest);
  await seekVideo(0);
  faceMemory.reset();
  outputStream = ui.canvas.captureStream(0);
  if (!outputStream.getVideoTracks()[0]?.requestFrame) {
    outputStream.getTracks().forEach((track) => track.stop());
    outputStream = null;
    throw new Error('Ce navigateur ne peut pas enregistrer les images traitées.');
  }
  coveredErrorFrames = 0;
  audioIncluded = false;
  // Route source audio only into the recording, never to speakers during export.
  try {
    audioContext ||= new AudioContext();
    audioDestination ||= audioContext.createMediaStreamDestination();
    if (!audioSource) {
      audioSource = audioContext.createMediaElementSource(ui.video);
      audioSource.connect(audioDestination);
    }
    await audioContext.resume();
    for (const track of audioDestination.stream.getAudioTracks()) { outputStream.addTrack(track); audioIncluded = true; }
  } catch (error) {
    console.error(error);
    setStatus('Son indisponible. La vidéo exportée sera muette.');
  }
  const chunks = [];
  recorder = new MediaRecorder(outputStream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  const finished = new Promise((resolve, reject) => {
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => reject(new Error('L’enregistrement de la vidéo a échoué.'));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });
  ui.progress.hidden = false;
  ui.progressText.textContent = '0%';
  recorder.start(1000);
  await ui.video.play();
  await new Promise((resolve, reject) => {
    const video = ui.video;
    const onError = () => reject(new Error('La lecture de la vidéo a échoué pendant l’export.'));
    video.addEventListener('error', onError, { once: true });
    const tick = async () => {
      if (video.ended) { resolve(); return; }
      await renderCurrent();
      const percent = Math.min(99, Math.round(video.currentTime / video.duration * 100));
      ui.progressBar.style.width = `${percent}%`;
      ui.progressText.textContent = `${percent}%`;
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
    video.addEventListener('ended', resolve, { once: true });
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await renderCurrent();
  recorder.stop();
  const blob = await finished;
  outputStream.getTracks().forEach((track) => { if (track.kind === 'video') track.stop(); });
  outputStream = null;
  ui.progressBar.style.width = '100%';
  ui.progressText.textContent = '100%';
  if (!blob.size) throw new Error('La vidéo exportée est vide.');
  downloadBlob(blob, `${file.name.replace(/\.[^.]+$/, '')}-anonymise.${mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`);
  const audioNote = audioIncluded ? 'avec le son' : 'sans le son';
  const errorNote = coveredErrorFrames ? ` ${coveredErrorFrames} image${coveredErrorFrames > 1 ? 's ont été entièrement recouvertes' : ' a été entièrement recouverte'} après une erreur de détection.` : '';
  setStatus(`Vidéo téléchargée ${audioNote}.${errorNote} Regardez-la en entier avant de la partager.`);
}
ui.download.addEventListener('click', async () => {
  if (!file || exporting || !detector) return;
  exporting = true;
  ui.download.disabled = true;
  ui.maskColor.disabled = true;
  ui.download.textContent = 'TRAITEMENT EN COURS…';
  setStatus(mediaKind === 'image' ? 'Création de la photo…' : 'Traitement de la vidéo en temps réel…');
  try { if (mediaKind === 'image') await exportPhoto(); else await exportVideo(); }
  catch (error) { setStatus(error.message || 'L’export a échoué.'); }
  finally {
    exporting = false; ui.download.disabled = false; ui.maskColor.disabled = false; ui.download.textContent = 'TÉLÉCHARGER LE FICHIER ANONYMISÉ';
    if (recorder?.state === 'recording') recorder.stop();
  }
});

loadDetector().catch(() => {});
