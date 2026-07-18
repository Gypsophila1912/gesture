// Constants
const MEDIAPIPE_VERSION = '0.10.35';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const HOLD_FRAMES_REQUIRED = 9; // ~0.3s at 30fps

// Hiragana Lookup Table (行=row, 段=col)
const HIRAGANA_TABLE = {
  1:  {1:'あ', 2:'い', 3:'う', 4:'え', 5:'お'},
  2:  {1:'か', 2:'き', 3:'く', 4:'け', 5:'こ'},
  3:  {1:'さ', 2:'し', 3:'す', 4:'せ', 5:'そ'},
  4:  {1:'た', 2:'ち', 3:'つ', 4:'て', 5:'と'},
  5:  {1:'な', 2:'に', 3:'ぬ', 4:'ね', 5:'の'},
  6:  {1:'は', 2:'ひ', 3:'ふ', 4:'へ', 5:'ほ'},
  7:  {1:'ま', 2:'み', 3:'む', 4:'め', 5:'も'},
  8:  {1:'や', 3:'ゆ', 5:'よ'},
  9:  {1:'ら', 2:'り', 3:'る', 4:'れ', 5:'ろ'},
  10: {1:'わ', 3:'を', 5:'ん'},
};

const DAKUTEN_MAP = {
  'か':'が','き':'ぎ','く':'ぐ','け':'げ','こ':'ご',
  'さ':'ざ','し':'じ','す':'ず','せ':'ぜ','そ':'ぞ',
  'た':'だ','ち':'ぢ','つ':'づ','て':'で','と':'ど',
  'は':'ば','ひ':'び','ふ':'ぶ','へ':'べ','ほ':'ぼ',
  'う':'ゔ'
};

const HANDAKUTEN_MAP = {
  'は':'ぱ','ひ':'ぴ','ふ':'ぷ','へ':'ぺ','ほ':'ぽ'
};

const ROW_LABELS = ['','あ行','か行','さ行','た行','な行','は行','ま行','や行','ら行','わ行'];

// State Machine
let currentState = 'ROW'; // 'ROW' or 'COL'
let currentRow = null;
let currentText = '';

let ws = null;

// UI Elements
const video = document.getElementById('video');
const canvas = document.getElementById('output-canvas');
const ctx = canvas.getContext('2d');
const loadingOverlay = document.getElementById('loading-overlay');
const flashOverlay = document.getElementById('flash-overlay');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
const stateLabel = document.getElementById('state-label');
const fingerCountEl = document.getElementById('finger-count');
const holdCircle = document.getElementById('hold-circle');
const inputDisplay = document.getElementById('input-display');

// Hold & Motion State
let currentGesture = null; 
let holdFrames = 0;
let gestureConfirmed = false;
let cooldownFrames = 0;

let previousTotals = []; // For smoothing

// Initialize WebSocket
function initWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    connDot.classList.remove('disconnected');
    connDot.classList.add('connected');
    connText.textContent = '接続済み';
  };

  ws.onclose = () => {
    connDot.classList.remove('connected');
    connDot.classList.add('disconnected');
    connText.textContent = '未接続';
    setTimeout(initWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket Error:', err);
  };
}

// Visual Effects
function triggerFlash(type) {
  flashOverlay.className = `flash-overlay flash-${type}`;
  // Force reflow
  void flashOverlay.offsetWidth;
  setTimeout(() => {
    flashOverlay.className = 'flash-overlay';
  }, 500);
}

function updateHoldGauge(percentage) {
  // stroke-dasharray is 213.6 for r=34
  const offset = 213.6 - (213.6 * Math.min(100, Math.max(0, percentage)) / 100);
  holdCircle.style.strokeDashoffset = offset;
}

function updateStateLabel() {
  if (currentState === 'ROW') {
    stateLabel.textContent = '行入力待ち';
  } else if (currentState === 'COL') {
    stateLabel.textContent = `${ROW_LABELS[currentRow]} - 段入力待ち`;
  }
}

function updateInputDisplay(pendingText = '') {
  inputDisplay.textContent = currentText + pendingText;
}

// Finger Counting Logic
// NOTE: MediaPipe reports handedness from the CAMERA's perspective.
//   Camera "Right" = user's LEFT hand
//   Camera "Left"  = user's RIGHT hand
function countFingersForHand(landmarks, handedness) {
  let count = 0;
  // handedness is from camera's POV, so "Right" means user's LEFT hand
  const isCameraRight = handedness === 'Right';

  // Thumb detection: compare x-coordinates
  const thumbDiff = landmarks[4].x - landmarks[3].x;
  const THUMB_THRESHOLD = 0.02; 
  let thumbUp = false;
  if (isCameraRight) {
    if (thumbDiff > THUMB_THRESHOLD) { count++; thumbUp = true; }
  } else {
    if (thumbDiff < -THUMB_THRESHOLD) { count++; thumbUp = true; }
  }

  // Other fingers: tip above PIP joint (y decreases upward)
  const FINGER_THRESHOLD = 0.02;
  let indexUp = false, middleUp = false, ringUp = false, pinkyUp = false;

  if (landmarks[6].y - landmarks[8].y > FINGER_THRESHOLD) { count++; indexUp = true; }
  if (landmarks[10].y - landmarks[12].y > FINGER_THRESHOLD) { count++; middleUp = true; }
  if (landmarks[14].y - landmarks[16].y > FINGER_THRESHOLD) { count++; ringUp = true; }
  if (landmarks[18].y - landmarks[20].y > FINGER_THRESHOLD) { count++; pinkyUp = true; }

  // Check for Aloha pose: Thumb and Pinky are UP, Index, Middle, and Ring are DOWN
  const isAloha = (thumbUp && pinkyUp && !indexUp && !middleUp && !ringUp);

  return { count, isAloha };
}

function getTotalFingerCount(results) {
  if (!results.landmarks || results.landmarks.length === 0) return { total: -1, handsDetected: 0, alohaCount: 0 };
  let total = 0;
  let alohaCount = 0;
  for (let i = 0; i < results.landmarks.length; i++) {
    const hand = results.landmarks[i];
    const handedness = results.handedness[i][0].categoryName;
    const res = countFingersForHand(hand, handedness);
    total += res.count;
    if (res.isAloha) alohaCount++;
  }
  return { total, handsDetected: results.landmarks.length, alohaCount };
}

function processAction(actionType, value) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(value ? { type: actionType, value } : { type: actionType }));
  }

  if (actionType === 'row') {
    currentRow = value;
    currentState = 'COL';
    updateStateLabel();
    updateInputDisplay(`(${ROW_LABELS[currentRow]}...)`);
    triggerFlash('success');
  } else if (actionType === 'col') {
    if (HIRAGANA_TABLE[currentRow] && HIRAGANA_TABLE[currentRow][value]) {
      const char = HIRAGANA_TABLE[currentRow][value];
      currentText += char;
      currentState = 'ROW';
      currentRow = null;
      updateStateLabel();
      updateInputDisplay();
      triggerFlash('success');
    } else {
      currentState = 'ROW';
      currentRow = null;
      updateStateLabel();
      updateInputDisplay();
      triggerFlash('error');
    }
  } else if (actionType === 'dakuten') {
    if (currentText.length > 0) {
      const lastChar = currentText.slice(-1);
      if (DAKUTEN_MAP[lastChar]) {
        currentText = currentText.slice(0, -1) + DAKUTEN_MAP[lastChar];
        updateInputDisplay(currentState === 'COL' ? `(${ROW_LABELS[currentRow]}...)` : '');
        triggerFlash('success');
      }
    }
  } else if (actionType === 'handakuten') {
    if (currentText.length > 0) {
      const lastChar = currentText.slice(-1);
      if (HANDAKUTEN_MAP[lastChar]) {
        currentText = currentText.slice(0, -1) + HANDAKUTEN_MAP[lastChar];
        updateInputDisplay(currentState === 'COL' ? `(${ROW_LABELS[currentRow]}...)` : '');
        triggerFlash('success');
      }
    }
  } else if (actionType === 'delete_one') {
    if (currentText.length > 0) {
      currentText = currentText.slice(0, -1);
      updateInputDisplay(currentState === 'COL' ? `(${ROW_LABELS[currentRow]}...)` : '');
      triggerFlash('delete');
    } else if (currentState === 'COL') {
      currentState = 'ROW';
      currentRow = null;
      updateStateLabel();
      updateInputDisplay();
      triggerFlash('delete');
    }
  } else if (actionType === 'delete_all') {
    currentText = '';
    currentState = 'ROW';
    currentRow = null;
    updateStateLabel();
    updateInputDisplay();
    triggerFlash('delete');
  }
}

function processGestures(results) {
  if (cooldownFrames > 0) {
    cooldownFrames--;
    return;
  }

  const { total, handsDetected, alohaCount } = getTotalFingerCount(results);

  if (handsDetected === 0) {
    currentGesture = null;
    holdFrames = 0;
    gestureConfirmed = false;
    updateHoldGauge(0);
    fingerCountEl.textContent = '-';
    previousTotals = [];
    return;
  }

  let detectedGesture = null;

  if (alohaCount > 0) {
    // Aloha gesture takes precedence
    detectedGesture = alohaCount === 1 ? 'delete_one' : 'delete_all';
    fingerCountEl.textContent = detectedGesture === 'delete_one' ? '削除' : '全削除';
    previousTotals = [];
  } else {
    // Hold Detection for Finger Count
    if (total === 0 && handsDetected === 1) {
      detectedGesture = 'dakuten';
      fingerCountEl.textContent = '濁点';
    } else if (total === 0 && handsDetected === 2) {
      detectedGesture = 'handakuten';
      fingerCountEl.textContent = '半濁点';
    } else if (total > 0) {
      // Smoothing logic: collect last 5 frames of total, take the mode (most common value)
      previousTotals.push(total);
      if (previousTotals.length > 5) previousTotals.shift();
      
      const counts = {};
      let maxCount = 0;
      let modeTotal = total;
      for (const t of previousTotals) {
        counts[t] = (counts[t] || 0) + 1;
        if (counts[t] > maxCount) {
          maxCount = counts[t];
          modeTotal = t;
        }
      }

      if (currentState === 'COL' && modeTotal > 5) {
        detectedGesture = null;
        fingerCountEl.textContent = modeTotal;
      } else {
        detectedGesture = modeTotal;
        fingerCountEl.textContent = modeTotal;
      }
    } else {
      fingerCountEl.textContent = '0';
      previousTotals = [];
    }
  }

  if (detectedGesture !== null) {
    if (currentGesture === detectedGesture) {
      if (!gestureConfirmed) {
        holdFrames++;
        updateHoldGauge((holdFrames / HOLD_FRAMES_REQUIRED) * 100);
        
        if (holdFrames >= HOLD_FRAMES_REQUIRED) {
          gestureConfirmed = true;
          
          if (detectedGesture === 'dakuten' || detectedGesture === 'handakuten' || detectedGesture === 'delete_one' || detectedGesture === 'delete_all') {
            processAction(detectedGesture);
          } else {
            if (currentState === 'ROW') {
              processAction('row', detectedGesture);
              // Reset so that the same gesture can immediately be used for the column without hiding hand
              gestureConfirmed = false;
              holdFrames = 0;
            } else if (currentState === 'COL') {
              processAction('col', detectedGesture);
            }
          }
          cooldownFrames = 5; // small cooldown after confirm
        }
      } else {
        updateHoldGauge(100); // keep full
      }
    } else {
      currentGesture = detectedGesture;
      holdFrames = 1;
      gestureConfirmed = false;
      updateHoldGauge((1 / HOLD_FRAMES_REQUIRED) * 100);
    }
  } else {
    currentGesture = null;
    holdFrames = 0;
    gestureConfirmed = false;
    updateHoldGauge(0);
  }
}

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
];

function drawLandmarks(results) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (results.landmarks) {
    for (const landmarks of results.landmarks) {
      // Draw lines
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.5)';
      ctx.lineWidth = 2;
      for (const [startIdx, endIdx] of CONNECTIONS) {
        const start = landmarks[startIdx];
        const end = landmarks[endIdx];
        ctx.beginPath();
        ctx.moveTo(start.x * canvas.width, start.y * canvas.height);
        ctx.lineTo(end.x * canvas.width, end.y * canvas.height);
        ctx.stroke();
      }
      
      // Draw points
      ctx.fillStyle = 'rgba(0, 212, 255, 0.8)';
      for (const landmark of landmarks) {
        ctx.beginPath();
        ctx.arc(landmark.x * canvas.width, landmark.y * canvas.height, 4, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }
}

async function startMediaPipe() {
  try {
    const vision = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`);
    const { HandLandmarker, FilesetResolver } = vision;

    const visionInfo = await FilesetResolver.forVisionTasks(WASM_URL);
    const handLandmarker = await HandLandmarker.createFromOptions(visionInfo, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 2
    });

    loadingOverlay.style.display = 'none';

    // Start Camera
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    video.srcObject = stream;
    
    video.addEventListener('loadeddata', () => {
      canvas.width = video.clientWidth;
      canvas.height = video.clientHeight;
      
      // Handle resizing
      window.addEventListener('resize', () => {
        canvas.width = video.clientWidth;
        canvas.height = video.clientHeight;
      });

      let lastVideoTime = -1;
      function renderLoop() {
        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          const results = handLandmarker.detectForVideo(video, performance.now());
          processGestures(results);
          drawLandmarks(results);
        }
        requestAnimationFrame(renderLoop);
      }
      requestAnimationFrame(renderLoop);
    });
  } catch (err) {
    console.error('MediaPipe/Camera Initialization Error:', err);
    loadingOverlay.textContent = 'エラーが発生しました。カメラの許可を確認してください。';
  }
}

// Init
initWebSocket();
startMediaPipe();
