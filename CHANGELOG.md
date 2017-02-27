# Bcoin Release Notes & Changelog

## v1.0.0-beta.4

### Notable Changes

- __miner__ - Optimized TX sorting.
- __rpc__ - Improved getblocktemplate to provide more
  accurate results to bitcoind.

## v1.0.0-beta.3

### Notable Changes

- __miner__ - Improved fee rate sorting.
- __rpc__ - Fix incompatibilities in rpc api (getblocktemplate & submitblock).

## v1.0.0-beta.2

### Notable Changes

- __pool__ - Increase max header chain failures to 500 (prevents the initial
  sync from reverting to getblocks so frequently).

## v1.0.0-beta.1

### Notable Changes

- __wsproxy__: Fixed proof of work handling in websocket proxy (43c491b).
- __chain__: Optimized MTP and network target calculations (1e07d1b).
- __wallet__: Implemented "smart" coin selection (304f0e7e).
- __protocol__: Increased default network fees for main (09c2357).
- __http__: Fix for handling `DELETE` http method (393dd5d).
- __miner__: Improved handling of default reserved size and sigops (f2964e0
  and 7104e4c).

## v1.0.0-beta

### Notable Changes

- Initial tagged release.
