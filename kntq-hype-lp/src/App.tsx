import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowDownUp, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, Copy, Download, ExternalLink, Globe2, Layers3, Leaf, Loader2, Plus, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Wallet, X, Zap, AlertTriangle, Unplug } from 'lucide-react';
import type { Address, EIP1193Provider } from 'viem';
import { PROFILES, type WorkspaceProfile } from './lib/profiles';
import { getAdapter } from './lib/adapter';
import { validateRpcUrls } from './lib/readTransport';
import { discoverWallets, connectWallet, subscribeWallet } from './lib/wallet';
import type { WalletOption } from './lib/wallet';
import { loadSettings, saveSettings, loadUsdPrice, recordObservations, positionMetrics, clearObservations } from './lib/metrics';
import type { Settings, Snapshot, RpcHealth, UsdPrice, TxPlan, PositionState, OpenInput, ExecutionEvent, ProfileId } from './lib/types';

type Tab = 'positions' | 'activity';
type Modal = 'wallet' | 'open' | 'settings' | 'tx' | 'help' | null;
type Log = ExecutionEvent & { at: number; planId: string; account: string; kind: string; profile?: ProfileId; chainId?: number; };
const nf = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 });
const usd = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? '—' : '$' + value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const num = (value: string | number | undefined) => value == null || !Number.isFinite(Number(value)) ? '—' : nf.format(Number(value));
const short = (value: string) => value.slice(0, 6) + '…' + value.slice(-4);
const decimalPrice = (value: number) => value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 18 });
const message = (error: unknown) => { const detail = typeof error === 'object' && error !== null && 'details' in error && typeof error.details === 'string' ? error.details : null; return detail?.includes('全部 RPC') ? detail : (error instanceof Error ? error.message : String(error)); };
const priceOf = (snap: Snapshot | null) => snap?.pool && snap.pool.sqrtPriceX96 > 0n ? (Number(snap.pool.sqrtPriceX96) / 2 ** 96) ** 2 : null;
const poolPrice = (snap: Snapshot | null, kntqAddress: Address) => { const p = priceOf(snap); if (p === null || !snap?.pool) return null; return snap.pool.token0.toLowerCase() === kntqAddress.toLowerCase() ? p * 10 ** (snap.kntqDecimals - snap.whypeDecimals) : (1 / p) * 10 ** (snap.kntqDecimals - snap.whypeDecimals); };
const activityKey = (profile: ProfileId) => profile === 'hyperevm-v3' ? 'kntq-lp:activity:v1' : `kntq-lp:activity:v2:${profile}`;
function storedLogs(profile: ProfileId): Log[] { try { const data: unknown = JSON.parse(localStorage.getItem(activityKey(profile)) || '[]'); return Array.isArray(data) ? data.filter((x): x is Log => !!x && typeof x === 'object' && typeof x.at === 'number' && typeof x.label === 'string' && typeof x.account === 'string' && typeof x.planId === 'string' && ['simulating','signing','submitted','confirmed','failed'].includes(x.status)).slice(-200) : []; } catch { return []; } }

export default function App() {
  const [profileId, setProfileId] = useState<ProfileId>('hyperevm-v3');
  return <Workspace key={profileId} profile={PROFILES[profileId]} onProfileChange={setProfileId} />;
}

function Workspace({ profile, onProfileChange }: { profile: WorkspaceProfile; onProfileChange: (id: ProfileId) => void }) {
  // The selected adapter owns chain-specific reads and calldata. Switching the key unmounts every old plan.
  const adapter = useMemo(() => getAdapter(profile.id), [profile.id]);
  const { loadSnapshot, prepareOpen, prepareCollect, prepareExit, simulateStep, executePlan } = adapter;
  const isV4 = profile.protocol === 'v4';
  const EXPLORER = profile.explorer;
  const ADDRESSES = profile.addresses;
  const DEFAULT_SETTINGS = profile.defaults;
  const quote = profile.quoteSymbol;
  const [settings, setSettings] = useState<Settings>(() => loadSettings(profile.id));
  const [draft, setDraft] = useState<Settings>(settings);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [provider, setProvider] = useState<EIP1193Provider>();
  const [account, setAccount] = useState<Address>();
  const [walletName, setWalletName] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [health, setHealth] = useState<Record<string, RpcHealth>>({});
  const [reference, setReference] = useState<UsdPrice>();
  const [priceError, setPriceError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState<Tab>('positions');
  const [modal, setModal] = useState<Modal>(null);
  const [sort, setSort] = useState('value');
  const [showEmpty, setShowEmpty] = useState(false);
  const [input, setInput] = useState<OpenInput>({ kntq: '', whype: '', useNative: true, lowerPrice: '', upperPrice: '' });
  const [plan, setPlan] = useState<TxPlan>();
  const [simulation, setSimulation] = useState<'idle' | 'pending' | 'ok' | 'failed'>('idle');
  const [txError, setTxError] = useState('');
  const [txBusy, setTxBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [logs, setLogs] = useState<Log[]>(() => storedLogs(profile.id));
  const [manualTokenId, setManualTokenId] = useState('');
  const [tracking, setTracking] = useState(false);
  const [pendingHash, setPendingHash] = useState('');
  const [pendingBlocked, setPendingBlocked] = useState(false);
  const [pendingReason, setPendingReason] = useState('');
  const [reconciling, setReconciling] = useState(false);
  const [toast, setToast] = useState('');
  const refreshing = useRef(new Set<number>());
  const generation = useRef(0);
  const activeWallet = useRef<{ account?: Address; provider?: EIP1193Provider }>({});
  const cancelled = useRef(false);
  activeWallet.current = { account, provider };

  useEffect(() => () => { cancelled.current = true; generation.current++; activeWallet.current = {}; }, []);
  useEffect(() => discoverWallets(setWallets), []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { try { localStorage.setItem(activityKey(profile.id), JSON.stringify(logs)); } catch { /* In-memory journal remains available. */ } }, [logs, profile.id]);
  useEffect(() => {
    if (!provider) return;
    return subscribeWallet(provider, () => {
      cancelled.current = true; generation.current++; activeWallet.current = {}; setAccount(undefined); setSnapshot(null); setPlan(undefined); setModal(null); setBusy(false);
      setToast('钱包账户或网络已变化，请重新连接。');
    });
  }, [provider]);

  const refresh = useCallback(async () => {
    if (activeWallet.current.account !== account) return;
    const ticket = generation.current;
    if (refreshing.current.has(ticket)) return;
    refreshing.current.add(ticket); setBusy(true);
    try {
      const next = await loadSnapshot(settings, account, (h) => { if (ticket === generation.current) setHealth((prev) => ({ ...prev, [h.url]: h })); });
      if (ticket !== generation.current) return;
      setSnapshot(next); setError(''); if (account) recordObservations(account, next);
    } catch (err) { if (ticket === generation.current) setError(message(err)); }
    finally { refreshing.current.delete(ticket); if (ticket === generation.current) setBusy(false); }
  }, [settings, account, loadSnapshot]);
  useEffect(() => {
    generation.current++; setSnapshot(null); setHealth({}); setError('');
    // An earlier request may still be finishing; scheduling avoids mixing account snapshots.
    const start = setTimeout(() => { void refresh(); }, 50);
    const timer = setInterval(() => { void refresh(); }, settings.refreshSeconds * 1000);
    return () => { generation.current++; clearTimeout(start); clearInterval(timer); };
  }, [refresh, settings.refreshSeconds]);
  useEffect(() => {
    let alive = true;
    const getPrice = async () => { try { const p = await loadUsdPrice(); if (alive) { setReference(p); setPriceError(''); } } catch (err) { if (alive) setPriceError(message(err)); } };
    void getPrice(); const timer = setInterval(() => { void getPrice(); }, 45_000); return () => { alive = false; clearInterval(timer); };
  }, []);

  const age = snapshot ? Math.max(0, Math.floor((now - snapshot.blockTime) / 1000)) : null;
  const stale = !snapshot || age === null || age > settings.staleSeconds || !!error;
  const priceFresh = reference && now - reference.fetchedAt <= 90_000;
  const currentUsd = priceFresh ? reference : undefined;
  const deploymentBlocked = isV4 && snapshot?.deployment?.verified !== true;
  const tradingBlocked = stale || deploymentBlocked || pendingBlocked || (isV4 && !snapshot?.pool);
  const partial = snapshot?.positionsComplete === false;
  const p = poolPrice(snapshot, profile.kntq);
  const decorated = snapshot && account ? snapshot.positions.map((pos) => ({ pos, metrics: positionMetrics(account, pos, snapshot, currentUsd) })) : [];
  const emptied = decorated.filter(({ pos }) => pos.liquidity === 0n && Number(pos.feeKntq) === 0 && Number(pos.feeWhype) === 0).length;
  const positions = decorated.filter(({ pos }) => showEmpty || pos.liquidity > 0n || Number(pos.feeKntq) > 0 || Number(pos.feeWhype) > 0).sort((a, b) => sort === 'apr' ? (b.metrics.apr ?? -1) - (a.metrics.apr ?? -1) : sort === 'fees' ? (b.metrics.feesUsd ?? -1) - (a.metrics.feesUsd ?? -1) : sort === 'newest' ? (BigInt(b.pos.tokenId) > BigInt(a.pos.tokenId) ? 1 : -1) : (b.metrics.principalUsd ?? -1) - (a.metrics.principalUsd ?? -1));
  const totalValue = decorated.length && decorated.every(({ metrics }) => metrics.principalUsd != null) ? decorated.reduce((v, { metrics }) => v + metrics.principalUsd!, 0) : (snapshot && account && !decorated.length && priceFresh && !partial ? 0 : null);
  const totalFees = decorated.length && decorated.every(({ metrics }) => metrics.feesUsd != null) ? decorated.reduce((v, { metrics }) => v + metrics.feesUsd!, 0) : (totalValue === 0 ? 0 : null);
  const active = decorated.filter(({pos}) => pos.liquidity > 0n);
  const activeValue = active.reduce((sum,{metrics}) => sum + (metrics.principalUsd ?? 0),0);
  const weightedApr = activeValue > 0 && active.every(({ metrics }) => metrics.apr != null && metrics.principalUsd != null) ? active.reduce((v, { metrics }) => v + metrics.apr! * metrics.principalUsd!, 0) / activeValue : null;
  const visibleLogs = logs.filter((log) => account && log.account.toLowerCase() === account.toLowerCase() && (log.profile === profile.id || (!log.profile && profile.id === 'hyperevm-v3')) && (log.chainId === undefined || log.chainId === profile.chainId)).slice().reverse();

  async function connect(option: WalletOption) {
    setConnecting(true); setError('');
    const ticket = generation.current;
    try { const address = await connectWallet(option.provider, profile); if (ticket !== generation.current) throw new Error('连接期间网络或账户已变化，请重新连接'); generation.current++; setSnapshot(null); setProvider(option.provider); setAccount(address); setWalletName(option.name); setModal(null); }
    catch (err) { setError(message(err)); } finally { setConnecting(false); }
  }
  function openForm() {
    if (!account) { setModal('wallet'); return; }
    if (p) setInput((prev) => ({ ...prev, rangeMode: 'custom', lowerPrice: decimalPrice(p * 0.8), upperPrice: decimalPrice(p * 1.2) }));
    setTxError(''); setModal('open');
  }
  async function prepare(kind: 'mint' | 'collect' | 'exit', pos?: PositionState) {
    if (!account || !snapshot || tradingBlocked || txBusy) return;
    setTxBusy(true); setTxError(''); setConfirmed(false); setFinished(false); setEvents([]); cancelled.current = false;
    const ticket = generation.current;
    try {
      const walletAtStart = activeWallet.current;
      const next = kind === 'mint' ? await prepareOpen(settings, snapshot, account, input) : kind === 'collect' ? await prepareCollect(settings, snapshot, account, pos!) : await prepareExit(settings, snapshot, account, pos!);
      if (next.chainId !== profile.chainId || (next.profile && next.profile !== profile.id) || next.account.toLowerCase() !== account.toLowerCase()) throw new Error('交易计划与当前网络或账户不一致');
      if (ticket !== generation.current || cancelled.current || activeWallet.current.account !== walletAtStart.account || activeWallet.current.provider !== walletAtStart.provider) throw new Error('钱包已变化，请重新预览');
      setPlan(next); setModal('tx'); setSimulation('pending');
      try { await simulateStep(settings, next, next.steps[0]); if (ticket === generation.current && !cancelled.current) setSimulation('ok'); }
      catch (err) { if (ticket === generation.current) { setSimulation('failed'); setTxError(message(err)); } }
    } catch (err) { setTxError(message(err)); setToast(message(err)); }
    finally { setTxBusy(false); }
  }
  async function execute() {
    if (!plan || !provider || !confirmed || txBusy || simulation !== 'ok' || tradingBlocked || plan.chainId !== profile.chainId || (plan.profile && plan.profile !== profile.id)) return;
    setTxBusy(true); setTxError(''); cancelled.current = false;
    const confirmedPlan = plan; const providerAtStart = provider;
    try {
      await executePlan(confirmedPlan, settings, provider, (event) => {
        setEvents((prev) => [...prev, event]);
        if (event.status === 'submitted' && confirmedPlan.kind !== 'mint' && snapshot && confirmedPlan.steps[event.index]?.to.toLowerCase() === profile.manager.toLowerCase()) clearObservations(confirmedPlan.account, snapshot);
        setLogs((prev) => [...prev, { ...event, at: Date.now(), planId: confirmedPlan.id, account: confirmedPlan.account, kind: confirmedPlan.kind, profile: profile.id, chainId: profile.chainId }].slice(-200));
      }, () => !cancelled.current && activeWallet.current.account === confirmedPlan.account && activeWallet.current.provider === providerAtStart);
      setFinished(true); setToast('交易流程已完成，正在刷新链上持仓。'); await refresh();
    } catch (err) { setTxError(message(err)); setSimulation('failed'); if (isV4) await queryPending(false); await refresh(); }
    finally { setTxBusy(false); }
  }
  function closeModal() { if (txBusy && !finished && !txError) { cancelled.current = true; setToast('将在当前交易确认后停止后续步骤。已广播交易仍由链上处理。'); return; } setModal(null); setTxError(''); }
  function exportRecords() {
    const state: Record<string, unknown> = {};
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith('kntq-lp:')) { try { state[key] = JSON.parse(localStorage.getItem(key)!); } catch { /* Ignore damaged records. */ } } }
    const blob = new Blob([JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), activeProfile: profile.id, profiles: Object.values(PROFILES).map(({id,chainId,manager})=>({id,chainId,manager})), state }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `kntq-lp-${profile.id}-records-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url); setToast('本地设置、采样与交易日志已导出。');
  }
  function applySettings() {
    try {
      if (!draft.rpcUrls.length || draft.rpcUrls.some((url) => { const u = new URL(url); return u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)); })) throw new Error('请输入有效的 HTTPS RPC，或本机 HTTP RPC。');
      if (draft.slippageBps < 1 || draft.slippageBps > 500 || !Number.isInteger(draft.slippageBps)) throw new Error('滑点范围为 0.01%–5%。');
      if (draft.refreshSeconds < 30 || draft.refreshSeconds > 300 || draft.staleSeconds < 30 || draft.staleSeconds > 300) throw new Error('刷新和过期阈值范围为 30–300 秒。');
      if (!/^\d+(\.\d{1,18})?$/.test(draft.gasReserveHype)) throw new Error('Gas 预留金额无效。');
      const next = { ...draft, rpcUrls: validateRpcUrls(draft.rpcUrls), fee: isV4 ? 10000 : draft.fee };
      saveSettings(next, profile.id); setSettings(next); setModal(null); setToast('本地设置已保存。');
    } catch (err) { setToast(message(err)); }
  }

  function changeProfile(next: ProfileId) {
    if (txBusy || connecting || tracking || reconciling || next === profile.id) return;
    cancelled.current = true; generation.current++; activeWallet.current = {};
    setPlan(undefined); setSnapshot(null); onProfileChange(next);
  }
  async function trackPosition() {
    if (!account || !adapter.readPosition || tracking || txBusy) return;
    const id = manualTokenId.trim();
    if (!/^\d{1,78}$/.test(id) || BigInt(id) <= 0n || BigInt(id) >= 2n ** 256n) { setToast('请输入有效的正整数 TokenId'); return; }
    const ticket = generation.current; setTracking(true);
    try {
      await adapter.readPosition(settings, account, id);
      if (ticket !== generation.current || activeWallet.current.account !== account) return;
      const next = { ...settings, trackedIds: [...new Set([...settings.trackedIds, id])] };
      if (next.trackedIds.length > 200) throw new Error('手动跟踪仓位最多为 200 个');
      saveSettings(next, profile.id); setSettings(next); setManualTokenId(''); setToast(`仓位 #${id} 的归属与目标池已核对，正在刷新`);
    } catch (err) { if (ticket === generation.current) setToast(message(err)); }
    finally { setTracking(false); }
  }

  async function queryPending(useTypedHash = true) {
    if (!account || !adapter.reconcilePending || reconciling) return;
    const candidate = useTypedHash ? pendingHash.trim() : '';
    if (candidate && !/^0x[0-9a-fA-F]{64}$/.test(candidate)) { setToast('请粘贴钱包中完整的 0x 交易哈希'); return; }
    const ticket = generation.current; setReconciling(true);
    try {
      const result = await adapter.reconcilePending(settings, account, candidate ? candidate as `0x${string}` : undefined);
      if (ticket !== generation.current || activeWallet.current.account !== account) return;
      setPendingBlocked(result.blocked); setPendingReason(result.reason || (result.blocked ? '交易状态尚未核实，后续签名保持锁定。' : '当前未发现需要恢复的待确认交易。'));
      if (result.hash) setPendingHash(result.hash);
    } catch (err) { if (ticket === generation.current) { setPendingBlocked(true); setPendingReason(message(err)); } }
    finally { setReconciling(false); }
  }

  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="#" aria-label="KNTQ LP 首页"><span className="brand-mark"><Leaf size={23} /></span><span>kinetiq<span className="brand-sub">LIQUIDITY WORKSPACE</span></span></a>
      <div className="workspace-label">我的工作空间 <span>LOCAL</span></div>
      <nav aria-label="主导航"><button className={tab === 'positions' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('positions')}><Layers3 size={18} />流动性持仓<span className="nav-count">{snapshot && account ? positions.length : '—'}</span></button><button className={tab === 'activity' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('activity')}><Activity size={18} />交易活动</button><button className="nav-item" onClick={() => { setDraft({ ...settings }); setModal('settings'); }}><Settings2 size={18} />连接与设置</button></nav>
      <div className="sidebar-note"><span className="tiny-orbit"><ShieldCheck size={21}/></span><strong>资产始终由你掌握</strong><p>连接自己的钱包，<br/>每笔交易由你签名。</p><button onClick={() => setModal('help')}>了解交易保护 <ArrowUpRight size={14}/></button></div>
      <div className="sidebar-bottom"><span className="status-dot"/> {profile.name} Mainnet <span className="chain-id">{profile.chainId}</span></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumb">工作空间 <span>/</span> <strong>{tab === 'positions' ? '流动性持仓' : '交易活动'}</strong></div><div className="top-actions"><label className="network-selector"><span>网络与协议</span><select aria-label="选择网络与协议" value={profile.id} disabled={txBusy || connecting || tracking || reconciling} onChange={(event) => changeProfile(event.target.value as ProfileId)}><option value="hyperevm-v3">HyperEVM · v3</option><option value="elysium-v4">Elysium · v4</option></select></label><span className="local-pill"><span/>本地运行</span><button className="icon-button" aria-label="帮助" onClick={() => setModal('help')}><CircleHelp size={19}/></button><button className="wallet-button" onClick={() => setModal('wallet')}><Wallet size={16}/>{account ? short(account) : '连接钱包'}{account && <span className="status-dot"/>}</button></div></header>
      <div className="content">
        <div className="page-heading"><div><div className="eyebrow"><span/> UNISWAP {profile.protocol.toUpperCase()} · {profile.name.toUpperCase()}</div><h1>{tab === 'positions' ? <>让流动性，持续生长<span className="title-dot">.</span></> : <>每一步，都有迹可循<span className="title-dot">.</span></>}</h1><p>{tab === 'positions' ? '管理你的 KNTQ / HYPE 流动性，让每一份资金清晰可见。' : '本机记录模拟、签名与链上确认，交易哈希可在浏览器核验。'}</p></div><button className="primary-button" onClick={openForm}><Plus size={18}/>新建流动性仓位</button></div>
        <div className="connection-strip"><div><span className={'status-dot ' + (stale ? 'amber' : '')}/><strong>{busy ? '正在同步链上数据' : !snapshot ? '等待链上连接' : stale ? '链上数据已过期' : '链上数据已同步'}</strong><span className="strip-divider"/><span>{snapshot ? `区块 #${snapshot.blockNumber.toLocaleString()} · ${age} 秒前` : '真实数据 · 无模拟持仓'}</span></div><button onClick={() => void refresh()} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''}/><span>刷新</span></button></div>
        {error && <div className="notice error"><AlertTriangle size={17}/><div><strong>链上连接需要检查</strong><p>{error}</p><button onClick={() => { setDraft({ ...settings }); setModal('settings'); }}>管理 RPC 连接 <ArrowRight size={13}/></button></div></div>}
        {isV4 && <div className={"notice deployment-status " + (deploymentBlocked ? "" : "verified")}><ShieldCheck size={17}/><div><strong>{deploymentBlocked ? "Elysium 合约身份尚未通过校验，交易已锁定" : "Elysium 合约代码身份与关联校验已通过"}</strong><p>使用原生 HYPE 与桥接 KNTQ；每次签名前仍会重新核对合约、账户和网络。</p></div></div>}
        {pendingBlocked && <div className="notice error"><Clock3 size={16}/><div><strong>存在尚未核实的交易，后续签名已锁定</strong><p>{pendingReason}</p><button onClick={() => {setDraft({...settings});setModal('settings');}}>查询待确认交易 <ArrowRight size={13}/></button></div></div>}
        {snapshot?.warnings.map((warning) => <div className="notice" key={warning}><AlertTriangle size={16}/>{warning}</div>)}
        {snapshot && stale && <div className="notice"><Clock3 size={16}/>行情超过 {settings.staleSeconds} 秒或连接失败，交易已暂停。刷新成功后可继续。</div>}
        <section className="summary-grid" aria-label="持仓概览">
          <Summary title={partial ? "已扫描流动性本金" : "流动性本金"} value={usd(totalValue)} sub="当前持仓代币的美元价值" icon={<Layers3 size={18}/>} note={account ? `${decorated.filter(({pos}) => pos.liquidity > 0n).length} 个${partial ? "已扫描" : ""}活跃仓位` : '连接钱包后查询'} />
          <Summary title={partial ? "已扫描待领手续费" : "待领取手续费"} value={usd(totalFees)} sub="链上累计 · 随区块更新" icon={<ArrowDownLeft size={19}/>} note={totalFees != null ? '可逐仓领取' : '等待链上数据'} accent />
          <Summary title="近期手续费年化" value={weightedApr == null ? '—' : `${weightedApr.toFixed(2)}%`} sub="持仓价值加权 · 近 24 小时采样" icon={<Activity size={18}/>} note="至少需要 5 分钟真实样本" />
        </section>
        {tab === 'positions' ? <>
          <section className="positions-section"><div className="section-heading"><div><h2>我的流动性<span className="count-pill">{account && snapshot ? positions.length : '—'}</span></h2><p>KNTQ / {quote} <span>·</span> {isV4 ? "Uniswap v4 目标池仓位" : "官方 Uniswap v3 仓位"}</p></div><div className="section-controls"><label className="empty-toggle"><input type="checkbox" checked={!showEmpty} onChange={(event) => setShowEmpty(!event.target.checked)}/>隐藏空仓{emptied > 0 ? ` (${emptied})` : ''}</label><div className="sort-control"><ArrowDownUp size={14}/><select aria-label="持仓排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="value">本金从高到低</option><option value="fees">待领收益排序</option><option value="apr">近期年化排序</option><option value="newest">最新仓位优先</option></select><ChevronDown size={13}/></div></div></div>
          {positions.length ? <div className="position-grid">{positions.map(({pos,metrics}) => {
            const width = Math.max(0, Math.min(100, (metrics.currentPrice - metrics.lowerPrice) / (metrics.upperPrice - metrics.lowerPrice) * 100));
            return <article className="position-card" key={pos.tokenId}><div className="card-top"><div className="pair-title"><PairIcon/><div><strong>KNTQ / {quote}</strong><span>{pos.pool.fee / 10000}% 费率 <i>·</i> #{pos.tokenId}</span></div></div><span className={'range-badge ' + (pos.inRange && pos.liquidity > 0n ? '' : 'inactive')}>{pos.liquidity === 0n ? '已撤出' : pos.inRange ? '区间内' : '区间外'}</span></div><div className="card-principal"><span>流动性本金</span><strong>{usd(metrics.principalUsd)}</strong><small>{num(pos.amountKntq)} KNTQ <i>+</i> {num(pos.amountWhype)} {quote}</small></div><div className="card-yield"><div><span>待领取收益</span><strong>{usd(metrics.feesUsd)}</strong><small>{num(pos.feeKntq)} KNTQ + {num(pos.feeWhype)} {quote}</small></div><div className="apr"><span>近期年化</span><strong>{metrics.apr == null ? '采集中' : `${metrics.apr.toFixed(2)}%`}</strong><small>{metrics.sampleSeconds < 300 ? `${Math.floor(metrics.sampleSeconds)} / 300 秒` : `${Math.floor(metrics.sampleSeconds / 60)} 分钟样本`}</small></div></div><div className="second-estimate"><Zap size={13}/><span>秒级估算待领</span><strong>{usd(stale || metrics.feesUsd == null || metrics.perSecondUsd == null ? null : metrics.feesUsd + metrics.perSecondUsd * Math.max(0, (now - snapshot!.blockTime) / 1000), 6)}</strong></div><div className="rate-caption">{metrics.perSecondUsd == null || stale ? '真实样本不足或数据过期，暂停推算' : `按最近实测速率 +${usd(metrics.perSecondUsd, 8)} / 秒推算`}</div><div className="range-area"><div><span>价格区间</span><span>{quote} / KNTQ</span></div><div className="range-track"><span style={{left:`${width}%`}}/></div><div><b>{num(metrics.lowerPrice)}</b><b>{num(metrics.upperPrice)}</b></div></div><div className="card-actions"><button className="collect-button" disabled={tradingBlocked || txBusy || !(Number(pos.feeKntq) > 0 || Number(pos.feeWhype) > 0)} onClick={() => void prepare('collect',pos)}><ArrowDownLeft size={15}/>领取手续费</button><button className="exit-button" disabled={tradingBlocked || txBusy || pos.liquidity === 0n} onClick={() => void prepare('exit',pos)}>撤池<ArrowUpRight size={14}/></button></div></article>;
          })}</div> : <div className="empty-state"><div className="empty-visual"><span className="orbit one"/><span className="orbit two"/><span className="floating-dot d1"/><span className="floating-dot d2"/><div className="empty-token"><Leaf size={36}/></div><span className="mini-token">H</span></div><h3>{!account ? '你的流动性，从这里开始' : !snapshot ? '正在等待真实链上持仓' : partial ? '扫描范围内未发现目标仓位' : '为你的资产，开启新的流动性'}</h3><p>{!account ? '连接浏览器钱包，查看余额与持仓，或创建第一个 KNTQ / HYPE 仓位。' : !snapshot ? `连接可用的 ${profile.name} RPC 后，将读取钱包中的 Uniswap ${profile.protocol} 仓位。` : partial ? '仓位扫描尚不完整，可在下方输入 TokenId 核对并跟踪；未扫描到不代表钱包没有持仓。' : emptied ? `${emptied} 个已撤空仓位已隐藏。你可以创建新仓位，或关闭“隐藏空仓”查看。` : `此钱包暂无 KNTQ / ${quote} 仓位。确认代币预算，预览后开始建仓。`}</p><button className="primary-button" onClick={!account ? () => setModal('wallet') : openForm}>{!account ? <Wallet size={16}/> : <Plus size={16}/>} {!account ? '连接钱包' : '创建流动性仓位'}<ArrowRight size={16}/></button><span className="empty-caption"><ShieldCheck size={13}/>钱包签名授权 · 签名前模拟</span></div>}
          {isV4 && <div className="manual-position"><div><strong>按 TokenId 找回仓位</strong><p>逐一验证当前钱包归属、完整 PoolKey 和手续费读取，再加入当前网络的跟踪列表。</p></div><div className="manual-position-input"><input aria-label="跟踪 TokenId" inputMode="numeric" placeholder="输入 NFT TokenId" value={manualTokenId} onChange={(event) => setManualTokenId(event.target.value)}/><button className="secondary-button" disabled={!account || tracking || txBusy || !manualTokenId.trim()} onClick={() => void trackPosition()}>{tracking ? <Loader2 size={14} className="spin"/> : <Plus size={14}/>}核对并跟踪</button></div></div>}
          </section>
          <section className="bottom-grid"><div className="market-panel"><div className="panel-heading"><h3><Globe2 size={16}/>市场与钱包</h3><span className="soft-label">LIVE ONCHAIN</span></div><div className="market-main"><PairIcon/><div><strong>KNTQ / {quote}</strong><span>{profile.name} · {settings.fee / 10000}% 费率</span></div><div className="market-price"><strong>{p == null ? '—' : num(p)} <small>{quote}</small></strong><span>{p != null && currentUsd ? usd(p * currentUsd.hype, 5) : '美元参考价暂不可用'}</span></div></div><div className="balances"><div><span>KNTQ 余额</span><strong>{account && snapshot ? num(snapshot.balances.kntq) : '—'}</strong></div><div><span>WHYPE 余额</span><strong>{account && snapshot ? num(snapshot.balances.whype) : '—'}</strong></div><div><span>HYPE 余额</span><strong>{account && snapshot ? num(snapshot.balances.hype) : '—'}</strong></div></div><div className="panel-foot">{snapshot ? snapshot.pool ? <a href={`${EXPLORER}/address/${snapshot.pool.address}`} target="_blank" rel="noreferrer">{isV4 ? "查看目标 PoolManager" : "查看官方 Factory 池"} <ExternalLink size={12}/></a> : <span>{isV4 ? "目标池尚未初始化，当前不开放建仓。" : "此费率暂无已初始化池，建仓预览将显示初始化价格。"}</span> : <span>代币地址和池身份将在链上读取时验证。</span>}</div></div><div className="rpc-panel"><div className="panel-heading"><h3><Activity size={16}/>连接状态</h3><button aria-label="配置 RPC" onClick={() => {setDraft({...settings});setModal('settings');}}><SlidersHorizontal size={16}/></button></div>{settings.rpcUrls.map((url,i) => <div className="rpc-row" key={url}><span className={'status-dot ' + (!health[url]?.ok ? 'amber' : '')}/><div><strong>{new URL(url).hostname}</strong><span>{i === 0 ? '首选 RPC' : '备用 RPC'}{snapshot?.rpcUrl === url ? ' · 当前使用' : ''}</span></div><span className={health[url]?.ok ? 'latency' : 'rpc-wait'}>{health[url] ? health[url].ok ? `${health[url].latencyMs} ms` : '连接失败' : '待检测'}</span></div>)}<div className="panel-foot"><ShieldCheck size={12}/>只读请求自动切换 · 钱包交易单次广播</div></div></section>
        </> : <section className="activity-panel"><div className="section-heading"><div><h2>交易活动<span className="count-pill">{visibleLogs.length}</span></h2><p>仅保存此浏览器产生的操作日志</p></div><button className="secondary-button" onClick={exportRecords}><Download size={15}/>导出记录</button></div>{visibleLogs.length ? <div className="activity-list">{visibleLogs.map((log,index)=><div className="activity-row" key={`${log.at}-${index}`}><span className={'activity-icon ' + (log.status==='failed'?'failed':'')}>{log.status==='confirmed'?<CheckCheck size={18}/>:log.status==='failed'?<AlertTriangle size={18}/>:<Activity size={18}/>}</span><div><strong>{log.label}</strong><span>{new Date(log.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · {{simulating:'模拟中',signing:'请求签名',submitted:'已广播',confirmed:'链上已确认',failed:'流程已停止'}[log.status]}{log.error ? ` · ${log.error}` : ''}</span></div>{log.hash && <a href={`${EXPLORER}/tx/${log.hash}`} target="_blank" rel="noreferrer">{short(log.hash)}<ExternalLink size={13}/></a>}</div>)}</div> : <div className="activity-empty"><Activity size={34}/><h3>还没有交易记录</h3><p>{account ? '交易预览、模拟与签名后，处理进度会记录在这里。' : '连接钱包后查看本机保存的交易活动。'}</p></div>}</section>}
        <footer className="footer"><span><Leaf size={14}/>你的钱包，你的流动性。</span><div><span title={reference?.source}>{priceFresh ? 'USD 参考：Hyperliquid 永续中间价' : priceError ? 'USD 行情连接不可用' : 'USD 参考价已过期'}</span><span className="footer-dot">·</span><button onClick={exportRecords}>导出本地记录 <Download size={12}/></button></div></footer>
      </div>
    </main>
    {toast && <div className="toast" role="status"><Check size={16}/>{toast}</div>}
    {modal && <div className="modal-backdrop" onClick={(event)=>{if(event.target===event.currentTarget)closeModal();}}><section className={'modal '+(modal==='tx'?'wide-modal':'')} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-heading"><div><div className="eyebrow">KNTQ LIQUIDITY WORKSPACE</div><h2 id="modal-title">{{wallet:'连接你的钱包',open:'新建流动性仓位',settings:'连接与交易设置',tx:'确认交易预览',help:'清楚地了解每笔操作'}[modal]}</h2></div><button className="icon-button" aria-label="关闭对话框" onClick={closeModal}><X size={20}/></button></div>
      {modal==='wallet' && <><p className="modal-intro">使用浏览器钱包连接 {profile.name} 主网（{profile.chainId}）。连接过程无需签名。</p>{account && <div className="connected-box"><Wallet size={20}/><div><strong>{walletName}</strong><span>{short(account)}</span></div><button className="icon-button" aria-label="复制地址" onClick={()=>{void navigator.clipboard.writeText(account);setToast('钱包地址已复制');}}><Copy size={16}/></button><button className="text-button" onClick={()=>{cancelled.current=true;generation.current++;setAccount(undefined);setProvider(undefined);setSnapshot(null);setPlan(undefined);setModal(null);}}><Unplug size={15}/>断开</button></div>}{wallets.length ? <div className="wallet-list">{wallets.map((option)=><button key={option.id} disabled={connecting} onClick={()=>void connect(option)}><span className="wallet-logo"><Wallet size={22}/></span><strong>{option.name}</strong>{connecting?<Loader2 className="spin" size={17}/>:<ArrowRight size={17}/>}</button>)}</div> : <div className="notice"><Wallet size={20}/><div><strong>尚未检测到浏览器钱包</strong><p>在安装了 MetaMask、Rabby 等钱包扩展的桌面浏览器中打开本地地址，再刷新此页面。</p></div></div>}<div className="modal-bottom-note"><ShieldCheck size={15}/>本工具不会索取或保存助记词与私钥。</div></>}
      {modal==='open' && <>
        <p className="modal-intro">设置双币预算与价格区间，确认预览后依次完成授权和建仓。</p>
        <div className="form-row">
          <label>池费率<select aria-label="池费率" value={settings.fee} disabled={isV4} onChange={(event)=>{const next={...settings,fee:Number(event.target.value)};saveSettings(next,profile.id);setSettings(next);}}>{(isV4 ? [10000] : [100,500,3000,10000]).map((fee)=><option value={fee} key={fee}>{fee/10000}%</option>)}</select></label>
          <label>支付资产{isV4 ? <span className="fixed-field">HYPE（原生资产）</span> : <select value={input.useNative?'native':'wrapped'} onChange={(event)=>setInput({...input,useNative:event.target.value==='native'})}><option value="native">HYPE（自动包装）</option><option value="wrapped">已有 WHYPE</option></select>}</label>
        </div>
        <div className="token-input"><label>投入预算 <span>余额 {snapshot?num(snapshot.balances.kntq):'—'}</span></label><div><input aria-label="KNTQ 预算" inputMode="decimal" placeholder="0.00" value={input.kntq} onChange={(event)=>setInput({...input,kntq:event.target.value})}/><span className="token-label"><span className="coin k">K</span>KNTQ</span></div></div>
        <div className="input-plus"><Plus size={14}/></div>
        <div className="token-input"><label>投入预算 <span>余额 {snapshot?num(input.useNative?snapshot.balances.hype:snapshot.balances.whype):'—'}</span></label><div><input aria-label={isV4 ? 'HYPE 预算' : 'HYPE 或 WHYPE 预算'} inputMode="decimal" placeholder="0.00" value={input.whype} onChange={(event)=>setInput({...input,whype:event.target.value})}/><span className="token-label"><span className="coin h">H</span>{isV4 || input.useNative?'HYPE':'WHYPE'}</span></div></div>
        <div className="range-form-heading"><label>价格区间 <span>{quote} / KNTQ</span></label><div>{[2,5,10,20].map((percent)=><button type="button" key={percent} onClick={()=>{const basis=p??(Number(input.whype)/Number(input.kntq));if(basis>0&&Number.isFinite(basis))setInput({...input,rangeMode:'custom',lowerPrice:decimalPrice(basis*(1-percent/100)),upperPrice:decimalPrice(basis*(1+percent/100))});}}>±{percent}%</button>)}<button type="button" className={input.rangeMode==='full'?'active':''} aria-pressed={input.rangeMode==='full'} onClick={()=>setInput({...input,rangeMode:'full',lowerPrice:'',upperPrice:''})}>全区间</button></div></div>
        {input.rangeMode==='full' ? <div className="full-range-note"><Layers3 size={15}/><div><strong>协议允许的全价格区间</strong><p>使用当前池 tick spacing 对齐的最小与最大 tick；最终边界将在交易预览中展示。</p></div><button className="text-button" onClick={()=>setInput({...input,rangeMode:'custom'})}>自定义</button></div> : <div className="form-row"><label>最低价格<input inputMode="decimal" value={input.lowerPrice} onChange={(event)=>setInput({...input,rangeMode:'custom',lowerPrice:event.target.value})} placeholder="0.00000"/></label><label>最高价格<input inputMode="decimal" value={input.upperPrice} onChange={(event)=>setInput({...input,rangeMode:'custom',upperPrice:event.target.value})} placeholder="0.00000"/></label></div>}
        {snapshot&&!snapshot.pool&&<div className="notice"><AlertTriangle size={16}/><div>{isV4 ? '目标 v4 池尚未完成初始化，当前建仓入口已锁定。' : <>此费率暂无已初始化池。新池初始价格为预算比率 {Number(input.kntq)>0?num(Number(input.whype)/Number(input.kntq)):'—'} {quote} / KNTQ，预览中会再次确认。</>}</div></div>}
        <div className="form-details"><div><span>固定滑点</span><strong>{settings.slippageBps/100}%</strong></div><div><span>HYPE Gas 最低预留</span><strong>{settings.gasReserveHype} HYPE</strong></div><div><span>预算用途</span><strong>{isV4 ? '有限额授权、添加原生 HYPE 流动性' : '只包装、授权、添加流动性'}</strong></div></div>
        <p className="hint">实际双币比例由价格区间决定，未使用的预算留在钱包。领取与撤池回款为 KNTQ 和 {quote}。</p>
        {isV4&&deploymentBlocked&&<div className="notice"><ShieldCheck size={16}/>合约身份校验尚未通过，建仓签名已锁定。</div>}
        {txError&&<div className="notice error">{txError}</div>}
        <button className="primary-button full" disabled={tradingBlocked||txBusy||!input.kntq||!input.whype||(input.rangeMode!=='full'&&(!input.lowerPrice||!input.upperPrice))} onClick={()=>void prepare('mint')}>{txBusy?<Loader2 size={17} className="spin"/>:<ShieldCheck size={17}/>} {stale?'等待新鲜链上数据':deploymentBlocked?'等待合约身份校验':'预览建仓交易'}<ArrowRight size={16}/></button>
      </>}
      {modal==='settings' && <><p className="modal-intro">设置仅保存在此浏览器。备用 RPC 只处理读取与模拟请求。</p><label className="field-label">{profile.name} RPC <span>每行一个，按顺序故障切换</span><textarea rows={3} value={draft.rpcUrls.join('\n')} onChange={(event)=>setDraft({...draft,rpcUrls:event.target.value.split('\n')})}/></label><div className="form-row"><label>固定滑点 (%)<input type="number" step="0.01" min="0.01" max="5" value={draft.slippageBps/100} onChange={(event)=>setDraft({...draft,slippageBps:Math.round(Number(event.target.value)*100)})}/></label><label>Gas 最低预留 (HYPE)<input inputMode="decimal" value={draft.gasReserveHype} onChange={(event)=>setDraft({...draft,gasReserveHype:event.target.value})}/></label></div><div className="form-row"><label>刷新间隔 (秒)<input type="number" min="30" max="300" value={draft.refreshSeconds} onChange={(event)=>setDraft({...draft,refreshSeconds:Number(event.target.value)})}/></label><label>行情过期阈值 (秒)<input type="number" min="30" max="300" value={draft.staleSeconds} onChange={(event)=>setDraft({...draft,staleSeconds:Number(event.target.value)})}/></label></div><>{isV4 && <div className="recovery-panel"><strong>查询待确认交易</strong><p>若钱包已广播后页面超时，先查询已有交易。只按链上回执和原始交易内容解除锁定，不重新广播。</p><label>钱包交易哈希（可选）<input aria-label="待确认交易哈希" placeholder="0x…，未知时从钱包活动中复制" value={pendingHash} onChange={(event)=>setPendingHash(event.target.value)}/></label><button className="secondary-button" disabled={!account || reconciling || txBusy} onClick={()=>void queryPending()}>{reconciling ? <Loader2 size={14} className="spin"/> : <RefreshCw size={14}/>}查询待确认交易</button>{pendingReason && <p className={pendingBlocked ? "pending-blocked" : "pending-clear"}>{pendingReason}</p>}{/^0x[0-9a-fA-F]{64}$/.test(pendingHash) && <a href={`${EXPLORER}/tx/${pendingHash}`} target="_blank" rel="noreferrer">在区块浏览器核对 {short(pendingHash)} <ExternalLink size={12}/></a>}</div>}</><div className="contract-list"><strong>固定网络与合约</strong>{Object.entries(ADDRESSES).map(([key,address])=><a key={key} href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer"><span>{key.toUpperCase()}</span><code>{short(address)}</code><ExternalLink size={12}/></a>)}<a href={profile.source} target="_blank" rel="noreferrer">查看部署资料来源<ExternalLink size={12}/></a></div><div className="modal-actions"><button className="secondary-button" onClick={()=>setDraft({...DEFAULT_SETTINGS,rpcUrls:[...DEFAULT_SETTINGS.rpcUrls]})}>恢复默认</button><button className="primary-button" onClick={applySettings}><Check size={16}/>保存设置</button></div></>}
      {modal==='tx'&&plan&&<><div className="preview-badge"><ShieldCheck size={17}/>{profile.name} 主网 · {short(plan.account)}<span>#{plan.sourceBlock.toString()}</span></div><div className="preview-summary">{plan.summary.map((line,i)=><p key={i}>{line}</p>)}</div><div className="transaction-steps">{plan.steps.map((step,index)=>{const status=events.filter((event)=>event.index===index).at(-1);return <div key={index} className={'transaction-step '+(status?.status==='confirmed'?'done':'')}><span className="step-index">{status?.status==='confirmed'?<Check size={14}/>:index+1}</span><div><strong>{step.label}</strong><span>{short(step.to)} · {status?{simulating:'签名前模拟',signing:'等待钱包签名',submitted:'已广播，等待链上确认',confirmed:'链上已确认',failed:'已停止'}[status.status]:'等待确认后执行'}</span>{status?.hash&&<a href={`${EXPLORER}/tx/${status.hash}`} target="_blank" rel="noreferrer">查看交易 {short(status.hash)} <ExternalLink size={12}/></a>}</div>{['simulating','signing','submitted'].includes(status?.status??'')&&<Loader2 className="spin" size={16}/>}</div>})}</div><div className={'simulation-box '+(simulation==='failed'?'failed':'')}>{simulation==='pending'?<Loader2 className="spin" size={17}/>:simulation==='ok'?<ShieldCheck size={18}/>:<AlertTriangle size={18}/>}<div><strong>{simulation==='pending'?'正在模拟首个可执行步骤':simulation==='ok'?'首步骤模拟通过':'流程已停止'}</strong><p>{isV4 ? "授权等前置步骤确认后，再模拟下一步；" : "授权、包装等前置步骤确认后，再模拟下一步；"}每次签名前重新检查余额、账户、网络与 Gas。</p></div></div><div className="preview-limits"><span>固定滑点 <b>{plan.slippageBps/100}%</b></span><span>预览有效期 <b>{Math.max(0,Math.ceil((plan.expiresAt-now)/1000))} 秒</b></span></div>{txError&&<div className="notice error"><AlertTriangle size={16}/><div>{txError}<p>已提交的交易请按哈希查询。需要继续时，刷新持仓并重新预览。</p></div></div>}{finished?<div className="success-box"><CheckCheck size={22}/><strong>所有步骤已获链上确认</strong><button className="primary-button" onClick={closeModal}>返回持仓</button></div>:<><label className="confirm-check"><input type="checkbox" checked={confirmed} disabled={txBusy} onChange={(event)=>setConfirmed(event.target.checked)}/><span>我已核对预算、区间和交易步骤，同意依次请求钱包签名。滑点固定，失败后停止，不自动重发。</span></label><button className="primary-button full" disabled={!confirmed||txBusy||simulation!=='ok'||now>=plan.expiresAt||tradingBlocked} onClick={()=>void execute()}>{txBusy?<Loader2 className="spin" size={17}/>:<Wallet size={17}/>} {txBusy?'按钱包提示完成签名':now>=plan.expiresAt?'预览已过期，请重新创建':'确认预算并执行'}</button>{txBusy&&<button className="text-button stop-button" onClick={()=>{cancelled.current=true;setToast('已请求停止后续步骤。');}}>停止后续步骤</button>}</>}</>}
      {modal==='help'&&<><p className="modal-intro">面向你自己的钱包与本地浏览器的流动性工作台。</p><div className="help-item"><ShieldCheck size={21}/><div><strong>先预览，再逐步模拟与签名</strong><p>计划锁定预算、价格区间、滑点与期限。钱包或网络变化会使计划失效。交易发送一次，RPC 失败仅切换读取。</p></div></div><div className="help-item"><Activity size={21}/><div><strong>收益来自真实手续费增量</strong><p>本金表示当前持仓代币价值。近期年化使用最长 24 小时、至少 5 分钟的本地连续样本；领取或流动性变化后重新采样。</p></div></div><div className="help-item"><Clock3 size={21}/><div><strong>每秒显示的是估算值</strong><p>秒级估算待领从最近链上待领金额出发，按本地实测速率推算并每秒重绘；数据过期即暂停，实际待领收益仍以链上区块为准。美元价值采用池内 KNTQ/{quote} 价格和 Hyperliquid HYPE 永续中间价。</p></div></div><div className="help-item"><Download size={21}/><div><strong>记忆与记录可长期维护</strong><p>项目附带 AI 接手规则、长期记忆、开发进度与维护日志。导出本地记录可备份设置、采样与交易日志；项目文档需要后续维护者主动读取并更新。</p></div></div><button className="secondary-button full" onClick={exportRecords}><Download size={16}/>导出本地记录</button></>}
    </section></div>}
  </div>;
}

function PairIcon(){return <span className="pair-icon"><span className="coin k"><Leaf size={16}/></span><span className="coin h">H</span></span>;}
function Summary({title,value,sub,icon,note,accent=false}:{title:string;value:string;sub:string;icon:React.ReactNode;note:string;accent?:boolean}){return <article className={'summary-card '+(accent?'accent':'')}><div className="summary-top"><span>{title}</span><span className="summary-icon">{icon}</span></div><strong className="summary-value" title={value}>{value}</strong><div className="summary-bottom"><span>{sub}</span><span className="summary-note">{accent&&<span className="status-dot"/>}{note}</span></div></article>;}
