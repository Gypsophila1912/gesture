// ============================================
// ジェスチャー入力 — モバイル受信 & 表示ロジック
// ============================================

// ── ひらがな変換テーブル ──
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
  10: {1:'わ', 5:'ん'},
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

const ROW_LABELS = ['','あ','か','さ','た','な','は','ま','や','ら','わ'];

// ── 状態 ──
let confirmedChars = [];  // 確定済みのひらがな配列
let pendingRow = null;    // 未確定の行番号

// ── DOM要素 ──
const displayText = document.getElementById('display-text');
const connectionDot = document.getElementById('connection-dot');
const connectionText = document.getElementById('connection-text');
const flashOverlay = document.getElementById('flash-overlay');

// ── WebSocket接続 ──
let ws = null;
let reconnectTimer = null;

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    connectionDot.className = 'connection-dot connected';
    connectionText.textContent = '接続中';
    console.log('[WS] Connected');
  };

  ws.onclose = () => {
    connectionDot.className = 'connection-dot disconnected';
    connectionText.textContent = '再接続中...';
    console.log('[WS] Disconnected, reconnecting in 3s...');
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleEvent(data);
    } catch (e) {
      console.error('[WS] Failed to parse message:', event.data, e);
    }
  };
}

// ── イベントハンドラ ──
function handleEvent(event) {
  switch (event.type) {
    case 'row':
      // 行が選択された → 仮表示
      pendingRow = event.value;
      renderDisplay();
      break;

    case 'col': {
      // 段が選択された → ひらがな確定
      const row = pendingRow;
      const col = event.value;
      pendingRow = null;

      if (row && HIRAGANA_TABLE[row] && HIRAGANA_TABLE[row][col]) {
        const char = HIRAGANA_TABLE[row][col];
        confirmedChars.push(char);
        showFlash('success');
      } else {
        // 無効な組み合わせ（例: や行2段）
        showFlash('error');
      }
      renderDisplay();
      break;
    }

    case 'dakuten': {
      // 直前の確定文字に濁点
      if (confirmedChars.length > 0) {
        const lastChar = confirmedChars[confirmedChars.length - 1];
        if (DAKUTEN_MAP[lastChar]) {
          confirmedChars[confirmedChars.length - 1] = DAKUTEN_MAP[lastChar];
          showFlash('success');
        } else {
          showFlash('error');
        }
      }
      renderDisplay();
      break;
    }

    case 'handakuten': {
      // 直前の確定文字に半濁点
      if (confirmedChars.length > 0) {
        const lastChar = confirmedChars[confirmedChars.length - 1];
        if (HANDAKUTEN_MAP[lastChar]) {
          confirmedChars[confirmedChars.length - 1] = HANDAKUTEN_MAP[lastChar];
          showFlash('success');
        } else {
          showFlash('error');
        }
      }
      renderDisplay();
      break;
    }

    case 'delete_one':
      // 最後の1文字削除
      if (confirmedChars.length > 0) {
        confirmedChars.pop();
        showFlash('delete');
      }
      pendingRow = null;
      renderDisplay();
      break;

    case 'delete_all':
      // 全削除
      confirmedChars = [];
      pendingRow = null;
      showFlash('delete');
      renderDisplay();
      break;

    default:
      console.warn('[Event] Unknown event type:', event.type);
  }
}

// ── 表示更新 ──
function renderDisplay() {
  let html = '';

  // 確定済み文字
  for (let i = 0; i < confirmedChars.length; i++) {
    html += `<span class="char" style="animation-delay: ${i * 0.02}s">${confirmedChars[i]}</span>`;
  }

  // 未確定の行（仮表示）
  if (pendingRow !== null) {
    const label = ROW_LABELS[pendingRow] || '?';
    html += `<span class="char-pending">${label}_</span>`;
  }

  displayText.innerHTML = html;
}

// ── フラッシュエフェクト ──
let flashTimeout = null;

function showFlash(type) {
  // type: 'success' | 'error' | 'delete'
  if (flashTimeout) {
    clearTimeout(flashTimeout);
  }

  flashOverlay.className = 'flash-overlay';
  // Force reflow to restart animation
  void flashOverlay.offsetWidth;

  flashOverlay.classList.add(`flash-${type}`);

  flashTimeout = setTimeout(() => {
    flashOverlay.className = 'flash-overlay';
    flashTimeout = null;
  }, 700);
}

// ── 初期化 ──
function init() {
  renderDisplay();
  connectWebSocket();

  // 画面をスリープさせない (Wake Lock API)
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').catch(() => {});
  }
}

init();
