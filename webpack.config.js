const path = require('path');

//=========================================================
//  ENVIRONMENT VARS
//---------------------------------------------------------
const NODE_ENV = process.env.NODE_ENV || 'development';

const ENV_DEVELOPMENT = NODE_ENV === 'development';
const ENV_PRODUCTION = NODE_ENV === 'production';
const ENV_TEST = NODE_ENV === 'test';

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 3000;

var alias;

if(ENV_DEVELOPMENT) {
    alias = {
      bcoin: __dirname + "/lib/bcoin.js"
    }
}

module.exports = {
    //entry: "./lib/bcoin.js",
  entry: "./browser/index.js",
    output: {
        path: __dirname + '/browser/',
        filename: "bcoin.js",
        libraryTarget: "umd",
        library: "bcoin"
    },
    devtool: 'inline-source-map',
    resolve: {
        alias: alias
    },
    module: {
        noParse: [ 'ws' ],
        loaders: [
            { test: /\.json$/, loader: 'json' }
        ],
        externals: [ 'ws', 'fs' ]
    },
    node: {
        "./lib/http/base": "empty",
        "./lib/http/client": "empty",
        "./lib/http/request": "empty",
        "./lib/http/rpcclient": "empty",
        "./lib/http/server": "empty",
        "./lib/http/wallet": "empty",
        tls: "empty",
        fs: "empty",
        net: "empty",
        child_process: "empty",
        os: "empty",
        "bcoin-native": "empty",
        secp256k1: "empty"
    }
};
