// Public BCH mainnet checkpoint headers used by local fake Fulcrum servers.
// Their hashes are pinned in src/networks.js and independently tested.
export const MAINNET_CHECKPOINT_HEADERS = new Map([
  [478559, '00000020432d350741fbf28f2e1486eabe2c4e143bfe2241af6518010000000000000000abaa4bd8a48c1c6bc08ee39b66065e5e9484304cab8b56d5eed3e40b1ac996c899c480593547011822ca4ae8'],
  [556767, '0000002022938d4ece739b34d65de82f58c72c7a80d09bde4fd9020100000000000000004419fd3ebb093486e3a662ec67455bf1ff06ec9052e59aba4d1b6bbd0511f31ca8b4ed5bdb1f021881f61ee9'],
]);

export function checkpointHeader(params) {
  return MAINNET_CHECKPOINT_HEADERS.get(params?.[0]) ?? null;
}
