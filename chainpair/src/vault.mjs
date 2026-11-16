import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { Wallet, getAddress } from 'ethers';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const OPTIONS={N:32768,r:8,p:1,maxmem:64*1024*1024};
const safeError=(msg)=>Object.assign(new Error(msg),{safe:true});
function readJson(file,fallback){if(!existsSync(file))return fallback;try{return JSON.parse(readFileSync(file,'utf8'));}catch{throw safeError('本机钱包文件损坏，请保留原文件并核对备份');}}
function atomic(file,value){const tmp=`${file}.${randomBytes(6).toString('hex')}.tmp`;const fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);chmodSync(file,0o600);}
function parseKey(chain,secret){
  if(typeof secret!=='string'||secret.length>2000)throw safeError('私钥格式无效');
  try{
    if(chain==='bnb'){const wallet=new Wallet(secret.trim().startsWith('0x')?secret.trim():`0x${secret.trim()}`);return {secret:wallet.privateKey,address:wallet.address};}
    let bytes;if(secret.trim().startsWith('[')){const arr=JSON.parse(secret);if(!Array.isArray(arr)||!arr.every((v)=>Number.isInteger(v)&&v>=0&&v<=255))throw Error();bytes=Uint8Array.from(arr);}else bytes=bs58.decode(secret.trim());
    if(bytes.length!==64)throw Error();
    const kp=Keypair.fromSecretKey(bytes);return {secret:bs58.encode(kp.secretKey),address:kp.publicKey.toBase58()};
  }catch{throw safeError(chain==='bnb'?'BNB 私钥格式无效':'Solana 私钥须为64字节 Base58 或 JSON 数组');}
}
function checkChain(chain){if(!['bnb','solana'].includes(chain))throw safeError('链名称无效');}
export class Vault {
  constructor(dataDir){
    mkdirSync(dataDir,{recursive:true,mode:0o700});chmodSync(dataDir,0o700);
    this.file=path.join(dataDir,'vault.json');this.publicFile=path.join(dataDir,'wallets.json');
    this.public=readJson(this.publicFile,{bnb:null,solana:null,okxConfigured:false});
    this.payload=null;this.key=null;this.salt=null;
  }
  publicStatus(){const out={};for(const chain of ['bnb','solana']){const w=this.public[chain];out[chain]=w?{address:w.address,mode:w.mode,unlocked:w.mode==='private'&&!!this.payload,canSign:w.mode==='private'&&!!this.payload,locked:w.mode==='private'&&!this.payload}:{address:null,mode:'none',unlocked:false,canSign:false,locked:false};}out.okxConfigured=!!this.public.okxConfigured;out.locked=existsSync(this.file)&&!this.payload;out.unlocked=!!this.payload;return out;}
  #password(password){if(typeof password!=='string'||password.length<10||password.length>1024)throw safeError('密码长度须为10–1024个字符');}
  #openOrCreate(password){this.#password(password);if(this.payload){if(password){const k=scryptSync(password,this.salt,32,OPTIONS);if(!k.equals(this.key)){k.fill(0);throw safeError('密码不正确');}k.fill(0);}return;}if(existsSync(this.file)){this.unlock(password);return;}this.salt=randomBytes(16);this.key=scryptSync(password,this.salt,32,OPTIONS);this.payload={wallets:{},okx:null};}
  #save(){if(!this.payload||!this.key)throw safeError('请先解锁钱包');const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from('dualarb-vault-v1'));const encrypted=Buffer.concat([cipher.update(JSON.stringify(this.payload),'utf8'),cipher.final()]);atomic(this.file,{version:1,kdf:'scrypt',N:32768,r:8,p:1,salt:this.salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')});atomic(this.publicFile,this.public);}
  unlock(password){
    this.#password(password);if(!existsSync(this.file))throw safeError('尚未创建加密钱包');
    const record=readJson(this.file,null);let key;
    try{if(record.version!==1||record.kdf!=='scrypt')throw Error();const salt=Buffer.from(record.salt,'base64');if(salt.length!==16)throw Error();key=scryptSync(password,salt,32,OPTIONS);const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(record.iv,'base64'));decipher.setAAD(Buffer.from('dualarb-vault-v1'));decipher.setAuthTag(Buffer.from(record.tag,'base64'));const decoded=Buffer.concat([decipher.update(Buffer.from(record.ciphertext,'base64')),decipher.final()]);const payload=JSON.parse(decoded.toString('utf8'));decoded.fill(0);if(!payload.wallets)throw Error();this.lock();this.key=key;this.salt=salt;this.payload=payload;for(const chain of ['bnb','solana'])if(this.public[chain]?.mode!=='private')delete this.payload.wallets[chain];return this.publicStatus();}catch{key?.fill(0);throw safeError('解锁失败：密码不正确或钱包文件损坏');}
  }
  lock(){this.key?.fill(0);this.key=null;this.salt=null;if(this.payload){for(const k of Object.keys(this.payload.wallets||{}))this.payload.wallets[k]='';if(this.payload.okx)for(const k of Object.keys(this.payload.okx))this.payload.okx[k]='';}this.payload=null;return this.publicStatus();}
  importWallet({chain,mode,secret,address,password}={}){
    checkChain(chain);if(!['private','readonly'].includes(mode))throw safeError('钱包模式无效');
    if(mode==='readonly'){let normalized;try{normalized=chain==='bnb'?getAddress(address):new PublicKey(address).toBase58();}catch{throw safeError('只读地址格式无效');}this.public[chain]={mode,address:normalized};if(this.payload){delete this.payload.wallets[chain];this.#save();}else atomic(this.publicFile,this.public);return this.publicStatus();}
    const parsed=parseKey(chain,secret);this.#openOrCreate(password);this.payload.wallets[chain]=parsed.secret;this.public[chain]={mode:'private',address:parsed.address};this.#save();return this.publicStatus();
  }
  getPrivateKey(chain){checkChain(chain);if(!this.payload||this.public[chain]?.mode!=='private'||!this.payload.wallets[chain])throw safeError('钱包未导入私钥或尚未解锁');const secret=this.payload.wallets[chain];if(parseKey(chain,secret).address!==this.public[chain].address)throw safeError('钱包元数据不一致，请重新导入');return secret;}
  signer(chain){const key=this.getPrivateKey(chain);return chain==='bnb'?new Wallet(key):Keypair.fromSecretKey(bs58.decode(key));}
  getSigner(chain){return this.signer(chain);}
  setOkxCredentials({apiKey,secretKey,passphrase,password}={}){
    if(![apiKey,secretKey,passphrase].every((s)=>typeof s==='string'&&s.trim().length>0&&s.length<=2000))throw safeError('OKX 凭证不完整');
    this.#openOrCreate(password);this.payload.okx={apiKey:apiKey.trim(),secretKey:secretKey.trim(),passphrase:passphrase.trim()};this.public.okxConfigured=true;this.#save();return {configured:true};
  }
  redact(value){
    let out=String(value??'');const secrets=[];
    for(const [chain,key] of Object.entries(this.payload?.wallets||{})){
      secrets.push(key);
      if(chain==='bnb')secrets.push(key.replace(/^0x/,''));
      else try{const bytes=Array.from(bs58.decode(key));secrets.push(JSON.stringify(bytes),bytes.join(','));}catch{}
    }
    secrets.push(...Object.values(this.payload?.okx||{}));
    for(const secret of secrets.filter((s)=>typeof s==='string'&&s.length>=6).sort((a,b)=>b.length-a.length)){
      out=out.split(secret).join('[REDACTED]');
      if(/^(0x)?[0-9a-f]{64}$/i.test(secret))out=out.split(secret.toUpperCase()).join('[REDACTED]');
    }
    return out.replace(/\b(private[_ -]?key|secret[_ -]?key|passphrase|password|api[_ -]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1=[REDACTED]');
  }
  getOkxCredentials(){if(!this.payload?.okx)return null;return {...this.payload.okx};}
}
