import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, validateConfig } from './config.mjs';

const SECRET_KEY=/^(private[-_]?key|secret|secret[-_]?key|password|passphrase|api[-_]?key|authorization|OK[-_]ACCESS[-_](SIGN|KEY|PASSPHRASE))$/i;
const redactNamed=(value)=>value.replace(/\b(private[_ -]?key|secret[_ -]?key|passphrase|password|api[_ -]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1=[REDACTED]');
function scrub(value) {
  if(Array.isArray(value)) return value.map(scrub);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([k])=>!SECRET_KEY.test(k)).map(([k,v])=>[k,scrub(v)]));
  if(typeof value==='bigint')return value.toString();
  if(typeof value==='string')return redactNamed(value);
  return value;
}
const json = (value)=>JSON.stringify(scrub(value));
function pageArgs(page=1,pageSize=20) { return {page:Math.max(1,Number.isFinite(Number(page))?Math.floor(Number(page)):1),pageSize:Math.min(100,Math.max(1,Number.isFinite(Number(pageSize))?Math.floor(Number(pageSize)):20))}; }
const reviewError=message=>Object.assign(new Error(message),{safe:true});
function reviewMode(mode){if(!['demo','live'].includes(mode))throw reviewError('复盘模式无效');return mode;}
function reviewDay(day){if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(`${day}T00:00:00Z`))||new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day)throw reviewError('复盘日期无效，请使用 YYYY-MM-DD');return day;}
export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir,{recursive:true,mode:0o700}); chmodSync(dataDir,0o700);
    this.db=new DatabaseSync(path.join(dataDir,'archive.sqlite'));
    chmodSync(path.join(dataDir,'archive.sqlite'),0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,trade_id TEXT NOT NULL,created_at TEXT NOT NULL,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations(trade_id TEXT PRIMARY KEY,amount_usd REAL NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_reviews(id TEXT PRIMARY KEY,day TEXT NOT NULL,mode TEXT NOT NULL,generated_at TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(day,mode));
      CREATE INDEX IF NOT EXISTS events_trade ON events(trade_id,seq);
      CREATE INDEX IF NOT EXISTS trades_time ON trades(created_at DESC);
      CREATE INDEX IF NOT EXISTS reviews_mode_day ON daily_reviews(mode,day DESC);`);
    if(!this.getMeta('config')) this.setConfig(DEFAULT_CONFIG);
  }
  close() {this.db.close();}
  get config(){return this.getMeta('config');}
  getConfig(){return this.config;}
  setConfig(config){const out=validateConfig(config);this.setMeta('config',out);return out;}
  getMeta(key){const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);return row?JSON.parse(row.value):null;}
  setMeta(key,value){this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,json(value));return value;}
  saveTrade(trade){
    if(!trade?.id)throw new Error('交易缺少编号');
    const prior=this.getTrade(trade.id); const now=new Date().toISOString();
    const out={...prior,...scrub(trade),createdAt:trade.createdAt||prior?.createdAt||now,updatedAt:now};
    delete out.events;
    this.db.prepare('INSERT INTO trades(id,created_at,updated_at,document) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,document=excluded.document').run(out.id,out.createdAt,now,json(out));
    return this.getTrade(out.id);
  }
  updateTrade(id,patch){const prior=this.getTrade(id);if(!prior)throw new Error('交易不存在');return this.saveTrade({...prior,...patch,id});}
  getTrade(id){const row=this.db.prepare('SELECT document FROM trades WHERE id=?').get(id);if(!row)return null;const result=JSON.parse(row.document);result.events=this.db.prepare('SELECT seq,created_at,document FROM events WHERE trade_id=? ORDER BY seq').all(id).map((e)=>({...JSON.parse(e.document),seq:e.seq,createdAt:e.created_at}));return result;}
  appendEvent(id,event){
    const now=new Date().toISOString();const ev=typeof event==='string'?{state:event}:scrub(event);
    this.db.exec('BEGIN IMMEDIATE');
    try{this.db.prepare('INSERT INTO events(trade_id,created_at,document) VALUES(?,?,?)').run(id,now,json(ev)); const row=this.db.prepare('SELECT document FROM trades WHERE id=?').get(id); if(row){const t=JSON.parse(row.document);if(ev.state)t.state=ev.state;if(ev.status)t.status=ev.status;t.updatedAt=now;this.db.prepare('UPDATE trades SET document=?,updated_at=? WHERE id=?').run(json(t),now,id);}this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    return ev;
  }
  listTrades(page=1,pageSize=20){const p=pageArgs(page,pageSize);const total=this.db.prepare('SELECT COUNT(*) AS n FROM trades').get().n;const items=this.db.prepare('SELECT document FROM trades ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?').all(p.pageSize,(p.page-1)*p.pageSize).map((r)=>JSON.parse(r.document));return {...p,total,totalPages:Math.max(1,Math.ceil(total/p.pageSize)),items};}
  allTrades(){return this.db.prepare('SELECT document FROM trades ORDER BY created_at DESC').all().map((r)=>this.getTrade(JSON.parse(r.document).id));}
  reserveExecution(tradeId,amountUsd){if(!Number.isFinite(amountUsd)||amountUsd<1||amountUsd>10)throw new Error('套利金额必须为1–10U');this.db.prepare('INSERT OR IGNORE INTO reservations(trade_id,amount_usd,created_at) VALUES(?,?,?)').run(tradeId,amountUsd,new Date().toISOString());return this.stats();}
  stats(mode=this.config?.mode||'demo'){const trades=this.db.prepare('SELECT document FROM trades').all().map((r)=>JSON.parse(r.document)).filter((t)=>(t.mode||'demo')===mode);const ids=new Set(trades.map((t)=>t.id));const reservations=this.db.prepare('SELECT trade_id,amount_usd FROM reservations').all().filter((r)=>ids.has(r.trade_id));const volumeUsd=reservations.reduce((sum,r)=>sum+r.amount_usd,0);let profitUsd=0,completed=0;for(const t of trades){if(['completed','COMPLETED'].includes(t.status||t.state)){completed++;const p=t.actualProfitUsd??t.actual?.profitUsd??t.reconciliation?.actualProfitUsd??t.result?.actualProfitUsd;if(Number.isFinite(p))profitUsd+=p;}}return {mode,executions:reservations.length,count:reservations.length,volumeUsd,cumulativeUsd:volumeUsd,completed,profitUsd};}
  saveQuote(quote){const out={...scrub(quote),id:quote.id||randomUUID(),createdAt:quote.createdAt||new Date().toISOString()};this.db.prepare('INSERT INTO quotes(id,created_at,document) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(out.id,out.createdAt,json(out));return out;}
  getQuote(id){const row=this.db.prepare('SELECT document FROM quotes WHERE id=?').get(id);return row?JSON.parse(row.document):null;}
  addNote(text){if(typeof text!=='string'||!text.trim()||text.length>20000)throw new Error('备忘录内容须为1–20000字');const note={id:randomUUID(),createdAt:new Date().toISOString(),text:text.trim()};this.db.prepare('INSERT INTO notes(id,created_at,text) VALUES(?,?,?)').run(note.id,note.createdAt,note.text);return note;}
  listNotes(page=1,pageSize=10){const p=pageArgs(page,pageSize);const total=this.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n;const items=this.db.prepare('SELECT id,created_at AS createdAt,text FROM notes ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?').all(p.pageSize,(p.page-1)*p.pageSize);return {...p,total,totalPages:Math.max(1,Math.ceil(total/p.pageSize)),items};}
  deleteNote(id){return this.db.prepare('DELETE FROM notes WHERE id=?').run(id).changes>0;}
  saveReview(report){
    if(!report||typeof report!=='object'||Array.isArray(report))throw reviewError('复盘报告格式无效');
    const day=reviewDay(report.day),mode=reviewMode(report.mode),prior=this.getReview(day,mode);
    const generatedAt=report.generatedAt||new Date().toISOString();
    if(typeof generatedAt!=='string'||!Number.isFinite(Date.parse(generatedAt)))throw reviewError('复盘生成时间无效');
    const id=prior?.id||report.id||`${mode}:${day}`;
    if(typeof id!=='string'||!id||id.length>200)throw reviewError('复盘报告编号无效');
    const out={...scrub(report),id,day,mode,generatedAt};
    this.db.prepare('INSERT INTO daily_reviews(id,day,mode,generated_at,document) VALUES(?,?,?,?,?) ON CONFLICT(day,mode) DO UPDATE SET generated_at=excluded.generated_at,document=excluded.document').run(id,day,mode,generatedAt,json(out));
    return this.getReview(day,mode);
  }
  getReview(day,mode=this.config?.mode||'demo'){
    reviewDay(day);reviewMode(mode);
    const row=this.db.prepare('SELECT document FROM daily_reviews WHERE day=? AND mode=?').get(day,mode);
    return row?JSON.parse(row.document):null;
  }
  listReviews(page=1,pageSize=10,mode=this.config?.mode||'demo'){
    reviewMode(mode);const p=pageArgs(page,pageSize);
    const total=this.db.prepare('SELECT COUNT(*) AS n FROM daily_reviews WHERE mode=?').get(mode).n;
    const items=this.db.prepare('SELECT document FROM daily_reviews WHERE mode=? ORDER BY day DESC,generated_at DESC LIMIT ? OFFSET ?').all(mode,p.pageSize,(p.page-1)*p.pageSize).map(row=>JSON.parse(row.document));
    return {...p,total,totalPages:Math.max(1,Math.ceil(total/p.pageSize)),items};
  }
}
