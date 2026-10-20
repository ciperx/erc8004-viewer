/** ERC-8004 deployments we target. Source: https://github.com/erc-8004/erc-8004-contracts (README, Base and Base Sepolia). */
export const REGISTRIES = {
  base: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
  "base-sepolia": {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
};

export const RPCS = {
  base: "https://mainnet.base.org",
  "base-sepolia": "https://base-sepolia-rpc.publicnode.com",
};

export default { REGISTRIES, RPCS };
