// dependencies
var EventEmitter = require('events').EventEmitter
var DuplexEmitter = require('duplex-emitter')
var extend = require('extend')
var path = require('path')
var uuid = require('hat')
// voxel dependencies
var crunch = require('voxel-crunch')

module.exports = Server

function Server(opts) {
  // force instantiation via `new` keyword 
  if(!(this instanceof Server)) { return new Server(opts) }
  this.initialize(opts)
}

Server.prototype.initialize = function(opts) {
  var self = this
  // server game settings are sent to all
  // new clients when they connect
  var defaults = {
    isClient: false,
    chunkDistance: 2,
    materials: [
      ['grass', 'dirt', 'grass_dirt'],
      'obsidian',
      'brick',
      'grass'
    ],
    worldOrigin: [0, 0, 0],
    controls: { discreteFire: true },
    avatarInitialPosition: [2, 20, 2],
    forwardEvents: [],
  }
  var settings = self.settings = extend({}, defaults, opts)
  var engine = opts.engine
  if (!engine) throw new Error('voxel-server requires engine option set to voxel-engine module')
  
  // prepare a server object to return
  extend(self, new EventEmitter())
  self.forwardEvents = settings.forwardEvents
  var game = self.game = engine(settings)
  var clients = self.clients = {}
  var chunkCache = self.chunkCache = {}

  // send player position/rotation updates
  setInterval(self.sendUpdate.bind(self), 1000/22) // every 45ms

  // forward some events to module consumer
  game.voxels.on('missingChunk', function(chunk){ self.emit('missingChunk',chunk) })

}

// Setup the client connection - register events, etc
Server.prototype.connectClient = function(duplexStream) {
  var self = this
  var settings = self.settings
  var game = self.game
  // create 'connection' remote event emitter from duplex stream
  var connection = DuplexEmitter(duplexStream)
  // register client id
  var id = uuid()
  connection.id = duplexStream.id = id
  self.broadcast(id, 'join', id)
  var client = self.clients[id] = {
    id: id,
    connection: connection,
    player: {
      rotation: new game.THREE.Vector3(),
      position: new game.THREE.Vector3(),
    },
  }

  // setup client response handlers
  self.bindClientEvents(client)

  // send client id and initial game settings
  connection.emit('id', id)
  //connection.emit('settings', settings)
  connection.emit('settings', {}) // settings can contain unserializable objects (ArrayBuffer types, etc. so not sending for now. TODO: make all serializable

}

Server.prototype.removeClient = function(id) {
  var self = this
  var client = self.clients[id]
  delete self.clients[id]
  self.broadcast(id, 'leave', id)
}

Server.prototype.bindClientEvents = function(client) {
  var self = this
  var game = self.game
  var id = client.id
  var connection = client.connection

  // forward chat message
  connection.on('chat', self.handleErrors(function(message) {
    // ignore if no message provided
    if (!message.text) return
    // limit chat message length
    if (message.text.length > 140) message.text = message.text.substr(0, 140)
    self.broadcast(null, 'chat', message)
  }))

  // when user ready ( game created, etc )
  connection.on('created', self.handleErrors(function() {
    // send initial world payload
    self.sendInitialChunks(connection)
    // emit client.created for module consumers
    self.emit('client.created',client)
  }))

  // client sends new position, rotation
  connection.on('state', self.handleErrors(function(state) {
    client.player.rotation.x = state.rotation.x
    client.player.rotation.y = state.rotation.y
    var pos = client.player.position
    var distance = pos.distanceTo(state.position)
    if (distance > 20) {
      var before = pos.clone()
      pos.lerp(state.position, 0.1)
      return
    }
    pos.copy(state.position)
    self.emit('client.state',client,state)
  }))

  // client modifies a block
  var chunkCache = self.chunkCache
  connection.on('set', self.handleErrors(function(pos, val) {
    game.setBlock(pos, val)
    var chunkPos = game.voxels.chunkAtPosition(pos)
    var chunkID = chunkPos.join('|')
    if (chunkCache[chunkID]) delete chunkCache[chunkID]
    // broadcast 'set' to all players
    self.broadcast(null, 'set', pos, val, client.id)
  }))

  // forward custom events
  self.forwardEvents.map(function(eventName) {
    connection.on(eventName,function() {
      var args = [].slice.apply(arguments)
      // add event name
      args.unshift(eventName)
      // add client id
      args.unshift(id)
      self.broadcast.apply(self,args)
    })
  })

}

// send message to all clients
Server.prototype.broadcast = function(id, event) {
  var self = this
  // normalize arguments
  var args = [].slice.apply(arguments)
  // remove client `id` argument
  args.shift()
  // emit on self for module consumers, unless specified not to
  if (id !== 'server') self.emit.apply(self,args)
  Object.keys(self.clients).map(function(clientId) {
    if (clientId === id) return
    // emit over connection
    try {
      var connection = self.clients[clientId].connection
      connection.emit.apply(connection,args)
    } catch (err) {
      console.log('removing erroring client',clientId,err)
      self.removeClient(clientId)
    }
  })
}

// broadcast position, rotation updates for each player
Server.prototype.sendUpdate = function() {
  var self = this
  var clientIds = Object.keys(self.clients)
  if (clientIds.length === 0) return
  var update = {positions:{}, date: +new Date()}
  clientIds.map(function(id) {
    var client = self.clients[id]
    update.positions[id] = {
      position: client.player.position,
      rotation: {
        x: client.player.rotation.x,
        y: client.player.rotation.y,
      },
    }
  })
  self.broadcast(null, 'update', update)
}

// send all the game chunks
Server.prototype.sendInitialChunks = function(connection) {
  var self = this
  var chunks = self.game.voxels.chunks
  var chunkCache = self.chunkCache
  Object.keys(chunks).map(function(chunkID) {
    var chunk = chunks[chunkID]
    var encoded = chunkCache[chunkID]
    if (!encoded) {
      encoded = crunch.encode(chunk.voxels)
      chunkCache[chunkID] = encoded
    }
    connection.emit('chunk', encoded, {
      position: chunk.position,
      dims: chunk.dims,
      length: chunk.voxels.length
    })
  })
  connection.emit('noMoreChunks', true)
}

// utility function
// returns the provided function wrapped in a try-catch
// emits errors to module consumer
Server.prototype.handleErrors = function(func) {
  var self = this
  return function() {
    try {
      return func.apply(this,arguments)
    } catch (error) {
      self.emit('error',error)
    }
  }
}
