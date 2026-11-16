import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeWalletAddress } from './vault.mjs';

const isEqual=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
const safe=(message)=>Object.assign(new Error(message),{safe:true});
const asyncRoute=(handler)=>(req,res,next)=>Promise.resolve(handler(req,res)).catch(next);
const cookieValue=(raw,name)=>{for(const cookie of (raw||'').split(';')){const i=cookie.indexOf('=');if(cookie.slice(0,i).trim()===name)return cookie.slice(i+1).trim();}return '';};
export function createApp({engine,store,vault,browserWallets,publicDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public')}={}){
  const app=express();app.disable('x-powered-by');
  const busy=()=>engine.busy||engine.snapshot()?.engine?.busy;
  let changingWallet=false;
  const clearPlans=()=>{engine.plan=null;engine.bridgeQuotes?.clear();};
  const withWalletChange=async(action)=>{
    if(changingWallet||busy()||engine.configuring)throw safe('交易或配置更新进行中，请稍候再变更钱包');
    changingWallet=true;
    try{await engine.pause('钱包配置变更，自动执行已暂停');if(busy())throw safe('交易进行中，暂不能变更钱包');clearPlans();return await action();}finally{changingWallet=false;}
  };
  const scheduleWalletRefresh=(chain)=>{
    if(engine.walletChanged)engine.walletChanged(chain);
    else if(engine.balances){if(chain)delete engine.balances[chain];else engine.balances={};}
    setImmediate(()=>{Promise.resolve().then(()=>engine.refresh?.({autoExecute:false})).catch(()=>{});});
  };
  const broker=()=>{if(!browserWallets)throw safe('插件钱包连接服务未启用，请更新并重启程序');return browserWallets;};
  const clientId=(value)=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw safe('插件钱包页面标识无效，请刷新后重试');return value;};
  const session=randomBytes(32).toString('hex');const csrfToken=randomBytes(32).toString('hex');
  const sessionCookie=`dualarb_session=${session}; HttpOnly; SameSite=Strict; Path=/`;
  app.use((req,res,next)=>{
    const port=req.socket.localPort;const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`]);
    if(!hosts.has(req.headers.host))return res.status(403).json({error:'仅允许通过本机地址访问'});
    const origin=req.headers.origin;
    if(origin&&!hosts.has(origin.replace(/^http:\/\//,'')))return res.status(403).json({error:'请求来源不允许'});
    if(req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'禁止跨站请求'});
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    if(req.method==='OPTIONS')return res.sendStatus(403);
    next();
  });
  app.use(express.json({limit:'100kb',strict:true}));
  app.get('/api/session',(req,res)=>{res.setHeader('Set-Cookie',sessionCookie);res.json({csrfToken});});
  app.use('/api',(req,res,next)=>{
    if(!isEqual(cookieValue(req.headers.cookie,'dualarb_session'),session))return res.status(401).json({error:'请刷新本机页面后重试'});
    if(!['GET','HEAD'].includes(req.method)&&!isEqual(req.headers['x-csrf-token'],csrfToken))return res.status(403).json({error:'请求校验失败，请刷新页面'});
    next();
  });
  app.get('/api/state',asyncRoute(async(req,res)=>res.json(await engine.snapshot())));
  app.post('/api/config',asyncRoute(async(req,res)=>res.json(await engine.saveConfig(req.body?.config))));
  app.post('/api/engine/start',asyncRoute(async(req,res)=>res.json(await engine.start())));
  app.post('/api/engine/pause',asyncRoute(async(req,res)=>res.json(await engine.pause('用户暂停'))));
  app.post('/api/engine/execute',asyncRoute(async(req,res)=>res.json(await engine.execute())));
  app.post('/api/engine/acknowledge',asyncRoute(async(req,res)=>{
    if(typeof req.body?.tradeId!=='string'||typeof req.body?.note!=='string'||!req.body.note.trim())throw safe('请填写交易编号与人工核对说明');
    res.json(await engine.acknowledge({tradeId:req.body.tradeId,note:req.body.note.slice(0,10000)}));
  }));
  app.post('/api/refresh',asyncRoute(async(req,res)=>{await engine.refresh();res.json(await engine.snapshot());}));
  app.get('/api/trades',(req,res)=>res.json(store.listTrades(req.query.page,req.query.pageSize)));
  app.get('/api/trades/:id',(req,res)=>{const trade=store.getTrade(req.params.id);if(!trade)return res.status(404).json({error:'交易不存在'});res.json(trade);});
  app.get('/api/notes',(req,res)=>res.json(store.listNotes(req.query.page,req.query.pageSize)));
  app.post('/api/notes',asyncRoute(async(req,res)=>res.status(201).json(store.addNote(req.body?.text??req.body?.content))));
  app.delete('/api/notes/:id',(req,res)=>{const removed=store.deleteNote(req.params.id);if(!removed)return res.status(404).json({error:'备忘录不存在'});res.json({ok:true});});
  app.post('/api/wallets/import',asyncRoute(async(req,res)=>{
    if(!['private','readonly'].includes(req.body?.mode))throw safe('请选择本机私钥或只读地址导入；插件钱包请使用连接按钮');
    await withWalletChange(async()=>{await vault.importWallet(req.body);browserWallets?.disconnectChain(req.body.chain);scheduleWalletRefresh(req.body.chain);});res.json(vault.publicStatus());
  }));
  app.post('/api/wallets/connect',asyncRoute(async(req,res)=>{
    const body=req.body||{}, id=clientId(body.clientId), address=normalizeWalletAddress(body.chain,body.address);
    const allowed=body.chain==='bnb'?['metamask','okx']:['phantom','okx'];if(!allowed.includes(body.provider))throw safe('插件钱包与链不匹配');
    await withWalletChange(async()=>{
      const bridge=broker();bridge.connect({chain:body.chain,provider:body.provider,address,clientId:id});
      try{vault.importWallet({chain:body.chain,mode:'browser',provider:body.provider,address});}catch(error){bridge.disconnectChain(body.chain);throw error;}
      scheduleWalletRefresh(body.chain);
    });res.json(vault.publicStatus());
  }));
  app.post('/api/wallets/disconnect',asyncRoute(async(req,res)=>{
    const body=req.body||{}, id=clientId(body.clientId);
    if(!['bnb','solana'].includes(body.chain))throw safe('链名称无效');
    // A provider can disappear while a signature is pending. Cancel that pending
    // request and pause future cycles, without replacing the in-flight address.
    broker().disconnect({chain:body.chain,clientId:id});await engine.pause('插件钱包已断开，请重新连接后再执行');clearPlans();scheduleWalletRefresh(body.chain);res.json(vault.publicStatus());
  }));
  app.post('/api/wallets/restore-local',asyncRoute(async(req,res)=>{
    const chain=req.body?.chain;if(!['bnb','solana'].includes(chain))throw safe('链名称无效');
    await withWalletChange(async()=>{vault.restoreLocalWallet(chain);browserWallets?.disconnectChain(chain);scheduleWalletRefresh(chain);});res.json(vault.publicStatus());
  }));
  app.post('/api/wallets/browser/heartbeat',asyncRoute(async(req,res)=>{
    const body=req.body||{};clientId(body.clientId);
    if(!Array.isArray(body.connections)||body.connections.length>2)throw safe('插件钱包连接状态无效');
    try{broker().heartbeat({clientId:body.clientId,connections:body.connections});}
    catch(error){await engine.pause('插件账户或连接状态发生变化，请重新连接后再执行');clearPlans();scheduleWalletRefresh();throw error;}
    res.json(vault.publicStatus());
  }));
  app.get('/api/wallets/browser/requests',asyncRoute(async(req,res)=>{res.json(broker().poll(clientId(req.query.clientId)));}));
  app.post('/api/wallets/browser/result',asyncRoute(async(req,res)=>{
    const body=req.body||{};clientId(body.clientId);if(typeof body.requestId!=='string'||body.requestId.length>100)throw safe('插件签名请求编号无效');
    await broker().resolve({clientId:body.clientId,requestId:body.requestId,result:body.result,error:body.error});res.json({ok:true});
  }));
  app.post('/api/wallets/unlock',asyncRoute(async(req,res)=>{await withWalletChange(async()=>{vault.unlock(req.body?.password);scheduleWalletRefresh();});res.json(vault.publicStatus());}));
  app.post('/api/wallets/lock',asyncRoute(async(req,res)=>{await withWalletChange(async()=>vault.lock());res.json(vault.publicStatus());}));
  app.post('/api/okx/credentials',asyncRoute(async(req,res)=>{let result;await withWalletChange(async()=>{result=vault.setOkxCredentials(req.body);scheduleWalletRefresh();});res.json(result);}));
  app.post('/api/bridge/quote',asyncRoute(async(req,res)=>{
    const {fromChain,toChain,amountUsd}=req.body||{};
    if(!['bnb','solana'].includes(fromChain)||!['bnb','solana'].includes(toChain)||fromChain===toChain||typeof amountUsd!=='number'||!Number.isFinite(amountUsd)||amountUsd<=0)throw safe('请选择不同链并输入正数金额');
    res.json(await engine.quoteBridge({fromChain,toChain,amountUsd}));
  }));
  app.post('/api/bridge/execute',asyncRoute(async(req,res)=>{
    if(typeof req.body?.quoteId!=='string')throw safe('请先获取有效跨链报价');
    res.json(await engine.executeBridge({quoteId:req.body.quoteId}));
  }));
  app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在'}));
  app.use(express.static(publicDir,{dotfiles:'deny',index:'index.html',fallthrough:true,setHeaders:(res)=>res.setHeader('Set-Cookie',sessionCookie)}));
  app.use((req,res)=>res.status(404).send('页面不存在'));
  app.use((error,req,res,next)=>{
    // SDK exceptions can contain transaction inputs, private keys or RPC credentials.
    // Only deliberately marked validation messages are safe to return to the browser.
    const message=error?.safe?error.message:(error?.type==='entity.parse.failed'?'请求 JSON 无效':error?.type==='entity.too.large'?'请求内容过大':'操作失败，请检查配置、钱包解锁状态及交易档案');
    res.status(error?.type==='entity.too.large'?413:400).json({error:message});
  });
  return app;
}
export async function startLocalServer(options={}){
  const app=options.app||createApp(options);
  const requested=options.port??Number(process.env.PORT||0);
  if(!Number.isInteger(requested)||requested<0||requested>65535)throw new Error('端口无效');
  const listen=(port)=>new Promise((resolve,reject)=>{const server=app.listen(port,'127.0.0.1');server.once('error',reject);server.once('listening',()=>resolve(server));});
  let server;try{server=await listen(requested);}catch(error){if(requested&&error.code==='EADDRINUSE')server=await listen(0);else throw error;}
  const port=server.address().port;return {app,server,port,url:`http://127.0.0.1:${port}`};
}
