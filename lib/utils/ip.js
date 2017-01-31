/*!
 * ip.js - ip utils for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var IP = require('../../vendor/ip');
var assert = require('assert');

/**
 * Parse a hostname.
 * @example
 * IP.parseHost('127.0.0.1:3000');
 * @param {String} addr
 * @param {Number?} fallback - Fallback port.
 * @returns {Object} Contains `host` and `port`.
 */

exports.parseHost = function parseHost(addr, fallback) {
  var port = fallback || 0;
  var parts, host, version;

  assert(typeof addr === 'string');
  assert(addr.length > 0);
  assert(typeof port === 'number');

  if (addr[0] === '[') {
    addr = addr.substring(1);
    parts = addr.split(/\]:?/);
    assert(parts.length === 2);
  } else {
    parts = addr.split(':');
  }

  host = parts[0];
  assert(host.length > 0, 'Bad host.');

  if (parts.length === 2) {
    port = parts[1];
    assert(/^\d+$/.test(port), 'Bad port.');
    port = parseInt(port, 10);
  }

  version = exports.version(host);

  if (version !== -1)
    host = exports.normalize(host);

  return new Address(host, port, version);
};

/**
 * Concatenate a host and port.
 * @param {String} host
 * @param {Number} port
 * @returns {String}
 */

exports.hostname = function hostname(host, port) {
  var version

  assert(typeof host === 'string');
  assert(host.length > 0);
  assert(typeof port === 'number');

  assert(!/[\[\]]/.test(host), 'Bad host.');

  version = exports.version(host);

  if (version !== -1)
    host = exports.normalize(host);

  if (version === 6)
    host = '[' + host + ']';

  return host + ':' + port;
};

/**
 * Test whether a string is an IP address.
 * @param {String?} ip
 * @returns {Number} IP version (4 or 6).
 */

exports.version = function version(ip) {
  assert(typeof ip === 'string');

  if (IP.isV4Format(ip))
    return 4;

  if (IP.isV6Format(ip))
    return 6;

  return -1;
};

/**
 * Test whether a buffer is an ipv4-mapped ipv6 address.
 * @param {Buffer} ip
 * @returns {Boolean}
 */

exports.isMapped = function isMapped(ip) {
  var i;

  assert(Buffer.isBuffer(ip));
  assert(ip.length === 16);

  for (i = 0; i < ip.length - 6; i++) {
    if (ip[i] !== 0)
      return false;
  }

  if (ip[ip.length - 6] !== 0xff && ip[ip.length - 5] !== 0xff)
    return false;

  return true;
};

/**
 * Convert an IP string to a buffer.
 * @param {String} ip
 * @returns {Buffer}
 */

exports.toBuffer = function toBuffer(ip) {
  var out;

  assert(typeof ip === 'string');
  assert(exports.version(ip) !== -1);

  ip = IP.toBuffer(ip);

  if (ip.length === 4) {
    out = new Buffer(16);
    out.fill(0);
    out[10] = 0xff;
    out[11] = 0xff;
    out[12] = ip[0];
    out[13] = ip[1];
    out[14] = ip[2];
    out[15] = ip[3];
    return out;
  }

  return ip;
};

/**
 * Convert a buffer to an ip string.
 * @param {Buffer} ip
 * @returns {String}
 */

exports.toString = function toString(ip) {
  assert(Buffer.isBuffer(ip));
  assert(ip.length === 16);

  if (exports.isMapped(ip)) {
    return ip[ip.length - 4]
      + '.' + ip[ip.length - 3]
      + '.' + ip[ip.length - 2]
      + '.' + ip[ip.length - 1];
  }

  return IP.toString(ip);
};

/**
 * Normalize an ip.
 * @param {String} ip
 * @returns {String}
 */

exports.normalize = function normalize(ip) {
  if (Buffer.isBuffer(ip)) {
    assert(ip.length === 16);
    return exports.toString(ip);
  }
  return exports.toString(exports.toBuffer(ip));
};


/*
 * Helpers
 */

function Address(host, port, version) {
  this.host = host;
  this.port = port;
  this.version = version;
}

/*
 * Expose IP functions.
 */

exports.isV4Format = IP.isV4Format;
exports.isV6Format = IP.isV6Format;
exports.fromPrefixLen = IP.fromPrefixLen;
exports.mask = IP.mask;
exports.cidr = IP.cidr;
exports.subnet = IP.subnet;
exports.cidrSubnet = IP.cidrSubnet;
exports.not = IP.not;
exports.or = IP.or;
exports.isEqual = IP.isEqual;
exports.isPrivate = IP.isPrivate;
exports.isPublic = IP.isPublic;
exports.isLoopback = IP.isLoopback;
exports.loopback = IP.loopback;
exports.address = IP.address;
exports.toLong = IP.toLong;
exports.fromLong = IP.fromLong;
