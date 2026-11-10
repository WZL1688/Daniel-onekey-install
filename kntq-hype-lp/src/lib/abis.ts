import { parseAbi } from 'viem';

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
export const whypeAbi = parseAbi([
  'function deposit() payable', 'function withdraw(uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
export const factoryAbi = parseAbi([
  'function getPool(address,address,uint24) view returns (address)',
  'function feeAmountTickSpacing(uint24) view returns (int24)',
]);
export const poolAbi = parseAbi([
  'function factory() view returns (address)', 'function token0() view returns (address)', 'function token1() view returns (address)',
  'function fee() view returns (uint24)', 'function tickSpacing() view returns (int24)', 'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function feeGrowthGlobal0X128() view returns (uint256)', 'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)',
]);
export const managerAbi = parseAbi([
  'function factory() view returns (address)', 'function WETH9() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns (uint256 amount0,uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint256 amount0,uint256 amount1)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96) payable returns (address pool)',
  'function refundETH() payable', 'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
  'event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
]);
