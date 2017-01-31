/*!
 * netaddress.js - network address object for bcoin
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var assert = require('assert');
var constants = require('../protocol/constants');
var Network = require('../protocol/network');
var util = require('../utils/util');
var IP = require('../utils/ip');
var StaticWriter = require('../utils/staticwriter');
var BufferReader = require('../utils/reader');

/**
 * Represents a network address.
 * @exports NetAddress
 * @constructor
 * @param {Object} options
 * @param {Number?} options.ts - Timestamp.
 * @param {Number?} options.services - Service bits.
 * @param {String?} options.host - IP address (IPv6 or IPv4).
 * @param {Number?} options.port - Port.
 * @property {Host} host
 * @property {Number} port
 * @property {Number} services
 * @property {Number} ts
 */

function NetAddress(options) {
  if (!(this instanceof NetAddress))
    return new NetAddress(options);

  this.host = '0.0.0.0';
  this.port = 0;
  this.services = 0;
  this.ts = 0;
  this.hostname = '0.0.0.0:0';

  if (options)
    this.fromOptions(options);
}

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

NetAddress.prototype.fromOptions = function fromOptions(options) {
  assert(typeof options.host === 'string');
  assert(typeof options.port === 'number');

  assert(IP.version(options.host) !== -1);

  this.host = IP.normalize(options.host);
  this.port = options.port;

  if (options.services) {
    assert(typeof options.services === 'number');
    this.services = options.services;
  }

  if (options.ts) {
    assert(typeof options.ts === 'number');
    this.ts = options.ts;
  }

  this.hostname = IP.hostname(this.host, this.port);

  return this;
};

/**
 * Instantiate network address from options.
 * @param {Object} options
 * @returns {NetAddress}
 */

NetAddress.fromOptions = function fromOptions(options) {
  return new NetAddress().fromOptions(options);
};

/**
 * Test whether the NETWORK service bit is set.
 * @returns {Boolean}
 */

NetAddress.prototype.hasNetwork = function hasNetwork() {
  return (this.services & constants.services.NETWORK) !== 0;
};

/**
 * Test whether the BLOOM service bit is set.
 * @returns {Boolean}
 */

NetAddress.prototype.hasBloom = function hasBloom() {
  return (this.services & constants.services.BLOOM) !== 0;
};

/**
 * Test whether the GETUTXO service bit is set.
 * @returns {Boolean}
 */

NetAddress.prototype.hasUTXO = function hasUTXO() {
  return (this.services & constants.services.GETUTXO) !== 0;
};

/**
 * Test whether the WITNESS service bit is set.
 * @returns {Boolean}
 */

NetAddress.prototype.hasWitness = function hasWitness() {
  return (this.services & constants.services.WITNESS) !== 0;
};

/**
 * Test whether the host is null.
 * @returns {Boolean}
 */

NetAddress.prototype.isNull = function isNull() {
  return this.host === '0.0.0.0' || this.host === '::';
};

/**
 * Set host.
 * @param {String} host
 */

NetAddress.prototype.setHost = function setHost(host) {
  this.host = host;
  this.hostname = IP.hostname(host, this.port);
};

/**
 * Set port.
 * @param {Number} port
 */

NetAddress.prototype.setPort = function setPort(port) {
  this.port = port;
  this.hostname = IP.hostname(this.host, port);
};

/**
 * Inject properties from host, port, and network.
 * @private
 * @param {String} host
 * @param {Number} port
 * @param {(Network|NetworkType)?} network
 */

NetAddress.prototype.fromHost = function fromHost(host, port, network) {
  network = Network.get(network);

  assert(IP.version(host) !== -1);

  this.host = host;
  this.port = port || network.port;
  this.services = constants.services.NETWORK | constants.services.WITNESS;
  this.ts = network.now();

  this.hostname = IP.hostname(this.host, this.port);

  return this;
};

/**
 * Instantiate a network address
 * from a host and port.
 * @param {String} host
 * @param {Number} port
 * @param {(Network|NetworkType)?} network
 * @returns {NetAddress}
 */

NetAddress.fromHost = function fromHost(host, port, network) {
  return new NetAddress().fromHost(host, port, network);
};

/**
 * Inject properties from hostname and network.
 * @private
 * @param {String} hostname
 * @param {(Network|NetworkType)?} network
 */

NetAddress.prototype.fromHostname = function fromHostname(hostname, network) {
  var addr;

  network = Network.get(network);

  addr = IP.parseHost(hostname, network.port);

  return this.fromHost(addr.host, addr.port, network);
};

/**
 * Instantiate a network address
 * from a hostname (i.e. 127.0.0.1:8333).
 * @param {String} hostname
 * @param {(Network|NetworkType)?} network
 * @returns {NetAddress}
 */

NetAddress.fromHostname = function fromHostname(hostname, network) {
  return new NetAddress().fromHostname(hostname, network);
};

/**
 * Inject properties from socket.
 * @private
 * @param {net.Socket} socket
 */

NetAddress.prototype.fromSocket = function fromSocket(socket, network) {
  var host = socket.remoteAddress;
  var port = socket.remotePort;
  assert(typeof host === 'string');
  assert(typeof port === 'number');
  return this.fromHost(IP.normalize(host), port, network);
};

/**
 * Instantiate a network address
 * from a socket.
 * @param {net.Socket} socket
 * @returns {NetAddress}
 */

NetAddress.fromSocket = function fromSocket(hostname, network) {
  return new NetAddress().fromSocket(hostname, network);
};

/**
 * Inject properties from buffer reader.
 * @private
 * @param {BufferReader} br
 * @param {Boolean?} full - Include timestamp.
 */

NetAddress.prototype.fromReader = function fromReader(br, full) {
  this.ts = full ? br.readU32() : 0;
  this.services = br.readU53();
  this.host = IP.toString(br.readBytes(16, true));
  this.port = br.readU16BE();
  this.hostname = IP.hostname(this.host, this.port);
  return this;
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} data
 * @param {Boolean?} full - Include timestamp.
 */

NetAddress.prototype.fromRaw = function fromRaw(data, full) {
  return this.fromReader(new BufferReader(data), full);
};

/**
 * Insantiate a network address from buffer reader.
 * @param {BufferReader} br
 * @param {Boolean?} full - Include timestamp.
 * @returns {NetAddress}
 */

NetAddress.fromReader = function fromReader(br, full) {
  return new NetAddress().fromReader(br, full);
};

/**
 * Insantiate a network address from serialized data.
 * @param {Buffer} data
 * @param {Boolean?} full - Include timestamp.
 * @returns {NetAddress}
 */

NetAddress.fromRaw = function fromRaw(data, full) {
  return new NetAddress().fromRaw(data, full);
};

/**
 * Write network address to a buffer writer.
 * @param {BufferWriter} bw
 * @param {Boolean?} full - Include timestamp.
 * @returns {Buffer}
 */

NetAddress.prototype.toWriter = function toWriter(bw, full) {
  if (full)
    bw.writeU32(this.ts);

  bw.writeU64(this.services);
  bw.writeBytes(IP.toBuffer(this.host));
  bw.writeU16BE(this.port);

  return bw;
};

/**
 * Calculate serialization size of address.
 * @returns {Number}
 */

NetAddress.prototype.getSize = function getSize(full) {
  return 26 + (full ? 4 : 0);
};

/**
 * Serialize network address.
 * @param {Boolean?} full - Include timestamp.
 * @returns {Buffer}
 */

NetAddress.prototype.toRaw = function toRaw(full) {
  var size = this.getSize(full);
  return this.toWriter(new StaticWriter(size), full).render();
};

/**
 * Inspect the network address.
 * @returns {Object}
 */

NetAddress.prototype.inspect = function inspect() {
  return '<NetAddress:'
    + ' hostname=' + this.hostname
    + ' services=' + this.services.toString(2)
    + ' date=' + util.date(this.ts)
    + '>';
};

/*
 * Expose
 */

module.exports = NetAddress;
