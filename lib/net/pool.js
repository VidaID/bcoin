/*!
 * pool.js - peer management for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var AsyncObject = require('../utils/async');
var util = require('../utils/util');
var IP = require('../utils/ip');
var co = require('../utils/co');
var constants = require('../protocol/constants');
var errors = require('../btc/errors');
var NetAddress = require('../primitives/netaddress');
var Address = require('../primitives/address');
var BIP150 = require('./bip150');
var Bloom = require('../utils/bloom');
var ec = require('../crypto/ec');
var Locker = require('../utils/locker');
var Network = require('../protocol/network');
var Peer = require('./peer');
var request = require('../http/request');
var List = require('../utils/list');
var tcp = require('./tcp');
var dns = require('./dns');
var HostList = require('./hostlist');
var invTypes = constants.inv;
var VerifyError = errors.VerifyError;
var VerifyResult = errors.VerifyResult;

/**
 * A pool of peers for handling all network activity.
 * @exports Pool
 * @constructor
 * @param {Object} options
 * @param {Chain} options.chain
 * @param {Mempool?} options.mempool
 * @param {Number?} [options.maxOutbound=8] - Maximum number of peers.
 * @param {Boolean?} options.spv - Do an SPV sync.
 * @param {Boolean?} options.noRelay - Whether to ask
 * for relayed transactions.
 * @param {Boolean?} options.headers - Whether
 * to use `getheaders` for sync.
 * @param {Number?} [options.feeRate] - Fee filter rate.
 * @param {Number?} [options.invTimeout=60000] - Timeout for broadcasted
 * objects.
 * @param {Boolean?} options.listen - Whether to spin up a server socket
 * and listen for peers.
 * @param {Boolean?} options.selfish - A selfish pool. Will not serve blocks,
 * headers, hashes, utxos, or transactions to peers.
 * @param {Boolean?} options.broadcast - Whether to automatically broadcast
 * transactions accepted to our mempool.
 * @param {Boolean?} options.witness - Request witness blocks and transactions.
 * Only deal with witness peers.
 * @param {Boolean} options.ignoreDiscovery - Automatically discover new
 * peers.
 * @param {String[]} options.seeds
 * @param {Function?} options.createSocket - Custom function to create a socket.
 * Must accept (port, host) and return a node-like socket.
 * @param {Function?} options.createServer - Custom function to create a server.
 * Must return a node-like server.
 * @emits Pool#block
 * @emits Pool#block
 * @emits Pool#tx
 * @emits Pool#peer
 * @emits Pool#open
 * @emits Pool#close
 * @emits Pool#error
 * @emits Pool#fork
 * @emits Pool#invalid
 * @emits Pool#exists
 * @emits Pool#orphan
 * @emits Pool#full
 * @emits Pool#blocks
 * @emits Pool#txs
 * @emits Pool#chain-progress
 * @emits Pool#alert
 * @emits Pool#reject
 * @emits Pool#addr
 * @emits Pool#version
 * @emits Pool#ack
 * @emits Pool#watched
 */

function Pool(options) {
  if (!(this instanceof Pool))
    return new Pool(options);

  AsyncObject.call(this);

  assert(options && options.chain, 'Pool requires a blockchain.');

  this.options = options;
  this.chain = options.chain;
  this.logger = options.logger || this.chain.logger;
  this.mempool = options.mempool;
  this.network = this.chain.network;

  this.server = null;
  this.maxOutbound = 8;
  this.maxInbound = 8;
  this.connected = false;
  this.createSocket = tcp.createSocket;
  this.createServer = tcp.createServer;
  this.resolve = dns.resolve;
  this.locker = new Locker();
  this.auth = null;
  this.identityKey = null;
  this.proxyServer = null;
  this.banTime = constants.BAN_TIME;
  this.banScore = constants.BAN_SCORE;
  this.feeRate = -1;

  // Required services.
  this.needed = constants.services.NETWORK;
  this.needed |= constants.services.WITNESS;

  this.syncing = false;

  this.address = new NetAddress();
  this.address.ts = this.network.now();
  this.address.services = constants.LOCAL_SERVICES;
  this.address.setPort(this.network.port);

  this.hosts = new HostList(this);
  this.peers = new PeerList(this);

  this.localNonce = util.nonce();

  this.spvFilter = null;
  this.txFilter = null;

  // Requested objects.
  this.requestMap = {};
  this.activeRequests = 0;

  // Currently broadcasted objects.
  this.invMap = {};
  this.invTimeout = 60000;

  this.scheduled = false;
  this.pendingWatch = null;
  this.pendingRefill = null;

  this._initOptions();
  this._init();
};

util.inherits(Pool, AsyncObject);

/**
 * Initialize options.
 * @private
 */

Pool.prototype._initOptions = function _initOptions() {
  if (this.options.noRelay == null)
    this.options.noRelay = !!this.options.spv;

  if (this.options.headers == null)
    this.options.headers = this.options.spv;

  if (!this.options.witness) {
    this.address.services &= ~constants.services.WITNESS;
    this.needed &= ~constants.services.WITNESS;
  }

  if (this.options.host != null) {
    assert(typeof this.options.host === 'string');
    this.address.setHost(this.options.host);
  }

  if (this.options.port != null) {
    assert(typeof this.options.port === 'number');
    this.address.setPort(this.options.port);
  }

  if (this.options.maxOutbound != null) {
    assert(typeof this.options.maxOutbound === 'number');
    this.maxOutbound = this.options.maxOutbound;
  }

  if (this.options.maxInbound != null) {
    assert(typeof this.options.maxInbound === 'number');
    this.maxInbound = this.options.maxInbound;
  }

  if (this.options.createSocket) {
    assert(typeof this.options.createSocket === 'function');
    this.createSocket = this.options.createSocket;
  }

  if (this.options.createServer) {
    assert(typeof this.options.createServer === 'function');
    this.createServer = this.options.createServer;
  }

  if (this.options.resolve) {
    assert(typeof this.options.resolve === 'function');
    this.resolve = this.options.resolve;
  }

  if (this.options.proxyServer) {
    assert(typeof this.options.proxyServer === 'string');
    this.proxyServer = this.options.proxyServer;
  }

  if (this.options.bip150) {
    assert(typeof this.options.bip151 === 'boolean');

    this.auth = new BIP150.AuthDB();

    if (this.options.authPeers)
      this.auth.setAuthorized(this.options.authPeers);

    if (this.options.knownPeers)
      this.auth.setKnown(this.options.knownPeers);

    this.identityKey = this.options.identityKey || ec.generatePrivateKey();

    assert(Buffer.isBuffer(this.identityKey), 'Identity key must be a buffer.');
    assert(ec.privateKeyVerify(this.identityKey),
      'Invalid identity key.');
  }

  if (this.options.banScore != null) {
    assert(typeof this.options.banScore === 'number');
    this.banScore = this.options.banScore;
  }

  if (this.options.banTime != null) {
    assert(typeof this.options.banTime === 'number');
    this.banTime = this.options.banTime;
  }

  if (this.options.feeRate != null) {
    assert(typeof this.options.feeRate === 'number');
    this.feeRate = this.options.feeRate;
  }

  if (this.options.seeds)
    this.hosts.setSeeds(this.options.seeds);

  if (this.options.preferredSeed)
    this.hosts.setSeeds([this.options.preferredSeed]);

  if (this.options.spv) {
    this.spvFilter = Bloom.fromRate(10000, 0.001, constants.bloom.ALL);
    this.needed |= constants.services.BLOOM;
  }

  if (!this.options.mempool)
    this.txFilter = new Bloom.Rolling(50000, 0.000001);

  if (this.options.invTimeout != null) {
    assert(typeof this.options.invTimeout === 'number');
    this.invTimeout = this.options.invTimeout;
  }
};

/**
 * Initialize the pool.
 * @private
 */

Pool.prototype._init = function _init() {
  var self = this;

  this.chain.on('block', function(block, entry) {
    self.emit('block', block, entry);
  });

  this.chain.on('competitor', function(block, entry) {
    self.emit('competitor', block, entry);
  });

  this.chain.on('fork', function(block, height, expected) {
    self.emit('fork', block, height, expected);
  });

  this.chain.on('invalid', function(block, height) {
    self.emit('invalid', block, height);
  });

  this.chain.on('exists', function(block, height) {
    self.emit('exists', block, height);
  });

  this.chain.on('orphan', function(block, height) {
    self.emit('orphan', block, height);
  });

  this.chain.on('reset', function() {
    self.forceSync();
  });

  this.chain.on('full', function() {
    self.sync();
    self.emit('full');
    self.logger.info('Chain is fully synced (height=%d).', self.chain.height);
  });

  if (!this.options.selfish && !this.options.spv) {
    if (this.mempool) {
      this.mempool.on('tx', function(tx) {
        self.announceTX(tx);
      });
    }

    // Normally we would also broadcast
    // competing chains, but we want to
    // avoid getting banned if an evil
    // miner sends us an invalid competing
    // chain that we can't connect and
    // verify yet.
    this.chain.on('block', function(block) {
      if (!self.chain.synced)
        return;
      self.announceBlock(block);
    });
  }
};

/**
 * Open the pool, wait for the chain to load.
 * @alias Pool#open
 * @returns {Promise}
 */

Pool.prototype._open = co(function* _open() {
  var key;

  if (this.mempool)
    yield this.mempool.open();
  else
    yield this.chain.open();

  this.logger.info('Pool loaded (maxpeers=%d).', this.maxOutbound);

  if (this.identityKey) {
    key = ec.publicKeyCreate(this.identityKey, true);
    this.logger.info('Identity public key: %s.', key.toString('hex'));
    this.logger.info('Identity address: %s.', BIP150.address(key));
  }
});

/**
 * Close and destroy the pool.
 * @alias Pool#close
 * @returns {Promise}
 */

Pool.prototype._close = co(function* close() {
  var i, item, hashes, hash;

  this.stopSync();

  hashes = Object.keys(this.invMap);

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];
    item = this.invMap[hash];
    item.finish();
  }

  this.peers.destroy();

  this.requestMap = {};
  this.activeRequests = 0;

  this.hosts.reset();

  if (this.pendingWatch != null) {
    clearTimeout(this.pendingWatch);
    this.pendingWatch = null;
  }

  if (this.pendingRefill != null) {
    clearTimeout(this.pendingRefill);
    this.pendingRefill = null;
  }

  yield this.unlisten();
});

/**
 * Connect to the network.
 * @returns {Promise}
 */

Pool.prototype.connect = co(function* connect() {
  var unlock = yield this.locker.lock();
  try {
    return yield this._connect();
  } finally {
    unlock();
  }
});

/**
 * Connect to the network (no lock).
 * @returns {Promise}
 */

Pool.prototype._connect = co(function* connect() {
  var ip;

  assert(this.loaded, 'Pool is not loaded.');

  if (this.connected)
    return;

  if (this.address.isNull()) {
    try {
      ip = yield this.getIP();
    } catch (e) {
      this.logger.error(e);
    }
    if (ip) {
      this.address.setHost(ip);
      this.logger.info('External IP found: %s.', ip);
    }
  }

  yield this.hosts.discover();

  if (this.hosts.size() === 0)
    throw new Error('No hosts available. Do you have an internet connection?');

  this.logger.info('Resolved %d hosts from DNS seeds.', this.hosts.size());

  this.fillOutbound();

  this.connected = true;
});

/**
 * Start listening on a server socket.
 * @returns {Promise}
 */

Pool.prototype.listen = function listen() {
  var self = this;

  if (this.server)
    return Promise.resolve();

  if (!this.createServer)
    return;

  this.server = this.createServer();

  this.server.on('connection', function(socket) {
    self.handleInbound(socket);
  });

  this.server.on('listening', function() {
    var data = self.server.address();
    self.logger.info(
      'Pool server listening on %s (port=%d).',
      data.address, data.port);
  });

  return new Promise(function(resolve, reject) {
    self.server.listen(self.address.port, '0.0.0.0', co.wrap(resolve, reject));
  });
};

/**
 * Stop listening on server socket.
 * @returns {Promise}
 */

Pool.prototype.unlisten = function unlisten() {
  var self = this;

  if (util.isBrowser)
    return Promise.resolve();

  if (!this.server)
    return Promise.resolve();

  return new Promise(function(resolve, reject) {
    self.server.close(co.wrap(resolve, reject));
    self.server = null;
  });
};

/**
 * Handle incoming connection.
 * @private
 * @param {net.Socket} socket
 */

Pool.prototype.handleInbound = function handleInbound(socket) {
  var host;

  if (!socket.remoteAddress) {
    this.logger.debug('Ignoring disconnected leech.');
    socket.destroy();
    return;
  }

  host = IP.normalize(socket.remoteAddress);

  if (this.peers.inbound >= this.maxInbound) {
    this.logger.debug('Ignoring leech: too many inbound (%s).', host);
    socket.destroy();
    return;
  }

  if (this.hosts.isBanned(host)) {
    this.logger.debug('Ignoring banned leech (%s).', host);
    socket.destroy();
    return;
  }

  host = IP.hostname(host, socket.remotePort);

  assert(!this.peers.map[host], 'Port collision.');

  this.addInbound(socket);
};

/**
 * Add a loader peer. Necessary for
 * a sync to even begin.
 * @private
 */

Pool.prototype.addLoader = function addLoader() {
  var peer, addr;

  if (!this.loaded)
    return;

  assert(!this.peers.load);

  for (peer = this.peers.head(); peer; peer = peer.next) {
    if (!peer.outbound)
      continue;
    this.logger.info('Repurposing peer for loader (%s).', peer.hostname);
    this.setLoader(peer);
    return;
  }

  addr = this.getHost(false);

  if (!addr)
    return;

  peer = this.peers.get(addr.hostname);

  if (peer) {
    this.logger.info('Repurposing peer for loader (%s).', peer.hostname);
    this.setLoader(peer);
    return;
  }

  peer = this.createPeer(addr);

  this.logger.info('Setting loader peer (%s).', peer.hostname);

  this.peers.add(peer);

  this.setLoader(peer);
};

/**
 * Add a loader peer. Necessary for
 * a sync to even begin.
 * @private
 */

Pool.prototype.setLoader = function setLoader(peer) {
  if (!this.loaded)
    return;

  assert(peer.outbound);
  this.peers.load = peer;

  peer.sync();

  this.fillOutbound();

  this.emit('loader', peer);
};

/**
 * Start the blockchain sync.
 */

Pool.prototype.startSync = co(function* startSync() {
  yield this.connect();

  this.syncing = true;

  assert(this.peers.load);

  this.sync();
});

/**
 * Send a sync to each peer.
 * @private
 */

Pool.prototype.sync = function sync() {
  var peer;

  for (peer = this.peers.head(); peer; peer = peer.next) {
    if (!peer.outbound)
      continue;
    peer.sync();
  }
};

/**
 * Force sending a sync to each peer.
 * @private
 */

Pool.prototype.forceSync = function forceSync() {
  var peer;

  for (peer = this.peers.head(); peer; peer = peer.next) {
    if (!peer.outbound)
      continue;
    peer.syncSent = false;
    peer.sync();
  }
};

/**
 * Stop the blockchain sync.
 */

Pool.prototype.stopSync = co(function* stopSync() {
  var peer;

  if (!this.syncing)
    return;

  this.syncing = false;

  if (!this.loaded)
    return;

  for (peer = this.peers.head(); peer; peer = peer.next) {
    if (!peer.outbound)
      continue;
    peer.syncSent = false;
  }
});

/**
 * Send `mempool` to all peers.
 */

Pool.prototype.sendMempool = function sendMempool() {
  var peer;

  for (peer = this.peers.head(); peer; peer = peer.next)
    peer.sendMempool();
};

/**
 * Send `getaddr` to all peers.
 */

Pool.prototype.sendGetAddr = function sendGetAddr() {
  var peer;

  for (peer = this.peers.head(); peer; peer = peer.next)
    peer.sendGetAddr();
};

/**
 * Send `alert` to all peers.
 * @param {AlertPacket} alert
 */

Pool.prototype.sendAlert = function sendAlert(alert) {
  var peer;

  for (peer = this.peers.head(); peer; peer = peer.next)
    peer.sendAlert(alert);
};

/**
 * Create an outbound peer with no special purpose.
 * @private
 * @param {NetAddress} addr
 * @returns {Peer}
 */

Pool.prototype.createPeer = function createPeer(addr) {
  var peer = new Peer(this);

  this.bindPeer(peer);
  this.hosts.markAttempt(addr.hostname);

  peer.connect(addr);
  peer.tryOpen();

  return peer;
};

/**
 * Accept an inbound socket.
 * @private
 * @param {net.Socket} socket
 * @returns {Peer}
 */

Pool.prototype.acceptPeer = function acceptPeer(socket) {
  var peer = new Peer(this);

  this.bindPeer(peer);

  peer.accept(socket);
  peer.tryOpen();

  return peer;
};

/**
 * Bind to peer events.
 * @private
 */

Pool.prototype.bindPeer = function bindPeer(peer) {
  var self = this;

  peer.once('connect', function() {
    self.handleConnect(peer);
  });

  peer.once('open', function() {
    self.handleOpen(peer);
  });

  peer.once('close', function(connected) {
    self.handleClose(peer, connected);
  });

  peer.on('error', function(err) {
    self.emit('error', err, peer);
  });

  peer.on('version', function(packet) {
    self.handleVersion(peer, packet);
  });

  peer.on('addr', function(addrs) {
    self.handleAddr(peer, addrs);
  });

  peer.on('merkleblock', co(function* (block) {
    if (!self.options.spv)
      return;

    try {
      yield self.handleBlock(peer, block);
    } catch (e) {
      self.emit('error', e);
    }
  }));

  peer.on('block', co(function* (block) {
    if (self.options.spv)
      return;

    try {
      yield self.handleBlock(peer, block);
    } catch (e) {
      self.emit('error', e);
    }
  }));

  peer.on('tx', co(function* (tx) {
    try {
      yield self.handleTX(peer, tx);
    } catch (e) {
      self.emit('error', e);
    }
  }));

  peer.on('headers', co(function* (headers) {
    try {
      yield self.handleHeaders(headers, peer);
    } catch (e) {
      self.emit('error', e);
    }
  }));

  peer.on('blocks', co(function* (hashes) {
    try {
      yield self.handleBlockInv(peer, hashes);
    } catch (e) {
      self.emit('error', e);
    }
  }));

  peer.on('txs', function(hashes) {
    self.handleTXInv(peer, hashes);
  });

  peer.on('reject', function(reject) {
    self.handleReject(peer, reject);
  });

  peer.on('notfound', function(items) {
    self.handleNotFound(peer, items);
  });

  peer.on('alert', function(packet) {
    self.handleAlert(peer, packet);
  });
};

/**
 * Handle peer connect event.
 * @private
 * @param {Peer} peer
 */

Pool.prototype.handleConnect = function handleConnect(peer) {
  if (!peer.outbound)
    return;

  this.hosts.markSuccess(peer.hostname);
};

/**
 * Handle peer open event.
 * @private
 * @param {Peer} peer
 */

Pool.prototype.handleOpen = function handleOpen(peer) {
  if (!peer.outbound)
    return;

  this.hosts.markAck(peer.hostname, peer.version.services);

  // If we don't have an ack'd loader yet, use this peer.
  if (!this.peers.load || !this.peers.load.ack)
    this.setLoader(peer);
};

/**
 * Handle peer close event.
 * @private
 * @param {Peer} peer
 * @param {Boolean} connected
 */

Pool.prototype.handleClose = co(function* handleClose(peer, connected) {
  var loader = peer.isLoader();

  this.removePeer(peer);

  if (!this.loaded)
    return;

  if (!loader) {
    this.refill();
    return;
  }

  this.refill();
});

/**
 * Handle peer version event.
 * @private
 * @param {Peer} peer
 * @param {VersionPacket} packet
 */

Pool.prototype.handleVersion = function handleVersion(peer, packet) {
  this.logger.info(
    'Received version (%s): version=%d height=%d services=%s agent=%s',
    peer.hostname,
    packet.version,
    packet.height,
    packet.services.toString(2),
    packet.agent);

  this.network.time.add(peer.hostname, packet.ts);

  this.emit('version', packet, peer);
};

/**
 * Handle peer addr event.
 * @private
 * @param {Peer} peer
 * @param {NetAddress[]} addrs
 */

Pool.prototype.handleAddr = function handleAddr(peer, addrs) {
  var i, addr;

  if (this.options.ignoreDiscovery)
    return;

  for (i = 0; i < addrs.length; i++) {
    addr = addrs[i];

    if (!addr.isRoutable())
      continue;

    if (!addr.hasServices(this.needed))
      continue;

    if (this.hosts.add(addr, peer.address))
      this.emit('host', addr, peer);
  }

  this.emit('addr', addrs, peer);
  this.fillOutbound();
};

/**
 * Handle `block` packet. Attempt to add to chain.
 * @private
 * @param {Peer} peer
 * @param {MemBlock|MerkleBlock} block
 * @returns {Promise}
 */

Pool.prototype.handleBlock = co(function* handleBlock(peer, block) {
  var hash = block.hash('hex');
  var requested;

  if (!this.syncing)
    return;

  requested = this.fulfill(peer, hash);

  // Someone is sending us blocks without
  // us requesting them.
  if (!requested) {
    peer.invFilter.add(block.hash());
    this.logger.warning(
      'Received unrequested block: %s (%s).',
      block.rhash(), peer.hostname);
    return;
  }

  try {
    yield this.chain.add(block);
  } catch (err) {
    if (err.type !== 'VerifyError') {
      this.scheduleRequests(peer);
      throw err;
    }

    if (err.reason === 'bad-prevblk') {
      if (this.options.headers) {
        peer.increaseBan(10);
        throw err;
      }
      this.logger.debug('Peer sent an orphan block. Resolving.');
      yield peer.resolveOrphan(null, block.hash('hex'));
      this.scheduleRequests(peer);
      throw err;
    }

    peer.reject(block, err.code, err.reason, err.score);

    this.scheduleRequests(peer);

    throw err;
  }

  this.scheduleRequests(peer);

  if (this.logger.level >= 4 && this.chain.total % 20 === 0) {
    this.logger.debug('Status:'
      + ' ts=%s height=%d highest=%d progress=%s'
      + ' blocks=%d orphans=%d active=%d'
      + ' queue=%d target=%s peers=%d'
      + ' pending=%d jobs=%d',
      util.date(block.ts),
      this.chain.height,
      this.chain.bestHeight,
      (this.chain.getProgress() * 100).toFixed(2) + '%',
      this.chain.total,
      this.chain.orphanCount,
      this.activeRequests,
      0,
      block.bits,
      this.peers.size(),
      this.chain.locker.pending,
      this.chain.locker.jobs.length);
  }

  if (this.chain.total % 2000 === 0) {
    this.logger.info(
      'Received 2000 more blocks (height=%d, hash=%s).',
      this.chain.height,
      block.rhash());
  }
});

/**
 * Handle a transaction. Attempt to add to mempool.
 * @private
 * @param {Peer} peer
 * @param {TX} tx
 * @returns {Promise}
 */

Pool.prototype.handleTX = co(function* handleTX(peer, tx) {
  var hash = tx.hash('hex');
  var requested = this.fulfill(peer, hash);
  var i, missing;

  if (!requested) {
    peer.invFilter.add(tx.hash());

    if (!this.mempool)
      this.txFilter.add(tx.hash());

    this.logger.warning('Peer sent unrequested tx: %s (%s).',
      tx.txid(), peer.hostname);

    if (this.hasReject(tx.hash())) {
      throw new VerifyError(tx,
        'alreadyknown',
        'txn-already-in-mempool',
        0);
    }
  }

  if (!this.mempool) {
    this.emit('tx', tx, peer);
    this.scheduleRequests(peer);
    return;
  }

  try {
    missing = yield this.mempool.addTX(tx);
  } catch (err) {
    if (err.type === 'VerifyError')
      peer.reject(tx, err.code, err.reason, err.score);
    throw err;
  }

  if (missing) {
    this.logger.debug(
      'Requesting %d missing transactions (%s).',
      missing.length, peer.hostname);

    try {
      this.getTX(peer, missing);
    } catch (e) {
      this.emit('error', e);
    }
  }

  this.scheduleRequests(peer);

  this.emit('tx', tx, peer);
});

/**
 * Handle `headers` packet from a given peer.
 * @private
 * @param {Peer} peer
 * @param {Headers[]} headers
 * @returns {Promise}
 */

Pool.prototype.handleHeaders = co(function* handleHeaders(peer, headers) {
  var unlock = yield this.locker.lock();
  try {
    return yield this._handleHeaders(peer, headers);
  } finally {
    unlock();
  }
});

/**
 * Handle `headers` packet from
 * a given peer without a lock.
 * @private
 * @param {Peer} peer
 * @param {Headers[]} headers
 * @returns {Promise}
 */

Pool.prototype._handleHeaders = co(function* handleHeaders(peer, headers) {
  var i, ret, header, hash, last;

  if (!this.options.headers)
    return;

  if (!this.syncing)
    return;

  ret = new VerifyResult();

  this.logger.debug(
    'Received %s headers from peer (%s).',
    headers.length,
    peer.hostname);

  this.emit('headers', headers);

  for (i = 0; i < headers.length; i++) {
    header = headers[i];
    hash = header.hash('hex');

    if (last && header.prevBlock !== last) {
      peer.increaseBan(100);
      throw new Error('Bad header chain.');
    }

    if (!header.verify(ret)) {
      peer.reject(header, 'invalid', ret.reason, 100);
      throw new Error('Invalid header.');
    }

    last = hash;

    if (yield this.chain.has(hash))
      continue;

    this.getBlock(peer, hash);
  }

  // Schedule the getdata's we just added.
  this.scheduleRequests(peer);

  // Restart the getheaders process
  // Technically `last` is not indexed yet so
  // the locator hashes will not be entirely
  // accurate. However, it shouldn't matter
  // that much since FindForkInGlobalIndex
  // simply tries to find the latest block in
  // the peer's chain.
  if (last && headers.length === 2000)
    yield peer.getHeaders(last);
});

/**
 * Handle `inv` packet from peer (containing only BLOCK types).
 * Potentially request headers if headers mode is enabled.
 * @private
 * @param {Peer} peer
 * @param {Hash[]} hashes
 * @returns {Promise}
 */

Pool.prototype.handleBlockInv = co(function* handleBlockInv(hashes, peer) {
  var unlock = yield this.locker.lock();
  try {
    return yield this._handleBlockInv(peer, hashes);
  } finally {
    unlock();
  }
});

/**
 * Handle `inv` packet from peer without a lock.
 * @private
 * @param {Peer} peer
 * @param {Hash[]} hashes
 * @returns {Promise}
 */

Pool.prototype._handleBlockInv = co(function* handleBlockInv(peer, hashes) {
  var i, hash;

  if (!this.syncing)
    return;

  // Ignore for now if we're still syncing
  if (!this.chain.synced && !peer.isLoader())
    return;

  if (this.options.witness && !peer.haveWitness)
    return;

  // Request headers instead.
  if (this.options.headers) {
    for (i = 0; i < hashes.length; i++) {
      hash = hashes[i];
      yield peer.getHeaders(null, hash);
    }

    this.scheduleRequests(peer);

    return;
  }

  this.logger.debug(
    'Received %s block hashes from peer (%s).',
    hashes.length,
    peer.hostname);

  this.emit('blocks', hashes);

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];

    // Resolve orphan chain.
    if (this.chain.hasOrphan(hash)) {
      // There is a possible race condition here.
      // The orphan may get resolved by the time
      // we create the locator. In that case, we
      // should probably actually move to the
      // `exists` clause below if it is the last
      // hash.
      this.logger.debug('Received known orphan hash (%s).', peer.hostname);
      yield peer.resolveOrphan(null, hash);
      continue;
    }

    // Request the block if we don't have it.
    if (!(yield this.chain.has(hash))) {
      this.getBlock(peer, hash);
      continue;
    }

    // Normally we request the hashContinue.
    // In the odd case where we already have
    // it, we can do one of two things: either
    // force re-downloading of the block to
    // continue the sync, or do a getblocks
    // from the last hash (this will reset
    // the hashContinue on the remote node).
    if (i === hashes.length - 1) {
      this.logger.debug('Received existing hash (%s).', peer.hostname);
      yield peer.getBlocks(hash, null);
    }
  }

  this.scheduleRequests(peer);
});

/**
 * Handle peer inv packet (txs).
 * @private
 * @param {Peer} peer
 * @param {Hash[]} hashes
 */

Pool.prototype.handleTXInv = function handleTXInv(peer, hashes) {
  this.emit('txs', hashes, peer);

  if (this.syncing && !this.chain.synced)
    return;

  this.getTX(peer, hashes);
};

/**
 * Handle peer reject event.
 * @private
 * @param {Peer} peer
 * @param {RejectPacket} reject
 */

Pool.prototype.handleReject = function handleReject(peer, reject) {
  this.logger.warning(
    'Received reject (%s): msg=%s code=%s reason=%s hash=%s.',
    peer.hostname,
    reject.message,
    reject.getCode(),
    reject.reason,
    reject.rhash());

  this.emit('reject', reject, peer);
};

/**
 * Handle peer notfound packet.
 * @private
 * @param {InvItem[]} items
 * @param {Peer} peer
 */

Pool.prototype.handleNotFound = function handleNotFound(peer, items) {
  var i, item;

  for (i = 0; i < items.length; i++) {
    item = items[i];
    this.fulfill(peer, item.hash);
  }
};

/**
 * Handle an alert packet.
 * @private
 * @param {Peer} peer
 * @param {AlertPacket} alert
 */

Pool.prototype.handleAlert = function handleAlert(peer, alert) {
  var now = this.network.now();

  if (!alert.verify(this.network.alertKey)) {
    this.logger.warning('Peer sent a phony alert packet (%s).', peer.hostname);
    // Let's look at it because why not?
    this.logger.debug(alert);
    peer.increaseBan(100);
    return;
  }

  if (now >= alert.expiration) {
    this.logger.warning(
      'Peer sent an expired alert packet (%s).',
      peer.hostname);
    this.logger.debug(alert);
    return;
  }

  if (alert.id === 0x7fffffff) {
    if (!(alert.expiration === 0x7fffffff
        && alert.cancel === 0x7fffffff - 1
        && alert.minVer === 0
        && alert.maxVer === 0x7fffffff
        && alert.subVers.length === 0
        && alert.priority === 0x7fffffff
        && alert.statusBar === 'URGENT: Alert key compromised, upgrade required')) {
      this.logger.warning('Misuse of last alert ID (%s).', peer.hostname);
      this.logger.debug(alert);
      peer.increaseBan(100);
      return;
    }
  }

  // Keep alert disabled on main.
  if (this.network === Network.main) {
    // https://github.com/bitcoin/bitcoin/pull/7692#issuecomment-197967429
    this.logger.warning('The Japanese government sent an alert packet.');
    this.logger.warning('Here is their IP: %s.', peer.hostname);
    this.logger.info(alert);
    peer.increaseBan(100);
    return;
  }

  this.logger.warning('Received alert from peer (%s).', peer.hostname);
  this.logger.warning(alert);

  if (now < alert.relayUntil)
    this.sendAlert(alert);

  this.emit('alert', alert, peer);
};

/**
 * Test the mempool to see if it
 * contains a recent reject.
 * @param {Hash} hash
 * @returns {Boolean}
 */

Pool.prototype.hasReject = function hasReject(hash) {
  if (!this.mempool)
    return false;
  return this.mempool.hasReject(hash);
};

/**
 * Create an inbound peer from an existing socket.
 * @private
 * @param {NetAddress} addr
 * @param {net.Socket} socket
 */

Pool.prototype.addInbound = function addInbound(socket) {
  var peer;

  if (!this.loaded)
    return socket.destroy();

  peer = this.acceptPeer(socket);

  this.logger.info('Added inbound peer (%s).', peer.hostname);

  this.peers.add(peer);

  this.emit('peer', peer);
};

/**
 * Allocate a host from the host list.
 * @param {Boolean} unique
 * @returns {NetAddress}
 */

Pool.prototype.getHost = function getHost(unique) {
  var now = this.network.now();
  var i, entry, addr;

  for (i = 0; i < 100; i++) {
    entry = this.hosts.getHost();

    if (!entry)
      break;

    addr = entry.addr;

    if (unique) {
      if (this.peers.has(addr.hostname))
        continue;
    }

    if (!addr.isValid())
      continue;

    if (!addr.hasServices(this.needed))
      continue;

    if (now - entry.lastAttempt < 600 && i < 30)
      continue;

    if (addr.port !== this.network.port && i < 50)
      continue;

    return entry.addr;
  }
};

/**
 * Create an outbound non-loader peer. These primarily
 * exist for transaction relaying.
 * @private
 */

Pool.prototype.addOutbound = function addOutbound() {
  var peer, addr;

  if (!this.loaded)
    return;

  if (this.peers.outbound >= this.maxOutbound)
    return;

  // Hang back if we don't have a loader peer yet.
  if (!this.peers.load)
    return;

  addr = this.getHost(true);

  if (!addr)
    return;

  peer = this.createPeer(addr);

  this.peers.add(peer);

  this.emit('peer', peer);
};

/**
 * Attempt to refill the pool with peers (no lock).
 * @private
 */

Pool.prototype.fillOutbound = function fillOutbound() {
  var need = this.maxOutbound - this.peers.outbound;
  var i;

  if (!this.peers.load)
    this.addLoader();

  if (need <= 0)
    return;

  this.logger.debug('Refilling peers (%d/%d).',
    this.peers.outbound,
    this.maxOutbound);

  for (i = 0; i < need; i++)
    this.addOutbound();
};

/**
 * Attempt to refill the pool with peers (no lock).
 * @private
 */

Pool.prototype.refill = function refill() {
  var self = this;

  if (this.pendingRefill != null)
    return;

  this.pendingRefill = setTimeout(function() {
    self.pendingRefill = null;
    self.fillOutbound();
  }, 3000);
};

/**
 * Remove a peer from any list. Drop all load requests.
 * @private
 * @param {Peer} peer
 */

Pool.prototype.removePeer = function removePeer(peer) {
  var i, hashes, hash;

  this.peers.remove(peer);

  hashes = Object.keys(peer.requestMap);

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];
    this.fulfill(peer, hash);
  }
};

/**
 * Ban peer.
 * @param {NetAddress} addr
 */

Pool.prototype.ban = function ban(addr) {
  var peer = this.peers.get(addr.hostname);

  this.logger.debug('Banning peer (%s).', addr.hostname);

  this.hosts.ban(addr.host);
  this.hosts.remove(addr.hostname);

  if (peer)
    peer.destroy();
};

/**
 * Unban peer.
 * @param {NetAddress} addr
 */

Pool.prototype.unban = function unban(addr) {
  this.hosts.unban(addr.host);
};

/**
 * Set the spv filter.
 * @param {Bloom} filter
 * @param {String?} enc
 */

Pool.prototype.setFilter = function setFilter(filter) {
  if (!this.options.spv)
    return;

  this.spvFilter = filter;
  this.updateWatch();
};

/**
 * Watch a an address hash (filterload, SPV-only).
 * @param {Buffer|Hash} data
 * @param {String?} enc
 */

Pool.prototype.watch = function watch(data, enc) {
  if (!this.options.spv)
    return;

  this.spvFilter.add(data, enc);
  this.updateWatch();
};

/**
 * Reset the spv filter (filterload, SPV-only).
 */

Pool.prototype.unwatch = function unwatch() {
  if (!this.options.spv)
    return;

  this.spvFilter.reset();
  this.updateWatch();
};

/**
 * Resend the bloom filter to peers.
 */

Pool.prototype.updateWatch = function updateWatch() {
  var self = this;
  var peer;

  if (this.pendingWatch != null)
    return;

  this.pendingWatch = setTimeout(function() {
    self.pendingWatch = null;
    for (peer = self.peers.head(); peer; peer = peer.next)
      peer.updateWatch();
  }, 50);
};

/**
 * Add an address to the bloom filter (SPV-only).
 * @param {Address|Base58Address} address
 */

Pool.prototype.watchAddress = function watchAddress(address) {
  var hash = Address.getHash(address);
  assert(hash, 'Bad address.');
  this.watch(hash);
};

/**
 * Add an outpoint to the bloom filter (SPV-only).
 * @param {Outpoint} outpoint
 */

Pool.prototype.watchOutpoint = function watchOutpoint(outpoint) {
  this.watch(outpoint.toRaw());
};

/**
 * Queue a `getdata` request to be sent. Checks existence
 * in the chain before requesting.
 * @param {Peer} peer
 * @param {Hash} hash - Block hash.
 * @returns {Promise}
 */

Pool.prototype.getBlock = function getBlock(peer, hash) {
  if (!this.loaded)
    return;

  if (!peer.ack)
    throw new Error('Peer handshake not complete (getdata).');

  if (peer.destroyed)
    throw new Error('Peer is destroyed (getdata).');

  if (this.requestMap[hash])
    return;

  peer.queueMap[hash] = true;
};

/**
 * Test whether the chain has or has seen an item.
 * @param {Peer} peer
 * @param {InvType} type
 * @param {Hash} hash
 * @returns {Promise} - Returns Boolean.
 */

Pool.prototype.hasBlock = co(function* hasBlock(hash) {
  // Check the chain.
  if (yield this.chain.has(hash))
    return true;

  // Check the pending requests.
  if (this.requestMap[hash])
    return true;

  return false;
});

/**
 * Queue a `getdata` request to be sent. Checks existence
 * in the mempool before requesting.
 * @param {Peer} peer
 * @param {Hash} hash - TX hash.
 * @returns {Boolean}
 */

Pool.prototype.getTX = function getTX(peer, hashes) {
  var items = [];
  var i, hash;

  if (!this.loaded)
    return;

  if (!peer.ack)
    throw new Error('Peer handshake not complete (getdata).');

  if (peer.destroyed)
    throw new Error('Peer is destroyed (getdata).');

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];

    if (this.hasTX(hash))
      continue;

    assert(!this.requestMap[hash]);

    this.requestMap[hash] = true;
    peer.requestMap[hash] = true;

    this.activeRequests++;

    items.push(hash);
  }

  peer.getTX(items);
};

/**
 * Test whether the mempool has or has seen an item.
 * @param {Peer} peer
 * @param {InvType} type
 * @param {Hash} hash
 * @returns {Promise} - Returns Boolean.
 */

Pool.prototype.hasTX = function hasTX(hash) {
  if (!this.mempool) {
    // Check the TX filter if
    // we don't have a mempool.
    if (!this.txFilter.added(hash, 'hex'))
      return true;
  } else {
    // Check the mempool.
    if (this.mempool.has(hash))
      return true;
  }

  // If we recently rejected this item. Ignore.
  if (this.hasReject(hash)) {
    this.logger.spam('Saw known reject of %s.', util.revHex(hash));
    return true;
  }

  // Check the pending requests.
  if (this.requestMap[hash])
    return true;

  return false;
};

/**
 * Schedule next batch of `getdata` requests for peer.
 * @param {Peer} peer
 * @returns {Promise}
 */

Pool.prototype.scheduleRequests = co(function* scheduleRequests(peer) {
  if (this.scheduled)
    return;

  this.scheduled = true;

  yield this.chain.onDrain();

  this.sendBlockRequests(peer);

  this.scheduled = false;
});

/**
 * Send scheduled requests in the request queues.
 * @private
 * @param {Peer} peer
 */

Pool.prototype.sendBlockRequests = function sendBlockRequests(peer) {
  var queue = Object.keys(peer.queueMap);
  var hashes = [];
  var i, size, hash;

  if (queue.length === 0)
    return;

  if (this.options.spv) {
    if (this.activeRequests >= 2000)
      return;

    size = Math.min(queue.length, 50000);
  } else {
    size = this.network.getBatchSize(this.chain.height);

    if (this.activeRequests >= size)
      return;
  }

  for (i = 0; i < queue.length; i++) {
    hash = queue[i];

    delete peer.queueMap[hash];

    if (this.requestMap[hash])
      continue;

    assert(!this.requestMap[hash]);

    this.requestMap[hash] = true;
    peer.requestMap[hash] = true;

    this.activeRequests++;

    hashes.push(hash);

    if (hashes.length === size)
      break;
  }

  this.logger.debug(
    'Requesting %d/%d blocks from peer with getdata (%s).',
    hashes.length,
    this.activeRequests,
    peer.hostname);

  peer.getBlock(hashes);
};

/**
 * Fulfill a requested item.
 * @param {Peer} peer
 * @param {Hash} hash
 * @returns {Boolean}
 */

Pool.prototype.fulfill = function fulfill(peer, hash) {
  if (!peer.requestMap[hash])
    return false;

  delete peer.requestMap[hash];

  assert(this.requestMap[hash]);
  delete this.requestMap[hash];

  this.activeRequests--;

  return true;
};

/**
 * Broadcast a transaction or block.
 * @param {TX|Block} msg
 * @returns {Promise}
 */

Pool.prototype.broadcast = function broadcast(msg) {
  var hash = msg.hash('hex');
  var item = this.invMap[hash];

  if (item) {
    item.refresh();
    item.announce();
  } else {
    item = new BroadcastItem(this, msg);
    item.start();
    item.announce();
  }

  return new Promise(function(resolve, reject) {
    item.addJob(resolve, reject);
  });
};

/**
 * Announce a block to all peers.
 * @param {Block} tx
 */

Pool.prototype.announceBlock = function announceBlock(msg) {
  var peer;

  for (peer = this.peers.head(); peer; peer = peer.next)
    peer.announceBlock(msg);
};

/**
 * Announce a transaction to all peers.
 * @param {TX} tx
 */

Pool.prototype.announceTX = function announceTX(msg) {
  var peer;

  for (peer = this.peers.head(); peer; peer = peer.next)
    peer.announceTX(msg);
};

/**
 * Set a fee rate filter for all peers.
 * @param {Rate} rate
 */

Pool.prototype.setFeeRate = function setFeeRate(rate) {
  var peer;

  this.feeRate = rate;

  for (peer = this.peers.head(); peer; peer = peer.next)
    peer.sendFeeRate(rate);
};

/**
 * Attempt to retrieve external IP from icanhazip.com.
 * @returns {Promise}
 */

Pool.prototype.getIP = co(function* getIP() {
  var res, ip;

  if (request.unsupported)
    throw new Error('Could not find IP.');

  try {
    res = yield request.promise({
      method: 'GET',
      uri: 'http://icanhazip.com',
      expect: 'txt',
      timeout: 3000
    });
  } catch (e) {
    return yield this.getIP2();
  }

  ip = res.body.trim();

  if (IP.version(ip) === -1)
    return yield this.getIP2();

  return IP.normalize(ip);
});

/**
 * Attempt to retrieve external IP from dyndns.org.
 * @returns {Promise}
 */

Pool.prototype.getIP2 = co(function* getIP2() {
  var res, match, ip;

  if (request.unsupported)
    throw new Error('Could not find IP.');

  res = yield request.promise({
    method: 'GET',
    uri: 'http://checkip.dyndns.org',
    expect: 'html',
    timeout: 3000
  });

  match = /IP Address:\s*([0-9a-f.:]+)/i.exec(res.body);

  if (!match)
    throw new Error('Could not find IP.');

  ip = match[1];

  if (IP.version(ip) === -1)
    throw new Error('Could not parse IP.');

  return IP.normalize(ip);
});

/**
 * Peer List
 * @constructor
 * @param {Object} options
 */

function PeerList(options) {
  this.logger = options.logger;
  this.map = {};
  this.list = new List();
  this.load = null;
  this.inbound = 0;
  this.outbound = 0;
}

/**
 * Get the list head.
 * @returns {Peer}
 */

PeerList.prototype.head = function head() {
  return this.list.head;
};

/**
 * Get the list tail.
 * @returns {Peer}
 */

PeerList.prototype.tail = function tail() {
  return this.list.tail;
};

/**
 * Get list size.
 * @returns {Number}
 */

PeerList.prototype.size = function size() {
  return this.list.size;
};

/**
 * Add peer to list.
 * @param {Peer} peer
 */

PeerList.prototype.add = function add(peer) {
  assert(this.list.push(peer));

  assert(!this.map[peer.hostname]);
  this.map[peer.hostname] = peer;

  if (peer.outbound)
    this.outbound++;
  else
    this.inbound++;
};

/**
 * Remove peer from list.
 * @param {Peer} peer
 */

PeerList.prototype.remove = function remove(peer) {
  assert(this.list.remove(peer));

  assert(this.map[peer.hostname]);
  delete this.map[peer.hostname];

  if (peer.isLoader()) {
    this.logger.info('Removed loader peer (%s).', peer.hostname);
    this.load = null;
  }

  if (peer.outbound)
    this.outbound--;
  else
    this.inbound--;
};

/**
 * Get peer by hostname.
 * @param {String} hostname
 * @returns {Peer}
 */

PeerList.prototype.get = function get(hostname) {
  return this.map[hostname];
};

/**
 * Test whether a peer exists.
 * @param {String} hostname
 * @returns {Boolean}
 */

PeerList.prototype.has = function has(hostname) {
  return this.map[hostname] != null;
};

/**
 * Get peers by host.
 * @param {String} host
 * @returns {Peer[]}
 */

PeerList.prototype.getByHost = function getByHost(host) {
  var peers = [];
  var peer;

  for (peer = this.list.head; peer; peer = peer.next) {
    if (peer.host !== host)
      continue;
    peers.push(peer);
  }

  return peers;
};

/**
 * Destroy peer list (kills peers).
 */

PeerList.prototype.destroy = function destroy() {
  var peer, next;

  this.map = {};
  this.load = null;
  this.inbound = 0;
  this.outbound = 0;

  for (peer = this.list.head; peer; peer = next) {
    next = peer.next;
    peer.destroy();
  }
};

/**
 * Represents an item that is broadcasted via an inv/getdata cycle.
 * @exports BroadcastItem
 * @constructor
 * @private
 * @param {Pool} pool
 * @param {TX|Block} msg
 * @emits BroadcastItem#ack
 * @emits BroadcastItem#reject
 * @emits BroadcastItem#timeout
 */

function BroadcastItem(pool, msg) {
  var item;

  if (!(this instanceof BroadcastItem))
    return new BroadcastItem(pool, msg);

  assert(!msg.mutable, 'Cannot broadcast mutable item.');

  item = msg.toInv();

  this.pool = pool;
  this.hash = item.hash;
  this.type = item.type;
  this.msg = msg;
  this.jobs = [];
}

util.inherits(BroadcastItem, EventEmitter);

/**
 * Add a job to be executed on ack, timeout, or reject.
 * @returns {Promise}
 */

BroadcastItem.prototype.addJob = function addJob(resolve, reject) {
  this.jobs.push(new Job(resolve, reject));
};

/**
 * Start the broadcast.
 */

BroadcastItem.prototype.start = function start() {
  assert(!this.timeout, 'Already started.');
  assert(!this.pool.invMap[this.hash], 'Already started.');

  this.pool.invMap[this.hash] = this;

  this.refresh();

  return this;
};

/**
 * Refresh the timeout on the broadcast.
 */

BroadcastItem.prototype.refresh = function refresh() {
  var self = this;

  if (this.timeout != null) {
    clearTimeout(this.timeout);
    this.timeout = null;
  }

  this.timeout = setTimeout(function() {
    self.emit('timeout');
    self.finish(new Error('Timed out.'));
  }, this.pool.invTimeout);
};

/**
 * Announce the item.
 */

BroadcastItem.prototype.announce = function announce() {
  switch (this.type) {
    case invTypes.TX:
      this.pool.announceTX(this.msg);
      break;
    case invTypes.BLOCK:
      this.pool.announceBlock(this.msg);
      break;
    default:
      assert(false, 'Bad type.');
      break;
  }
};

/**
 * Finish the broadcast, potentially with an error.
 * @param {Error?} err
 */

BroadcastItem.prototype.finish = function finish(err) {
  var i, job;

  assert(this.timeout, 'Already finished.');
  assert(this.pool.invMap[this.hash], 'Already finished.');

  clearTimeout(this.timeout);
  this.timeout = null;

  delete this.pool.invMap[this.hash];

  for (i = 0; i < this.jobs.length; i++) {
    job = this.jobs[i];
    if (err) {
      job.reject(err);
      continue;
    }
    job.resolve();
  }

  this.jobs.length = 0;
};

/**
 * Handle an ack from a peer.
 * @param {Peer} peer
 */

BroadcastItem.prototype.ack = function ack(peer) {
  var self = this;
  var i, job;

  setTimeout(function() {
    self.emit('ack', peer);

    for (i = 0; i < self.jobs.length; i++) {
      job = self.jobs[i];
      job.resolve(true);
    }

    self.jobs.length = 0;
  }, 1000);
};

/**
 * Handle a reject from a peer.
 * @param {Peer} peer
 */

BroadcastItem.prototype.reject = function reject(peer) {
  var i, job;

  this.emit('reject', peer);

  for (i = 0; i < this.jobs.length; i++) {
    job = this.jobs[i];
    job.resolve(false);
  }

  this.jobs.length = 0;
};

/**
 * Inspect the broadcast item.
 * @returns {String}
 */

BroadcastItem.prototype.inspect = function inspect() {
  return '<BroadcastItem:'
    + ' type=' + (this.type === invTypes.TX ? 'tx' : 'block')
    + ' hash=' + util.revHex(this.hash)
    + '>';
};

/**
 * Job
 * @constructor
 */

function Job(resolve, reject) {
  this.resolve = resolve;
  this.reject = reject;
}

/*
 * Expose
 */

module.exports = Pool;
