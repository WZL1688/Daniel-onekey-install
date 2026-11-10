import { parseAbi } from 'viem';

/** Public interfaces from Uniswap v4 core/periphery; no external application code. */
export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
export const managerAbi = parseAbi([
  'function poolManager() view returns (address)',
  'function permit2() view returns (address)',
  'function WETH9() view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function nextTokenId() view returns (uint256)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'function modifyLiquidities(bytes unlockData,uint256 deadline) payable',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
  'error ERC721NonexistentToken(uint256 tokenId)',
]);
export const stateViewAbi = parseAbi([
  'function poolManager() view returns (address)',
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function getPositionInfo(bytes32 poolId,address owner,int24 tickLower,int24 tickUpper,bytes32 salt) view returns (uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId,int24 tickLower,int24 tickUpper) view returns (uint256 feeGrowthInside0X128,uint256 feeGrowthInside1X128)',
]);
export const permit2Abi = parseAbi([
  'function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
]);
