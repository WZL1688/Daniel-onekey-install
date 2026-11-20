// Local observation reminders. Never loads voices or sends token text to a remote service.
const STORAGE = 'chainpair.radar.spoken.v1';
const WEEK = 7 * 86400000;
const keyFor = token => `${token.chain}:${token.address}`;
function readSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE) || '{}');
    return Object.fromEntries(Object.entries(raw).filter(([key, at]) => /^(bnb|solana):[A-Za-z0-9]{20,70}$/.test(key) && Number.isFinite(at) && at > Date.now() - WEEK).slice(-1000));
  } catch { return {}; }
}
function saveSeen(seen) { try { localStorage.setItem(STORAGE, JSON.stringify(seen)); return true; } catch { return false; } }
function storageAvailable() {
  try { const key = `${STORAGE}.probe`; localStorage.setItem(key, '1'); localStorage.removeItem(key); return true; } catch { return false; }
}
export function createRadarVoice({ onStart = () => {}, onChange = () => {} } = {}) {
  let enabled = false, language = 'zh', baseline = null, generation = 0, speech = null, lastSpoken = 0, storageReady = storageAvailable();
  const synth = globalThis.speechSynthesis;
  const voices = () => synth?.getVoices().filter(voice => voice.localService === true && (language === 'zh' ? /^zh(?:-|_)/i : /^en(?:-|_)/i).test(voice.lang)) || [];
  function status() {
    const supported = Boolean(synth && globalThis.SpeechSynthesisUtterance && navigator.locks?.request && storageReady);
    const available = supported && voices().length > 0;
    return { enabled: enabled && available, language, available, reason: !storageReady ? '本地存储不可用，无法保存跨页面去重；语音已关闭。' : !supported ? '当前浏览器不支持本地语音与跨页面去重，可继续使用画面提醒。' : !available ? '设备没有可用的本地中文／英文声音，请先在系统安装语音包。' : enabled ? '本地语音已开启；首次加载静默，只提醒之后的新观察线索。' : '语音默认关闭，仅使用设备本地声音。' };
  }
  function reset() { generation++; baseline = null; if (speech) synth?.cancel(); speech = null; }
  function configure({ enable = enabled, lang = language } = {}) {
    language = lang === 'en' ? 'en' : 'zh';
    enabled = Boolean(enable);
    reset();
    if (!status().available) enabled = false;
    onChange(status());
    return status();
  }
  async function observe(tokens) {
    const candidates = tokens.filter(token => token.decision?.status === 'candidate' && token.risk?.status !== 'flagged' && Number.isFinite(token.observedAt) && Date.now() - token.observedAt < 10 * 60000 && Date.now() >= token.observedAt - 10000);
    const current = new Set(candidates.map(keyFor));
    if (!baseline) { baseline = current; return; }
    const newlySeen = candidates.filter(token => !baseline.has(keyFor(token)));
    for (const key of current) baseline.add(key);
    if (!status().enabled || !newlySeen.length || Date.now() - lastSpoken < 60000) return;
    const token = newlySeen[0], ticket = generation;
    // A lock is held through speech completion, coordinating all tabs on this origin.
    await navigator.locks.request('chainpair-radar-voice', { ifAvailable: true }, async lock => {
      if (!lock || ticket !== generation || !status().enabled) return;
      const seen = readSeen(), key = keyFor(token);
      if (seen[key]) return;
      const selected = voices()[0];
      if (!selected) { onChange(status()); return; }
      await new Promise(resolve => {
        let complete = false;
        const utterance = new SpeechSynthesisUtterance(language === 'zh' ? '发现新的市场观察线索，尚未安全核验，请查看。' : 'New market observation. Safety is unverified. Please review.');
        speech = utterance; utterance.voice = selected; utterance.lang = selected.lang; utterance.rate = 1;
        const finish = () => { if (complete) return; complete = true; clearTimeout(timeout); if (speech === utterance) speech = null; resolve(); };
        utterance.onstart = () => {
          if (complete) return;
          if (ticket !== generation || !enabled) { synth.cancel(); finish(); return; }
          const latest = readSeen(); latest[key] = Date.now();
          if (!saveSeen(latest)) { storageReady = false; enabled = false; synth.cancel(); finish(); onChange(status()); return; }
          lastSpoken = Date.now(); onStart(token.id);
        };
        utterance.onend = finish; utterance.onerror = finish;
        const timeout = setTimeout(() => { synth.cancel(); finish(); }, 20000);
        synth.speak(utterance);
      });
    });
  }
  const changed = () => { if (!status().available && enabled) { enabled = false; reset(); } onChange(status()); };
  synth?.addEventListener?.('voiceschanged', changed);
  return { status, configure, observe, reset, stop() { enabled = false; reset(); onChange(status()); } };
}
