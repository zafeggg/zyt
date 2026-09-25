// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/UniV2.sol";

/**
 * @title MiniPair
 * @notice 测试用 Uniswap/Pancake V2 轻量实现（恒定乘积 + 0.25% fee 语义），
 *         覆盖 Pool/Creator 用到的全部接口：getReserves / mint / burn / swap / sync /
 *         token0 / token1 / totalSupply / ERC20（LP 凭证转移）。
 *         仅本地 hardhat / test 调用，禁止用于生产。
 */
contract MiniPair is ERC20 {
    address public token0;
    address public token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint32 private lastTs;

    uint256 private constant MINIMUM_LIQUIDITY = 1000;

    constructor() ERC20("Mini-LP", "MLP") {}

    function initialize(address t0, address t1) external {
        require(token0 == address(0), "init");
        (token0, token1) = t0 < t1 ? (t0, t1) : (t1, t0);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, lastTs);
    }

    function _update() internal {
        (uint256 b0, uint256 b1) = (_bal(token0), _bal(token1));
        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
        lastTs = uint32(block.timestamp);
    }

    function _bal(address t) internal view returns (uint256) {
        (bool ok, bytes memory data) = t.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok, "bal");
        return abi.decode(data, (uint256));
    }

    function mint(address to) external returns (uint256 liquidity) {
        (uint256 b0, uint256 b1) = (_bal(token0), _bal(token1));
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        if (totalSupply() == 0) {
            liquidity = _sqrt(b0 * b1) - MINIMUM_LIQUIDITY;
            _mint(address(this), MINIMUM_LIQUIDITY); // OZ5 不可铸给 0 地址，锁定于本合约
        } else {
            liquidity = _min(b0 * totalSupply() / r0, b1 * totalSupply() / r1);
        }
        require(liquidity > 0, "MiniPair: INSUFFICIENT_LIQUIDITY_MINTED");
        _mint(to, liquidity);
        _update();
    }

    function burn(address to) external returns (uint256 a0, uint256 a1) {
        uint256 bal = balanceOf(address(this));
        (uint256 b0, uint256 b1) = (_bal(token0), _bal(token1));
        a0 = b0 * bal / totalSupply();
        a1 = b1 * bal / totalSupply();
        require(a0 > 0 && a1 > 0, "MiniPair: INSUFFICIENT_LIQUIDITY_BURNED");
        _burn(address(this), bal);
        _transferOut(token0, to, a0);
        _transferOut(token1, to, a1);
        _update();
    }

    function swap(uint256 a0Out, uint256 a1Out, address to, bytes calldata) external {
        require(a0Out > 0 || a1Out > 0, "MiniPair: INSUFFICIENT_OUTPUT_AMOUNT");
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        require(a0Out < r0 && a1Out < r1, "MiniPair: INSUFFICIENT_LIQUIDITY");
        if (a0Out > 0) _transferOut(token0, to, a0Out);
        if (a1Out > 0) _transferOut(token1, to, a1Out);
        (uint256 b0, uint256 b1) = (_bal(token0), _bal(token1));
        // Pancake V2 k 校验（fee 体现在 getAmountOut 计算）
        require(b0 * b1 >= r0 * r1, "MiniPair: K");
        _update();
    }

    function sync() external {
        _update();
    }

    function _transferOut(address token, address to, uint256 amount) internal {
        (bool ok, ) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        require(ok, "MiniPair: transfer failed");
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

/**
 * @title MiniFactory
 * @notice 测试用 Factory：createPair / getPair
 */
contract MiniFactory {
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "IDENTICAL");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(t0 != address(0), "ZERO");
        require(getPair[t0][t1] == address(0), "EXISTS");
        MiniPair p = new MiniPair();
        p.initialize(tokenA, tokenB);
        pair = address(p);
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
        allPairs.push(pair);
    }
}
