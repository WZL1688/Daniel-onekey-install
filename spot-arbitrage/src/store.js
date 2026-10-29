import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const defaults = () => ({
  version: 1,
  config: { exchanges: ['binance', 'okx'], pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'], amount: '100', fallbackAmounts: ['50', '20'],
    fees: { binance: '0.001', okx: '0.001' }, feeConfirmed: false, buffer: '0.05', minProfit: '0.2', minDepthProfit: '0.2',
    maxBookAgeMs: 5000, maxBalanceAgeMs: 15000, slotMs: 3000, balanceRefreshMs: 60000,
    budgets: { binance: 600, okx: 120 }, autoTrading: false, unknownAction: 'pause', scannerAuto: false, scanQuote: 'USDT',
    balance: {} },
  keys: [], accounts: {}, balances: {}, books: {}, rules: {}, exchangeMeta: {}, opportunities: {}, scanResults: {},
  batches: [], blocks: {}, cooldowns: {}, rates: {}, errors: [], events: [],
  engine: { cursor: 0, lastPollAt: 0, lastCycleAt: 0, cycleMs: null, polls: 0, lastBalanceAt: 0, scanCursor: 0 },
});
export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700); this.file = path.join(this.dir, 'state.json');
    this.lockFile = path.join(this.dir, 'process.lock');
    try { this.lockFd = fs.openSync(this.lockFile, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(this.lockFile, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw Error('数据目录锁损坏，拒绝启动');
      try { process.kill(pid, 0); throw Error('数据目录已被另一进程使用'); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
      fs.unlinkSync(this.lockFile); this.lockFd = fs.openSync(this.lockFile, 'wx', 0o600);
    }
    fs.writeFileSync(this.lockFd, String(process.pid)); fs.fsyncSync(this.lockFd);
    try {
      this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : defaults();
      if (this.state.version !== 1 || !Array.isArray(this.state.batches) || !this.state.config || !this.state.rates) throw Error('不支持或损坏的数据文件');
      this.state.config.autoTrading = false;
      for (const batch of this.state.batches) {
        for (const leg of batch.legs || []) if (leg.status === 'SENDING') { leg.status = 'UNKNOWN'; batch.status = 'UNKNOWN'; }
        for (const leg of batch.legs || []) if (leg.cancelStatus === 'SENDING') leg.cancelStatus = 'UNKNOWN';
        if (!['RESOLVED', 'REJECTED'].includes(batch.status)) this.state.blocks[batch.pair] = `未核对批次 ${batch.id} (${batch.status})`;
      }
      this.save();
    } catch (e) { this.close(); throw e; }
  }
  save() {
    if (this.lockFd == null) throw Error('存储已关闭，拒绝写入');
    const temp = this.file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    const directory = fs.openSync(this.dir, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  event(message, type = 'info') { this.state.events.unshift({ at: Date.now(), type, message }); this.state.events.length = Math.min(300, this.state.events.length); this.save(); }
  error(scope, message) { this.state.errors.unshift({ at: Date.now(), scope, message }); this.state.errors.length = Math.min(200, this.state.errors.length); this.save(); }
  close() { if (this.lockFd != null) { fs.closeSync(this.lockFd); this.lockFd = null; try { fs.unlinkSync(this.lockFile); } catch (e) { if (e.code !== 'ENOENT') throw e; } } }
}
export class Vault {
  constructor(store) {
    this.store = store; const file = path.join(store.dir, 'master.key');
    if (!fs.existsSync(file)) {
      if (store.state.keys.length) throw Error('主加密密钥缺失；拒绝生成新密钥覆盖旧凭据');
      const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, crypto.randomBytes(32)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    this.master = fs.readFileSync(file);
    if (this.master.length !== 32) throw Error('主加密密钥格式错误');
    fs.chmodSync(file, 0o600);
  }
  seal(value, id) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.master, iv);
    cipher.setAAD(Buffer.from(id)); const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }
  open(key) {
    const sealed = key.sealed, decipher = crypto.createDecipheriv('aes-256-gcm', this.master, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(key.id)); decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  }
  add({ exchange, role, label, apiKey, secret, passphrase = '', accountUid = '', sameAccountConfirmed = false }) {
    if (!['binance', 'okx'].includes(exchange) || !['query', 'trade'].includes(role)) throw Error('交易所或 Key 类型无效');
    for (const v of [apiKey, secret]) if (typeof v !== 'string' || v.length < 10 || v.length > 256 || /\s/.test(v)) throw Error('Key 或 Secret 格式无效');
    if (exchange === 'okx' && (typeof passphrase !== 'string' || !passphrase || passphrase.length > 256)) throw Error('OKX 需要 Passphrase');
    if (this.store.state.keys.length >= 100) throw Error('最多配置 100 个 API Key');
    if (role === 'trade' && (typeof accountUid !== 'string' || !/^\d{1,30}$/.test(accountUid) || sameAccountConfirmed !== true)) throw Error('交易 Key 必须声明同一账户 UID 并确认归属；不会通过查询验证交易 Key');
    if (this.store.state.keys.some(k => k.fingerprint === crypto.createHash('sha256').update(exchange + apiKey).digest('hex'))) throw Error('相同 API Key 不能重复配置或兼任查询和交易');
    const id = crypto.randomUUID();
    const key = { id, exchange, role, label: String(label || role).slice(0, 40), hint: '••••' + apiKey.slice(-4),
      fingerprint: crypto.createHash('sha256').update(exchange + apiKey).digest('hex'), enabled: true, accountUid,
      attested: role === 'trade', status: role === 'trade' ? 'CONFIGURED_NOT_QUERIED' : 'UNVERIFIED', requests: 0, failures: 0, lastAt: null,
      sealed: this.seal({ apiKey, secret, passphrase }, id) };
    this.store.state.keys.push(key); this.store.save(); return id;
  }
  publicKeys() { return this.store.state.keys.map(({ sealed, fingerprint, ...k }) => k); }
}
