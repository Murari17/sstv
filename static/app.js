// SSTV Web Emulator - simplified educational encoder/decoder
// Encoder: converts an image to a sequence of tones (simulated SSTV-like)
// Decoder: basic energy-based decoding from uploaded audio (very simple)

let audioCtx = null;
let generatedBuffer = null;
let masterGain = null;
let liveDecodeNode = null;
let liveDecodeAnalyser = null;
let liveDecodeAnimation = null;
let playingSource = null;
let playingStartTime = 0;
let playingOffsetSeconds = 0;
let playingPaused = false;
const APP_BUILD = '2026-03-17-02';

function ensureAudioCtx(){
  if(!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(audioCtx.destination);
  }
}

function fileToImage(file){
  return new Promise((resolve,reject)=>{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e)=>{ URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function drawPreview(img){
  const canvas = document.getElementById('previewCanvas');
  const ctx = canvas.getContext('2d');
  // fit into canvas
  const ratio = Math.min(canvas.width/img.width, canvas.height/img.height);
  const w = img.width*ratio, h=img.height*ratio;
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(img,0,0,w,h);
}

function imageToRGBSamples(img, cols=320, rows=256){
  const c = document.createElement('canvas'); c.width=cols; c.height=rows;
  const ctx = c.getContext('2d');
  ctx.drawImage(img,0,0,cols,rows);
  const data = ctx.getImageData(0,0,cols,rows).data;
  const samples = [];
  for(let y=0;y<rows;y++){
    const row = new Array(cols);
    for(let x=0;x<cols;x++){
      const i=(y*cols+x)*4;
      const r=data[i]/255, g=data[i+1]/255, b=data[i+2]/255;
      row[x]=[r,g,b];
    }
    samples.push(row);
  }
  return samples;
}

// Helper: create a buffer with given float data
function createAudioBufferFromFloat(floatArr, sampleRate){
  return {buffer:floatArr, sampleRate};
}

function detectHeaderToneMultiplier(chan, sampleRate){
  // Header layout: 300ms leader + 3*50ms VIS + 60ms mode marker.
  // RGB-only mode marker: 1300Hz.
  const markerStart = Math.floor(sampleRate * 0.45);
  const markerLen = Math.max(32, Math.floor(sampleRate * 0.06));
  if(markerStart + markerLen >= chan.length) return null;
  const frame = chan.subarray(markerStart, markerStart + markerLen);
  const magRgb = goertzel(frame, sampleRate, 1300);
  const maxMag = magRgb;
  if(maxMag < 1e-3) return null;
  return 3;
}

// Implement a simplified Scottie S1-like encoder timing with sync pulses.
// RGB-only SSTV-like encoder timing with sync pulses.
function synthesizeSSTV(samples, sampleRate=44100, options={}){
  // samples: array rows x cols. options.durationSeconds: target total seconds.
  const rows = samples.length;
  const cols = samples[0].length;
  const totalPixels = rows * cols;
  const toneMultiplier = 3;
  const totalTones = totalPixels * toneMultiplier;

  // Scottie S1 (very simplified): each line has a VIS/sync period + pixel periods.
  // For our emulator we'll compute tone ms per pixel so full image fits duration.
  let tonePerPixelMs = 10;
  if(options.durationSeconds && options.durationSeconds > 0){
    const totalMs = options.durationSeconds * 1000;
    // Reserve a small fraction for syncs overhead (~2%):
    const effectiveMs = Math.max(100, totalMs * 0.98);
    // compute per-tone ms using totalTones (accounts for RGB channels)
    tonePerPixelMs = effectiveMs / totalTones;
    tonePerPixelMs = Math.max(1, Math.min(200, tonePerPixelMs));
  }

  const samplePerTone = Math.max(1, Math.floor(sampleRate * (tonePerPixelMs/1000)));

  // Precompute sizes
  const samplesPerLine = cols * samplePerTone * toneMultiplier;
  const syncPerLineSamples = Math.floor(sampleRate * 0.005); // 5ms sync tone approx
  const totalSamples = rows * (syncPerLineSamples + samplesPerLine);
  // We'll prepend a simple VIS-like header: a leader tone (1900Hz for 300ms), then a VIS tone sequence
  const leaderMs = 300;
  const leaderSamples = Math.floor(sampleRate*(leaderMs/1000));
  const visTones = [1900, 1200, 1900]; // small pattern
  const visSamples = visTones.length * Math.floor(sampleRate*0.05);
  const modeMarkerFreq = 1300;
  const modeMarkerSamples = Math.floor(sampleRate * 0.06);
  const metaToneSamples = Math.max(1, Math.floor(sampleRate * 0.03));
  const metaBaseFreq = 2600;
  const metaFreqs = [
    metaBaseFreq + cols,
    metaBaseFreq + rows,
    metaBaseFreq + samplePerTone
  ];
  const metaSamplesTotal = metaToneSamples * metaFreqs.length;
  const out = new Float32Array(leaderSamples + visSamples + modeMarkerSamples + metaSamplesTotal + totalSamples);
  let widx = 0;
  // leader
  for(let i=0;i<leaderSamples;i++) out[widx++] = Math.sin(2*Math.PI*1900*(i/sampleRate)) * 0.8;
  // vis pattern
  for(const vt of visTones){
    const vs = Math.floor(sampleRate*0.05);
    for(let i=0;i<vs;i++) out[widx++] = Math.sin(2*Math.PI*vt*(i/sampleRate)) * 0.8;
  }
  // Mode marker helps decoder verify RGB payload.
  for(let i=0;i<modeMarkerSamples;i++) out[widx++] = Math.sin(2*Math.PI*modeMarkerFreq*(i/sampleRate)) * 0.8;
  // Metadata tones encode: cols, rows, samplesPerTone.
  for(const mf of metaFreqs){
    for(let i=0;i<metaToneSamples;i++) out[widx++] = Math.sin(2*Math.PI*mf*(i/sampleRate)) * 0.8;
  }
  // now write lines

  for(let r=0;r<rows;r++){
    // simple sync tone (fixed 1200Hz)
    for(let i=0;i<syncPerLineSamples;i++){
      out[widx++] = Math.sin(2*Math.PI*1200*(i/sampleRate)) * 0.8;
    }
    // pixels
    const rowArr = samples[r];
    for(let c=0;c<cols;c++){
      const cell = rowArr[c];
      // cell = [r,g,b] each in 0..1; encode sequentially R,G,B
      const chans = [cell[0], cell[1], cell[2]];
      for(const bright of chans){
        const freq = 1500 + bright*(2300-1500);
        for(let s=0;s<samplePerTone;s++){
          const t = s / sampleRate;
          out[widx++] = Math.sin(2*Math.PI*freq*t) * 0.9;
        }
      }
    }
  }
  const meta = { samplePerTone, tonePerPixelMs, toneMultiplier, cols, rows, totalTones: totalTones };
  meta.colorMode = 'rgb';
  meta.headerOffset = leaderSamples + visSamples + modeMarkerSamples + metaSamplesTotal;
  return { buffer: out, sampleRate, meta };
}

function playFloat32Buffer(bufObj){
  ensureAudioCtx();
  const {buffer,sampleRate} = bufObj;
  const audioBuffer = audioCtx.createBuffer(1, buffer.length, sampleRate);
  audioBuffer.copyToChannel(buffer,0,0);
  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(masterGain);
  const offset = playingOffsetSeconds || 0;
  src.start(0, offset);
  playingSource = src;
  playingStartTime = audioCtx.currentTime - offset;
  // clear any analyser-based live decode to avoid double drawing
  if(liveDecodeAnimation){ stopLiveDecoding(); }
  return src;
}

function floatToWav(float32Array, sampleRate, sstvMeta){
  const dataBytes = float32Array.length * 2;
  const fmtChunkSize = 16;
  const sstvChunkSize = 24;
  const sstvPadded = sstvChunkSize + (sstvChunkSize % 2);
  const totalSize = 12 + (8 + fmtChunkSize) + (8 + sstvPadded) + (8 + dataBytes);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  function writeString(v, offset, str){
    for(let i=0;i<str.length;i++) v.setUint8(offset+i,str.charCodeAt(i));
  }

  let off = 0;
  writeString(view, off, 'RIFF'); off += 4;
  view.setUint32(off, totalSize - 8, true); off += 4;
  writeString(view, off, 'WAVE'); off += 4;

  writeString(view, off, 'fmt '); off += 4;
  view.setUint32(off, fmtChunkSize, true); off += 4;
  view.setUint16(off, 1, true); off += 2;
  view.setUint16(off, 1, true); off += 2;
  view.setUint32(off, sampleRate, true); off += 4;
  view.setUint32(off, sampleRate*2, true); off += 4;
  view.setUint16(off, 2, true); off += 2;
  view.setUint16(off, 16, true); off += 2;

  const meta = sstvMeta || {};
  writeString(view, off, 'sstv'); off += 4;
  view.setUint32(off, sstvChunkSize, true); off += 4;
  view.setUint16(off, 1, true); off += 2; // version
  view.setUint16(off, Math.max(1, meta.cols || 320), true); off += 2;
  view.setUint16(off, Math.max(1, meta.rows || 256), true); off += 2;
  view.setUint16(off, Math.max(1, meta.toneMultiplier || 3), true); off += 2;
  view.setUint32(off, Math.max(1, meta.samplePerTone || 1), true); off += 4;
  view.setUint32(off, Math.max(0, meta.headerOffset || 0), true); off += 4;
  const syncPerLine = Math.floor(sampleRate * 0.005);
  view.setUint32(off, Math.max(1, syncPerLine), true); off += 4;
  view.setUint32(off, sampleRate, true); off += 4;
  if(sstvChunkSize % 2 === 1){ view.setUint8(off, 0); off += 1; }

  writeString(view, off, 'data'); off += 4;
  view.setUint32(off, dataBytes, true); off += 4;
  for(let i=0;i<float32Array.length;i++){
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(off, s < 0 ? s*0x8000 : s*0x7FFF, true);
    off += 2;
  }
  return new Blob([view], {type:'audio/wav'});
}

// Goertzel-based decoder: detect strong frequency components corresponding to tone range and map to brightness.
// We'll scan each tone-frame and compute energy per candidate freq then pick the best.
function goertzel(samples, sampleRate, targetFreq){
  const N = samples.length;
  const k = Math.round((N * targetFreq) / sampleRate);
  const omega = (2*Math.PI*k)/N;
  const coeff = 2*Math.cos(omega);
  let q0=0, q1=0, q2=0;
  for(let i=0;i<N;i++){
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1; q1 = q0;
  }
  const real = q1 - q2 * Math.cos(omega);
  const imag = q2 * Math.sin(omega);
  return Math.sqrt(real*real + imag*imag);
}

function detectDominantFrequency(frame, sampleRate, fStart, fEnd, step=5){
  if(!frame || frame.length < 8) return fStart;
  let bestFreq = fStart;
  let bestMag = -1;
  for(let f=fStart; f<=fEnd; f+=step){
    const mag = goertzel(frame, sampleRate, f);
    if(mag > bestMag){
      bestMag = mag;
      bestFreq = f;
    }
  }
  return bestFreq;
}

function parseSstvMetadataFromWav(arrayBuffer){
  try{
    const view = new DataView(arrayBuffer);
    if(view.byteLength < 12) return null;
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if(riff !== 'RIFF' || wave !== 'WAVE') return null;
    let off = 12;
    while(off + 8 <= view.byteLength){
      const id = String.fromCharCode(view.getUint8(off), view.getUint8(off+1), view.getUint8(off+2), view.getUint8(off+3));
      const size = view.getUint32(off+4, true);
      const start = off + 8;
      if(id === 'sstv' && start + size <= view.byteLength && size >= 24){
        const version = view.getUint16(start, true);
        if(version !== 1) return null;
        return {
          cols: view.getUint16(start + 2, true),
          rows: view.getUint16(start + 4, true),
          toneMultiplier: view.getUint16(start + 6, true),
          samplePerTone: view.getUint32(start + 8, true),
          headerOffsetSamples: view.getUint32(start + 12, true),
          syncPerLineSamples: view.getUint32(start + 16, true),
          encodedSampleRate: view.getUint32(start + 20, true)
        };
      }
      off = start + size + (size % 2);
    }
  }catch(e){
    return null;
  }
  return null;
}

function parseWavMonoPcm(arrayBuffer){
  try{
    const view = new DataView(arrayBuffer);
    if(view.byteLength < 44) return null;
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if(riff !== 'RIFF' || wave !== 'WAVE') return null;

    let off = 12;
    let fmt = null;
    let dataOffset = -1;
    let dataSize = 0;
    while(off + 8 <= view.byteLength){
      const id = String.fromCharCode(view.getUint8(off), view.getUint8(off+1), view.getUint8(off+2), view.getUint8(off+3));
      const size = view.getUint32(off+4, true);
      const start = off + 8;
      if(id === 'fmt ' && start + size <= view.byteLength && size >= 16){
        fmt = {
          audioFormat: view.getUint16(start, true),
          channels: view.getUint16(start + 2, true),
          sampleRate: view.getUint32(start + 4, true),
          bitsPerSample: view.getUint16(start + 14, true)
        };
      }
      if(id === 'data' && start + size <= view.byteLength){
        dataOffset = start;
        dataSize = size;
      }
      off = start + size + (size % 2);
    }
    if(!fmt || dataOffset < 0) return null;
    if(fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return null;

    const bytesPerSample = fmt.bitsPerSample / 8;
    const frameSize = Math.max(1, fmt.channels * bytesPerSample);
    const frames = Math.floor(dataSize / frameSize);
    const out = new Float32Array(frames);
    let p = dataOffset;
    for(let i=0;i<frames;i++){
      const s = view.getInt16(p, true);
      out[i] = s / 32768;
      p += frameSize;
    }
    return {samples: out, sampleRate: fmt.sampleRate};
  }catch(e){
    return null;
  }
}

function setDecodeDebug(lines){
  const el = document.getElementById('decodeDebug');
  if(!el) return;
  const out = Array.isArray(lines) ? lines.join('\n') : String(lines);
  el.textContent = out;
}

// Improved decoder with sync/VIS detection, auto RGB detection and resolution control
async function decodeAudioBlob(blob, cols=320, rows=256, options={}){
  const array = await blob.arrayBuffer();
  const wavMeta = parseSstvMetadataFromWav(array);
  const wavPcm = parseWavMonoPcm(array);
  let chan;
  let sampleRate;
  let decodePath;
  if(wavPcm){
    chan = wavPcm.samples;
    sampleRate = wavPcm.sampleRate;
    decodePath = 'wav-pcm';
  } else {
    ensureAudioCtx();
    const decoded = await audioCtx.decodeAudioData(array.slice(0));
    chan = decoded.getChannelData(0);
    sampleRate = decoded.sampleRate;
    decodePath = 'webaudio';
  }
  let encodedCols, encodedRows, samplesPerTone, toneMultiplier, syncPerLineSamples, headerOffsetSamples;
  let metadataSource = 'wav-chunk';

  if(wavMeta){
    const srcRate = Math.max(1, wavMeta.encodedSampleRate || sampleRate);
    const ratio = sampleRate / srcRate;
    encodedCols = Math.max(16, Math.min(1024, wavMeta.cols || 320));
    encodedRows = Math.max(16, Math.min(1024, wavMeta.rows || 256));
    toneMultiplier = Math.max(1, Math.min(4, wavMeta.toneMultiplier || 3));
    samplesPerTone = Math.max(4, Math.min(4096, Math.round((wavMeta.samplePerTone || 1) * ratio)));
    headerOffsetSamples = Math.max(0, Math.round((wavMeta.headerOffsetSamples || 0) * ratio));
    syncPerLineSamples = Math.max(1, Math.round((wavMeta.syncPerLineSamples || Math.floor(srcRate*0.005)) * ratio));
  } else {
    metadataSource = 'tone-header';
    const leaderSamples = Math.floor(sampleRate * 0.3);
    const visToneSamples = Math.floor(sampleRate * 0.05);
    const visSamples = visToneSamples * 3;
    const modeMarkerSamples = Math.floor(sampleRate * 0.06);
    const metaToneSamples = Math.max(1, Math.floor(sampleRate * 0.03));
    const metaBaseFreq = 2600;
    const metaStart = leaderSamples + visSamples + modeMarkerSamples;
    if(metaStart + metaToneSamples*3 >= chan.length){
      setDecodeDebug([
        'Decoder debug: metadata header missing',
        `sampleRate=${sampleRate}`,
        `metaStart=${metaStart}`,
        `audioSamples=${chan.length}`,
        'path=fallback'
      ]);
      return simpleDecodeFallback(chan, sampleRate, cols, rows, options);
    }
    const colsFrame = chan.subarray(metaStart, metaStart + metaToneSamples);
    const rowsFrame = chan.subarray(metaStart + metaToneSamples, metaStart + metaToneSamples*2);
    const sptFrame = chan.subarray(metaStart + metaToneSamples*2, metaStart + metaToneSamples*3);
    encodedCols = Math.max(16, Math.min(1024, Math.round(detectDominantFrequency(colsFrame, sampleRate, 2600, 4000, 2) - metaBaseFreq)));
    encodedRows = Math.max(16, Math.min(1024, Math.round(detectDominantFrequency(rowsFrame, sampleRate, 2600, 4000, 2) - metaBaseFreq)));
    samplesPerTone = Math.max(4, Math.min(4096, Math.round(detectDominantFrequency(sptFrame, sampleRate, 2600, 4000, 2) - metaBaseFreq)));
    toneMultiplier = 3;
    syncPerLineSamples = Math.floor(sampleRate * 0.005);
    headerOffsetSamples = metaStart + metaToneSamples*3;
  }

  const totalPerLine = syncPerLineSamples + encodedCols * toneMultiplier * samplesPerTone;
  const desiredCols = parseInt(document.getElementById('resolutionSlider')?.value) || encodedCols;
  const outCols = Math.max(16, Math.min(desiredCols, encodedCols));
  const possibleRows = Math.floor((chan.length - headerOffsetSamples) / Math.max(1, totalPerLine));
  const outRows = Math.max(1, Math.min(encodedRows, possibleRows));
  const imgData = new Uint8ClampedArray(outCols*outRows*4);

  for(let y=0;y<outRows;y++){
    const lineStart = headerOffsetSamples + y * totalPerLine + syncPerLineSamples;
    for(let x=0;x<outCols;x++){
      const srcX = Math.floor((x / outCols) * encodedCols);
      const toneBase = srcX * toneMultiplier;
      const startSample = lineStart + toneBase * samplesPerTone;
      const idx = (y*outCols + x)*4;
      if(startSample + samplesPerTone*3 > chan.length){
        imgData[idx]=0; imgData[idx+1]=0; imgData[idx+2]=0; imgData[idx+3]=255;
        continue;
      }
      const r = detectFrameToGray(chan.subarray(startSample, startSample + samplesPerTone), sampleRate);
      const g = detectFrameToGray(chan.subarray(startSample + samplesPerTone, startSample + samplesPerTone*2), sampleRate);
      const b = detectFrameToGray(chan.subarray(startSample + samplesPerTone*2, startSample + samplesPerTone*3), sampleRate);
      imgData[idx]=r; imgData[idx+1]=g; imgData[idx+2]=b; imgData[idx+3]=255;
    }
  }

  const preview = [];
  const previewCount = Math.min(8, outCols * outRows);
  for(let i=0;i<previewCount;i++){
    const p = i*4;
    preview.push(`(${imgData[p]},${imgData[p+1]},${imgData[p+2]})`);
  }
  setDecodeDebug([
    'Decoder debug: metadata decode',
    `build=${APP_BUILD}`,
    `metadataSource=${metadataSource}`,
    `decodePath=${decodePath}`,
    `sampleRate=${sampleRate}`,
    `encodedCols=${encodedCols}`,
    `encodedRows=${encodedRows}`,
    `samplesPerTone=${samplesPerTone}`,
    `headerOffsetSamples=${headerOffsetSamples}`,
    `outCols=${outCols}`,
    `outRows=${outRows}`,
    `totalPerLine=${totalPerLine}`,
    `firstPixels=${preview.join(' ')}`
  ]);

  return {width:outCols, height:outRows, data:imgData};
}

// Helper: fallback simple decode used when sync detection fails
function simpleDecodeFallback(chan, sampleRate, outCols, outRows, options){
  const tonePerPixelMs = options.estimatedToneMs || 10;
  const encodedCols = options.encodedCols || 320;
  const encodedRows = options.encodedRows || 256;
  const samplesPerTone = Math.max(4, Math.floor(sampleRate * (tonePerPixelMs/1000)));
  const toneMultiplier = options.toneMultiplier || 3;
  const headerOffsetSamples = options.headerOffsetSamples || 0;
  const outputRows = Math.min(outRows, encodedRows);
  const imgData = new Uint8ClampedArray(outCols*outRows*4);
  for(let y=0;y<outputRows;y++){
    for(let x=0;x<outCols;x++){
      const srcX = Math.floor((x / outCols) * encodedCols);
      const toneBase = (y * encodedCols + srcX) * toneMultiplier;
      const idx = (y*outCols+x)*4;
      if(headerOffsetSamples + toneBase * samplesPerTone >= chan.length){
        imgData[idx]=0; imgData[idx+1]=0; imgData[idx+2]=0; imgData[idx+3]=255;
      } else {
        const vals = [0,0,0];
        for(let ch=0; ch<toneMultiplier; ch++){
          const start = headerOffsetSamples + (toneBase + ch) * samplesPerTone;
          if(start + samplesPerTone <= chan.length){
            const frame = chan.subarray(start, start + samplesPerTone);
            vals[ch] = detectFrameToGray(frame, sampleRate);
          }
        }
        imgData[idx]=vals[0]||0; imgData[idx+1]=vals[1]||0; imgData[idx+2]=vals[2]||0; imgData[idx+3]=255;
      }
    }
  }
  const preview = [];
  const previewCount = Math.min(8, outCols * outputRows);
  for(let i=0;i<previewCount;i++){
    const p = i*4;
    preview.push(`(${imgData[p]},${imgData[p+1]},${imgData[p+2]})`);
  }
  setDecodeDebug([
    'Decoder debug: fallback decode',
    `build=${APP_BUILD}`,
    `sampleRate=${sampleRate}`,
    `encodedCols=${encodedCols}`,
    `encodedRows=${encodedRows}`,
    `samplesPerTone=${samplesPerTone}`,
    `headerOffsetSamples=${headerOffsetSamples}`,
    `outCols=${outCols}`,
    `outRows=${outputRows}`,
    `firstPixels=${preview.join(' ')}`
  ]);
  return {width:outCols, height:outRows, data:imgData};
}

// Helper: detect frequency centroid in a frame and map to 0..255 channel value
function detectFrameToGray(frame, sampleRate){
  // allow detector selection via UI: goertzel (default) or fft (fft.js)
  const detector = document.getElementById('detectorSelect')?.value || 'goertzel';
  const N = frame.length;
  if(N <= 0) return 0;
  const win = new Float32Array(N); for(let i=0;i<N;i++) win[i]=0.54-0.46*Math.cos(2*Math.PI*i/(N-1));
  const windowed = new Float32Array(N); for(let i=0;i<N;i++) windowed[i]=frame[i]*win[i];
  // read freq min/max from UI
  const fmin = parseFloat(document.getElementById('freqMin')?.value) || 1500;
  const fmax = parseFloat(document.getElementById('freqMax')?.value) || 2300;
  if(detector === 'fft' && typeof FFT === 'function'){
    // use fft.js (FFT) for a peak-based estimate
    try{
      const fftSize = 1<<Math.ceil(Math.log2(N));
      const f = new FFT(fftSize);
      const re = new Array(fftSize).fill(0);
      const im = new Array(fftSize).fill(0);
      for(let i=0;i<N;i++) re[i]=windowed[i];
      f.transform(re, im);
      // compute magnitudes and find peak bin in fmin..fmax range
      let bestBin=0, bestMag=0;
      for(let bin=0; bin<fftSize/2; bin++){
        const freq = bin * (sampleRate / fftSize);
        if(freq < fmin-200 || freq > fmax+200) continue;
        const mag = Math.sqrt(re[bin]*re[bin] + im[bin]*im[bin]);
        if(mag > bestMag){ bestMag = mag; bestBin = bin; }
      }
      const freqEstimate = bestBin * (sampleRate / fftSize);
      const norm = (freqEstimate - fmin)/(fmax-fmin); const clamped = Math.max(0, Math.min(1, norm));
      return Math.floor(clamped*255);
    }catch(e){ /* fallback to goertzel below */ }
  }
  // default: Goertzel peak search across candidate freqs.
  // Peak tracking is more stable than centroid for short SSTV tone frames.
  let bestFreq = fmin;
  let bestMag = -1;
  for(let f=Math.max(800, fmin-200); f<=Math.min(4000, fmax+200); f+=10){
    const mag = goertzel(windowed, sampleRate, f);
    if(mag > bestMag){
      bestMag = mag;
      bestFreq = f;
    }
  }
  const freqEstimate = bestMag > 0 ? bestFreq : (fmin+fmax)/2;
  const norm = (freqEstimate - fmin)/(fmax-fmin); const clamped = Math.max(0, Math.min(1, norm));
  return Math.floor(clamped*255);
}

function drawDecodedImage(imgObj){
  const canvas = document.getElementById('decodedCanvas');
  const useDPR = document.getElementById('useDPR')?.checked;
  const dpr = useDPR ? (window.devicePixelRatio || 1) : 1;
  canvas.width = Math.max(1, Math.floor(imgObj.width * dpr));
  canvas.height = Math.max(1, Math.floor(imgObj.height * dpr));
  canvas.style.width = imgObj.width + 'px';
  canvas.style.height = imgObj.height + 'px';
  const ctx = canvas.getContext('2d');
  if(dpr !== 1) ctx.setTransform(dpr,0,0,dpr,0,0); else ctx.setTransform(1,0,0,1,0,0);
  const id = new ImageData(imgObj.data,imgObj.width,imgObj.height);
  ctx.putImageData(id,0,0);
}

function drawLiveImage(imgObj){
  const canvas = document.getElementById('liveDecodedCanvas');
  // Set internal buffer size to image size, but scale display size using UI controls
  const canvasWidth = parseInt(document.getElementById('liveDisplayWidth')?.value) || 640;
  const canvasHeight = parseInt(document.getElementById('liveDisplayHeight')?.value) || 512;
  const useDPR = document.getElementById('useDPR')?.checked;
  const dpr = useDPR ? (window.devicePixelRatio || 1) : 1;
  canvas.width = Math.max(1, Math.floor(imgObj.width * dpr));
  canvas.height = Math.max(1, Math.floor(imgObj.height * dpr));
  canvas.style.width = canvasWidth + 'px'; canvas.style.height = canvasHeight + 'px';
  const ctx = canvas.getContext('2d');
  if(dpr !== 1) ctx.setTransform(dpr,0,0,dpr,0,0); else ctx.setTransform(1,0,0,1,0,0);
  const id = new ImageData(imgObj.data,imgObj.width,imgObj.height);
  ctx.putImageData(id,0,0);
}

function startLiveDecoding(analyser, cols=160, rows=128){
  // Prefer buffer-synchronized decoding if we have a generatedBuffer and playingSource
  if(generatedBuffer && playingSource){
    bufferSynchronizedLiveDecode(generatedBuffer, playingSource, cols, rows);
    return;
  }
  if(liveDecodeAnimation) return;
  const bufferLen = analyser.fftSize;
  const floatBuf = new Float32Array(bufferLen);
  // We'll produce a low-res image updated repeatedly. For speed, we'll decode a small block per frame.
  const outCols = Math.min(256, Math.max(32, cols));
  const outRows = Math.min(256, Math.max(32, rows));
  const imgData = new Uint8ClampedArray(outCols*outRows*4);
  let pIndex = 0;
  function step(){
    analyser.getFloatTimeDomainData(floatBuf);
  // decode this frame into a small number of pixels
    // Allow automatic tone-length detection from the analyser buffer if enabled
    let samplesPerTone = Math.max(4, Math.floor(audioCtx.sampleRate * 0.01)); // default ~10ms
    try{
      if(document.getElementById('autoToneDetect')?.checked){
        // quick estimate: compute autocorrelation on the buffer to find repeating period
        const buf = floatBuf;
        const N = buf.length;
        let bestLag=0, bestScore=Infinity;
        const maxLag = Math.min(2000, Math.floor(N/4));
        for(let lag=1; lag<maxLag; lag++){
          let acc=0;
          for(let i=0;i+lag<N;i+=2) acc += Math.abs(buf[i] - buf[i+lag]);
          if(acc < bestScore){ bestScore = acc; bestLag = lag; }
        }
        if(bestLag > 4) samplesPerTone = Math.max(4, Math.floor(bestLag));
      }
    }catch(e){ /* ignore and use default */ }
    const numPixelsThisFrame = Math.max(1, Math.floor((floatBuf.length) / samplesPerTone));
    let idx=0;
  // clear only the pixels we will rewrite this frame to avoid cumulative darkening
  // (we'll reset the whole image on each call for simplicity)
  for(let i=0;i<imgData.length;i++) imgData[i]=0;
  // We'll consume the analyser buffer sequentially and attempt RGB decoding when there are at least
  // three tone-sized blocks available (the encoder uses sequential R,G,B tones).
  let pos = 0;
  for(let i=0;i<numPixelsThisFrame && pIndex < outCols*outRows;i++){
      // if there is room for three consecutive tone-frames, try decoding as R,G,B
      if(pos + samplesPerTone*3 <= floatBuf.length){
        const chVals = [];
        for(let ch=0; ch<3; ch++){
          const start = pos + ch*samplesPerTone;
          const frame = floatBuf.subarray(start, Math.min(start+samplesPerTone, floatBuf.length));
          // reuse existing detector to compute per-channel brightness
          const v = detectFrameToGray(frame, audioCtx.sampleRate);
          chVals.push(v);
        }
        const px = pIndex % outCols; const py = Math.floor(pIndex / outCols);
        const idxx = (py*outCols+px)*4; imgData[idxx]=chVals[0]; imgData[idxx+1]=chVals[1]; imgData[idxx+2]=chVals[2]; imgData[idxx+3]=255;
        pos += samplesPerTone*3;
      } else {
        // fallback single-channel estimate duplicated into RGB for incomplete buffers
        const start = pos;
        const frame = floatBuf.subarray(start, Math.min(start+samplesPerTone, floatBuf.length));
        const gray = detectFrameToGray(frame, audioCtx.sampleRate);
        const px = pIndex % outCols; const py = Math.floor(pIndex / outCols);
        const idxx = (py*outCols+px)*4; imgData[idxx]=imgData[idxx+1]=imgData[idxx+2]=gray; imgData[idxx+3]=255;
        pos += samplesPerTone;
      }
      pIndex++;
    }
    drawLiveImage({width:outCols, height:outRows, data:imgData});
    // wrap or continue
    if(pIndex >= outCols*outRows) pIndex = 0;
    liveDecodeAnimation = requestAnimationFrame(step);
  }
  liveDecodeAnimation = requestAnimationFrame(step);
}

function bufferSynchronizedLiveDecode(bufObj, sourceNode, cols=320, rows=256){
  // Use buffer metadata to compute tone timing and map playback time to pixel index. This is accurate and avoids analyser drift.
  if(!bufObj || !bufObj.meta) return;
  const meta = bufObj.meta;
  const outCols = meta.cols || cols; const outRows = meta.rows || rows;
  const pixels = outCols * outRows;
  const toneMs = meta.tonePerPixelMs; // per-tone (accounts for RGB multiplier in meta.totalTones)
  const samplesPerTone = meta.samplePerTone || Math.max(1, Math.floor(bufObj.sampleRate * (toneMs/1000)));
  const totalTones = meta.totalTones || (pixels * (meta.toneMultiplier||1));
  const imgData = new Uint8ClampedArray(outCols*outRows*4);
  // clear
  for(let i=0;i<imgData.length;i++) imgData[i]=0;
  function step(){
    const now = audioCtx.currentTime;
    const elapsed = now - playingStartTime; // seconds
    const elapsedMs = elapsed * 1000;
    // compute how many tones have been played so far
    const tonesPlayed = Math.floor(elapsedMs / toneMs);
  // map tones to pixels (toneMultiplier per pixel)
  const toneMultiplier = meta.toneMultiplier || 1;
  const headerOffset = meta.headerOffset || 0;
  const pixelsToShow = Math.min(pixels, Math.floor(tonesPlayed / toneMultiplier));
    // iterate and decode each pixel up to pixelsToShow by reading the buffer directly
    let p = 0;
    for(let y=0;y<outRows;y++){
      for(let x=0;x<outCols;x++){
          if(p >= pixelsToShow){
            // leave black for now
          } else {
          // compute tone index start in samples
          const toneIndex = p * toneMultiplier;
          // read the segment corresponding to first tone of this pixel
          const startSample = headerOffset + toneIndex * samplesPerTone;
          const frame = bufObj.buffer.subarray(startSample, Math.min(startSample+samplesPerTone, bufObj.buffer.length));
          // window
          const N=frame.length; const win=new Float32Array(N);
          for(let w=0;w<N;w++) win[w]=0.54-0.46*Math.cos(2*Math.PI*w/(N-1));
          const windowed = new Float32Array(N); for(let w=0;w<N;w++) windowed[w]=frame[w]*win[w];
          // centroid
          let weightedSum=0, weightTotal=0;
          const fmin = parseFloat(document.getElementById('freqMin')?.value) || 1500;
          const fmax = parseFloat(document.getElementById('freqMax')?.value) || 2300;
          for(let f=Math.max(800,fmin-200); f<=Math.min(4000,fmax+200); f+=10){ const mag=goertzel(windowed, bufObj.sampleRate, f); weightedSum+=mag*f; weightTotal+=mag; }
          const freqEst = weightTotal>0 ? (weightedSum/weightTotal) : (fmin+fmax)/2;
          const norm = (freqEst - fmin)/(fmax-fmin); const clamped = Math.max(0, Math.min(1, norm));
          const gray = Math.floor(clamped*255);
          const idx = (y*outCols+x)*4;
          if(meta.toneMultiplier && meta.toneMultiplier>1){
            // assume sequence R,G,B tones; attempt to decode three tones and assign to channels
            const channelVals = [];
            for(let ch=0; ch<meta.toneMultiplier; ch++){
              const startSampleCh = headerOffset + (toneIndex + ch) * samplesPerTone;
              const frameCh = bufObj.buffer.subarray(startSampleCh, Math.min(startSampleCh+samplesPerTone, bufObj.buffer.length));
              const Nch = frameCh.length; const winch = new Float32Array(Nch);
              for(let w=0;w<Nch;w++) winch[w]=0.54-0.46*Math.cos(2*Math.PI*w/(Nch-1));
              const windowedCh = new Float32Array(Nch); for(let w=0;w<Nch;w++) windowedCh[w]=frameCh[w]*winch[w];
              let weightedSumCh=0, weightTotalCh=0;
              const fmin = parseFloat(document.getElementById('freqMin')?.value) || 1500;
              const fmax = parseFloat(document.getElementById('freqMax')?.value) || 2300;
              for(let f=Math.max(800,fmin-200); f<=Math.min(4000,fmax+200); f+=10){ const mag=goertzel(windowedCh, bufObj.sampleRate, f); weightedSumCh+=mag*f; weightTotalCh+=mag; }
              const freqEstCh = weightTotalCh>0 ? (weightedSumCh/weightTotalCh) : 1500;
              const normCh = (freqEstCh - fmin)/(fmax-fmin); const clampedCh = Math.max(0, Math.min(1, normCh));
              channelVals.push(Math.floor(clampedCh*255));
            }
            imgData[idx]=channelVals[0]||0; imgData[idx+1]=channelVals[1]||0; imgData[idx+2]=channelVals[2]||0; imgData[idx+3]=255;
          } else {
            imgData[idx]=imgData[idx+1]=imgData[idx+2]=gray; imgData[idx+3]=255;
          }
        }
        p++;
      }
    }
    drawLiveImage({width:outCols, height:outRows, data:imgData});
    if(playingSource && playingStartTime && audioCtx.currentTime < playingStartTime + (meta.totalTones * (toneMs/1000))){
      liveDecodeAnimation = requestAnimationFrame(step);
    } else {
      // playback finished, stop
      stopLiveDecoding();
    }
  }
  stopLiveDecoding();
  liveDecodeAnimation = requestAnimationFrame(step);
}

function stopLiveDecoding(){
  if(liveDecodeAnimation) cancelAnimationFrame(liveDecodeAnimation);
  liveDecodeAnimation = null;
  if(liveDecodeAnalyser){ try{ masterGain.disconnect(liveDecodeAnalyser); }catch(e){} liveDecodeAnalyser=null; }
}

// UI wiring
document.getElementById('imgFile').addEventListener('change', async (e)=>{
  const f = e.target.files[0]; if(!f) return;
  const img = await fileToImage(f);
  drawPreview(img);
  window._lastImage = img;
});

document.getElementById('encodeBtn').addEventListener('click', async ()=>{
  const img = window._lastImage; if(!img) { alert('Select an image first'); return; }
  const sr = parseInt(document.getElementById('sampleRate').value) || 44100;
  const duration = parseInt(document.getElementById('encodeDuration').value) || 10;
  // Choose geometry that keeps per-tone duration long enough for stable color decoding.
  const effectiveMs = duration * 1000 * 0.98;
  const minToneMs = 6;
  const maxPixels = Math.max(32*32, Math.floor(effectiveMs / (minToneMs * 3)));
  const aspect = img.width / img.height;
  let rows = Math.max(32, Math.round(Math.sqrt(maxPixels / Math.max(0.1, aspect))));
  let cols = Math.max(32, Math.round(rows * aspect));
  rows = Math.min(256, rows);
  cols = Math.min(512, cols);
  const samples = imageToRGBSamples(img, cols, rows);
  const bufObj = synthesizeSSTV(samples, sr, {durationSeconds: duration});
  generatedBuffer = bufObj;
  playingOffsetSeconds = 0; playingPaused = false;
  const src = playFloat32Buffer(bufObj);
  // If live decode is enabled, wire an analyser to the playing node
  const liveToggle = document.getElementById('liveDecodeToggle');
  if(liveToggle && liveToggle.checked){
    // create a node from generated buffer and connect to master gain; use an analyser to read from masterGain
    try{
      if(liveDecodeAnalyser) { /* reuse */ }
      else {
        liveDecodeAnalyser = audioCtx.createAnalyser(); liveDecodeAnalyser.fftSize = 2048;
        ensureAudioCtx(); masterGain.connect(liveDecodeAnalyser);
      }
      startLiveDecoding(liveDecodeAnalyser, cols || 320, rows || 256);
    }catch(e){ console.warn('live decode setup failed', e); }
  }
  src.onended = ()=>{ console.log('playback ended'); };
  // enable pause/stop
  document.getElementById('pauseBtn').disabled = false;
  document.getElementById('stopBtn').disabled = false;
  document.getElementById('downloadWavBtn').disabled=false;
});

document.getElementById('pauseBtn').addEventListener('click', ()=>{
  if(!playingSource) return;
  if(!playingPaused){
    // pause: stop source and record offset
    const elapsed = audioCtx.currentTime - playingStartTime;
    try{ playingSource.stop(); }catch(e){}
    playingOffsetSeconds = elapsed;
    playingPaused = true;
    document.getElementById('pauseBtn').innerText = 'Resume';
  } else {
    // resume
    const src = playFloat32Buffer(generatedBuffer);
    playingSource = src;
    playingPaused = false;
    document.getElementById('pauseBtn').innerText = 'Pause';
  }
});

document.getElementById('stopBtn').addEventListener('click', ()=>{
  if(playingSource){ try{ playingSource.stop(); }catch(e){} }
  playingSource = null; playingOffsetSeconds = 0; playingPaused = false;
  document.getElementById('pauseBtn').disabled = true; document.getElementById('stopBtn').disabled = true; document.getElementById('pauseBtn').innerText='Pause';
  stopLiveDecoding();
});

document.getElementById('downloadWavBtn').addEventListener('click', ()=>{
  if(!generatedBuffer) return; const blob = floatToWav(generatedBuffer.buffer, generatedBuffer.sampleRate, generatedBuffer.meta);
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='sstv_emulator.wav'; a.click();
});

// decode uploaded audio
document.getElementById('audioFile').addEventListener('change', (e)=>{ window._lastAudioFile = e.target.files[0]; });

document.getElementById('decodeBtn').addEventListener('click', async ()=>{
  const f = window._lastAudioFile; if(!f) { alert('Select an audio file first'); return; }
  const duration = parseInt(document.getElementById('decodeDuration').value) || 10;
  const out = await decodeAudioBlob(f,320,256, {
    durationSeconds: duration,
    estimatedToneMs: Math.max(1, (duration*1000*0.98) / (320*256))
  });
  drawDecodedImage(out);
});

// Microphone listen
let micStream=null, micSource=null, analyser=null, micProcessor=null;

document.getElementById('micListenBtn').addEventListener('click', async ()=>{
  ensureAudioCtx();
  if(micStream) return;
  try{
    micStream = await navigator.mediaDevices.getUserMedia({audio:true});
  }catch(err){ alert('Microphone access denied or unavailable'); return; }
  micSource = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser(); analyser.fftSize=2048;
  micSource.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  document.getElementById('stopMicBtn').disabled=false;
  document.getElementById('micListenBtn').disabled=true;
  // simple live visualization
  function draw(){
    analyser.getFloatTimeDomainData(data);
    const viz = document.getElementById('viz'); const vctx = viz.getContext('2d');
    vctx.fillStyle='#fff'; vctx.fillRect(0,0,viz.width,viz.height);
    vctx.strokeStyle='#007'; vctx.beginPath();
    for(let i=0;i<data.length;i++){
      const x = (i/data.length)*viz.width; const y = (0.5+data[i]*0.5)*viz.height;
      if(i===0) vctx.moveTo(x,y); else vctx.lineTo(x,y);
    }
    vctx.stroke();
    micProcessor = requestAnimationFrame(draw);
  }
  draw();
});

document.getElementById('stopMicBtn').addEventListener('click', ()=>{
  if(micStream){
    micStream.getTracks().forEach(t=>t.stop()); micStream=null;
  }
  if(micProcessor) cancelAnimationFrame(micProcessor);
  micProcessor=null; document.getElementById('stopMicBtn').disabled=true; document.getElementById('micListenBtn').disabled=false;
});

// Volume control
const volumeControl = document.getElementById('volumeControl');
if(volumeControl){
  volumeControl.addEventListener('input', (e)=>{
    ensureAudioCtx();
    const v = parseFloat(e.target.value);
    if(masterGain) masterGain.gain.setValueAtTime(v, audioCtx.currentTime);
  });
}

// Live decode UI wiring
const liveToggle = document.getElementById('liveDecodeToggle');
const startLiveBtn = document.getElementById('startLiveDecodeBtn');
const stopLiveBtn = document.getElementById('stopLiveDecodeBtn');
if(liveToggle){
  liveToggle.addEventListener('change', ()=>{
    if(liveToggle.checked){ startLiveBtn.disabled=false; } else { startLiveBtn.disabled=true; stopLiveBtn.disabled=true; stopLiveDecoding(); }
  });
}
if(startLiveBtn){ startLiveBtn.addEventListener('click', ()=>{ if(!liveDecodeAnalyser){ liveDecodeAnalyser = audioCtx.createAnalyser(); liveDecodeAnalyser.fftSize=2048; masterGain.connect(liveDecodeAnalyser); } startLiveDecoding(liveDecodeAnalyser,320,256); startLiveBtn.disabled=true; stopLiveBtn.disabled=false; }); }
if(stopLiveBtn){ stopLiveBtn.addEventListener('click', ()=>{ stopLiveDecoding(); startLiveBtn.disabled=false; stopLiveBtn.disabled=true; }); }

// small note: this is an educational emulator. Real SSTV uses precise timing, sync pulses, multi-tone encoding per line and color channels.
