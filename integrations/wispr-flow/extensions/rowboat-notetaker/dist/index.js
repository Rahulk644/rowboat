'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL_VERSION = 1;
const MAX_QUEUE = 256;
const runtimeFile = path.join(os.homedir(), '.rowboat', 'run', 'wispr-notetaker.json');

let socket = null;
let authenticated = false;
let reconnectTimer = null;
let disposed = false;
const queue = [];

function readRuntime() {
  const stat = fs.lstatSync(runtimeFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('Rowboat runtime metadata is not an owner-only regular file');
  }
  const value = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  if (value?.v !== PROTOCOL_VERSION || typeof value.socketPath !== 'string' || typeof value.token !== 'string') {
    throw new Error('Rowboat runtime metadata is incompatible');
  }
  return value;
}

function scheduleReconnect() {
  if (disposed || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 750);
}

function writeLine(value) {
  if (!socket || socket.destroyed || !authenticated) {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(value);
    connect();
    return;
  }
  socket.write(`${JSON.stringify(value)}\n`);
}

function flush() {
  if (!socket || socket.destroyed || !authenticated) return;
  while (queue.length > 0) {
    socket.write(`${JSON.stringify(queue.shift())}\n`);
  }
}

function connect() {
  if (disposed || (socket && !socket.destroyed)) return;
  let runtime;
  try {
    runtime = readRuntime();
  } catch {
    scheduleReconnect();
    return;
  }

  const candidate = net.createConnection(runtime.socketPath);
  socket = candidate;
  authenticated = false;
  candidate.setEncoding('utf8');
  candidate.once('connect', () => {
    candidate.write(`${JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', token: runtime.token })}\n`);
    authenticated = true;
    flush();
  });
  candidate.on('error', () => {});
  candidate.once('close', () => {
    if (socket === candidate) socket = null;
    authenticated = false;
    scheduleReconnect();
  });
}

module.exports.default = {
  async main(flow) {
    connect();
    flow.onNotetakerTranscriptChunk((event) => {
      const meetingId = typeof event?.meetingId === 'string' ? event.meetingId : '';
      const text = typeof event?.chunk?.text === 'string' ? event.chunk.text.trim() : '';
      const name = typeof event?.chunk?.name === 'string' && event.chunk.name.trim()
        ? event.chunk.name.trim()
        : null;
      if (!meetingId || !text) return;
      writeLine({
        v: PROTOCOL_VERSION,
        type: 'chunk',
        meetingId,
        chunk: { name, text },
      });
    });
  },
  dispose() {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.destroy();
    socket = null;
    queue.length = 0;
  },
};
