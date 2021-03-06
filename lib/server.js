'use strict'

const debug = require('debug')('bfx:hf:data-server')
const _isFunction = require('lodash/isFunction')
const { RESTv2 } = require('bfx-api-node-rest')
const { WSv2 } = require('bitfinex-api-node')
const { nonce } = require('bfx-api-node-util')
const WS = require('ws')

const getCandles = require('./cmds/get_candles')
const getMarkets = require('./cmds/get_markets')
const getTrades = require('./cmds/get_trades')
const getBTs = require('./cmds/get_bts')
const execBT = require('./cmds/exec_bt')
const submitBT = require('./cmds/submit_bt')
const proxyBFXMessage = require('./cmds/proxy_bfx_message')
const send = require('./wss/send')

const COMMANDS = {
  'exec.bt': execBT,
  'get.bts': getBTs,
  'get.markets': getMarkets,
  'get.candles': getCandles,
  'get.trades': getTrades,
  'submit.bt': submitBT,
  'bfx': proxyBFXMessage
}

module.exports = class DataServer {
  /**
   * @param {Object} args
   * @param {string} apiKey - for bfx proxy
   * @param {string} apiSecret - for bfx proxy
   * @param {Object} agent - optional proxy agent for bfx proxy connection
   * @param {string} wsURL - bitfinex websocket API URL
   * @param {string} restURL - bitfinex RESTv2 API URL
   * @param {boolean} transform - for bfx proxy
   * @param {boolean} proxy - if true, a bfx proxy will be opened for every client
   * @param {number} port - websocket server port
   */
  constructor ({
    apiKey,
    apiSecret,
    agent,
    restURL,
    wsURL,
    transform,
    proxy,
    port
  } = {}) {
    this.wssClients = {}
    this.bfxProxies = {} // one per client ID if enabled
    this.bfxProxyEnabled = proxy
    this.bfxProxyParams = {
      url: wsURL,
      apiKey,
      apiSecret,
      transform,
      agent
    }

    this.rest = new RESTv2({
      transform: true,
      url: restURL,
    })

    this.wss = new WS.Server({
      clientTracking: true,
      port
    })

    this.wss.on('connection', this.onWSConnected.bind(this))

    debug('websocket API open on port %d', port)
  }

  close () {
    this.wss.close()
  }

  onWSConnected (ws) {
    debug('ws client connected')

    const clientID = nonce()

    this.wssClients[clientID] = ws

    ws.on('message', this.onWSMessage.bind(this, clientID))
    ws.on('close', this.onWSDisconnected.bind(this, clientID))

    if (this.bfxProxyEnabled) {
      this.bfxProxies[clientID] = this.openBFXProxy(clientID)
    }

    send(ws, ['connected'])
  }

  onWSDisconnected (clientID) {
    debug('ws client %s disconnected', clientID)

    delete this.wssClients[clientID]

    if (this.bfxProxies[clientID]) {
      this.bfxProxies[clientID].close()
      delete this.bfxProxies[clientID]
    }
  }

  onWSMessage (clientID, msgJSON = '') {
    let msg

    try {
      msg = JSON.parse(msgJSON)
    } catch (e) {
      debug('error reading ws client msg: %s', msgJSON)
    }

    if (!Array.isArray(msg)) {
      debug('ws client msg not an array: %j', msg)
      return
    }

    const [ cmd ] = msg
    const handler = COMMANDS[cmd]
    const ws = this.wssClients[clientID]

    if (!_isFunction(handler)) {
      debug('received unknown command: %s', cmd)
      return
    }

    return handler(this, ws, msg, clientID)
  }

  openBFXProxy (clientID) {
    const proxy = new WSv2(this.bfxProxyParams)

    proxy.on('message', (msg) => {
      const ws = this.wssClients[clientID]

      if (ws.readyState !== 1) {
        return
      }

      debug('proxying message %j to client %s', msg, clientID)

      ws.send(JSON.stringify(['bfx', msg]))
    })

    proxy.on('open', () => {
      debug('bfx proxy connection opened')
    })

    proxy.on('auth', () => {
      debug('bfx proxy connection authenticated')
    })

    proxy.on('close', () => {
      debug('bfx proxy connection closed')
    })

    proxy.once('open', () => {
      if (this.bfxProxyParams.apiKey && this.bfxProxyParams.apiSecret) {
        proxy.auth()
      }
    })

    proxy.open()

    return proxy
  }
}
