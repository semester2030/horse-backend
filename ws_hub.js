/**
 * Minimal native WebSocket hub — no external deps.
 * T4 rooms + T4.1 reliability: ConnectionId, SequenceNumber, Replay, Heartbeat.
 *
 * Negotiation event types are unchanged. Reliability fields are additive:
 *   seq, connectionId (on connected), replay (envelope).
 */
'use strict';

const crypto = require('crypto');
const { getTransportConfig } = require('./transport_config');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(secKey) {
  return crypto
    .createHash('sha1')
    .update(String(secKey) + GUID)
    .digest('base64');
}

function encodeTextFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function encodeControlFrame(opcode, payloadBuf) {
  const payload = payloadBuf || Buffer.alloc(0);
  const header = Buffer.alloc(2);
  header[0] = 0x80 | (opcode & 0x0f);
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    const total = headerLen + maskLen + len;
    if (offset + total > buffer.length) break;

    if (opcode === 0x8) {
      messages.push({ type: 'close' });
      offset += total;
      continue;
    }
    if (opcode === 0x9) {
      messages.push({
        type: 'ping',
        payload: buffer.slice(offset + headerLen + maskLen, offset + total),
      });
      offset += total;
      continue;
    }
    if (opcode === 0xa) {
      messages.push({ type: 'pong' });
      offset += total;
      continue;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      let payload = buffer.slice(offset + headerLen + maskLen, offset + total);
      if (masked) {
        const mask = buffer.slice(offset + headerLen, offset + headerLen + 4);
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i += 1) {
          out[i] = payload[i] ^ mask[i % 4];
        }
        payload = out;
      }
      messages.push({
        type: 'text',
        data: payload.toString('utf8'),
      });
    }
    offset += total;
  }
  return { messages, rest: buffer.slice(offset) };
}

/**
 * Per-request monotonic sequencer + replay window.
 * Customer and provider observe the same seq for the same logical event.
 */
function createRoomSequencer(replayWindow) {
  /** @type {Map<string, { nextSeq: number, events: Array<{seq:number, event:object}> }>} */
  const streams = new Map();

  function stream(room) {
    const key = String(room);
    if (!streams.has(key)) {
      streams.set(key, { nextSeq: 1, events: [] });
    }
    return streams.get(key);
  }

  function assignAndStore(room, event) {
    const s = stream(room);
    const seq = s.nextSeq;
    s.nextSeq += 1;
    const sequenced = { ...event, seq };
    s.events.push({ seq, event: sequenced });
    while (s.events.length > replayWindow) {
      s.events.shift();
    }
    return sequenced;
  }

  /**
   * Merge a sequenced event from PostgreSQL fan-out (cross-instance).
   */
  function storeAt(room, seq, event) {
    const s = stream(room);
    const n = Number(seq);
    if (!Number.isFinite(n) || n <= 0) return { ...event, seq: n };
    const sequenced = { ...event, seq: n };
    if (s.nextSeq <= n) s.nextSeq = n + 1;
    const idx = s.events.findIndex((e) => e.seq === n);
    if (idx >= 0) {
      s.events[idx] = { seq: n, event: sequenced };
    } else {
      s.events.push({ seq: n, event: sequenced });
      s.events.sort((a, b) => a.seq - b.seq);
    }
    while (s.events.length > replayWindow) {
      s.events.shift();
    }
    return sequenced;
  }

  /**
   * Events with seq > afterSeq, in ascending order. No duplicates.
   */
  function replayAfter(room, afterSeq) {
    const s = streams.get(String(room));
    if (!s) return [];
    const floor = Number(afterSeq);
    const min = Number.isFinite(floor) ? floor : 0;
    return s.events
      .filter((e) => e.seq > min)
      .sort((a, b) => a.seq - b.seq)
      .map((e) => e.event);
  }

  function currentSeq(room) {
    const s = streams.get(String(room));
    return s ? s.nextSeq - 1 : 0;
  }

  return { assignAndStore, storeAt, replayAfter, currentSeq, _streams: streams };
}

function isSequencedRoom(room) {
  const r = String(room);
  return r.startsWith('request:') || r.startsWith('auction:') || r.startsWith('haraj-room:');
}

function createWsHub(options = {}) {
  const { resolveUserFromToken, canSubscribeRoom } = options;
  const cfg = options.config || getTransportConfig();
  const replayWindow = cfg.wsReplayWindow;
  const heartbeatMs = cfg.wsHeartbeatMs;
  const heartbeatTimeoutMs = cfg.wsHeartbeatTimeoutMs;
  const sequencer = createRoomSequencer(replayWindow);
  /** @type {null | { replayToClient: Function }} */
  let auctionCrossInstance = null;

  /** @type {Map<string, Set<object>>} */
  const rooms = new Map();
  const clients = new Set();

  function joinRoom(client, room) {
    const r = String(room);
    client.rooms.add(r);
    if (!rooms.has(r)) rooms.set(r, new Set());
    rooms.get(r).add(client);
  }

  /** Unique authenticated userIds in room (multi-device = 1). Ephemeral only. */
  function roomUniqueUserCount(room) {
    const set = rooms.get(String(room));
    if (!set || set.size === 0) return 0;
    const ids = new Set();
    for (const c of set) {
      if (c?.userId) ids.add(String(c.userId));
    }
    return ids.size;
  }

  function auctionLiveViewers(auctionId) {
    if (!auctionId) return 0;
    return roomUniqueUserCount(`auction:${auctionId}`);
  }

  /**
   * Ephemeral liveViewers fan-out — NOT sequenced (no replay/SoT).
   * Multi-device same userId counts as 1.
   */
  function publishAuctionPresence(auctionId, liveViewersOverride) {
    if (!auctionId) return null;
    const room = `auction:${auctionId}`;
    const liveViewers =
      liveViewersOverride != null
        ? Number(liveViewersOverride) || 0
        : auctionLiveViewers(auctionId);
    const event = {
      type: 'auction.presence',
      auctionId: String(auctionId),
      liveViewers,
      presenceAvailable: true,
      serverTimestamp: new Date().toISOString(),
    };
    publish(room, event);
    return event;
  }

  function leaveAll(client) {
    if (client._heartbeatTimer) {
      clearInterval(client._heartbeatTimer);
      client._heartbeatTimer = null;
    }
    const auctionIds = [];
    for (const r of client.rooms) {
      if (String(r).startsWith('auction:')) {
        auctionIds.push(String(r).slice('auction:'.length));
      }
      const set = rooms.get(r);
      if (set) {
        set.delete(client);
        if (set.size === 0) rooms.delete(r);
      }
    }
    client.rooms.clear();
    clients.delete(client);
    for (const id of auctionIds) {
      publishAuctionPresence(id);
    }
  }

  function safeSend(client, payload) {
    try {
      client.send(
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      );
      return true;
    } catch (_) {
      leaveAll(client);
      return false;
    }
  }

  function publish(room, event) {
    const set = rooms.get(String(room));
    if (!set || set.size === 0) return 0;
    const payload = JSON.stringify(event);
    let n = 0;
    for (const client of [...set]) {
      if (safeSend(client, payload)) n += 1;
    }
    return n;
  }

  /** Fan-out pre-sequenced auction event without re-assigning seq. */
  function publishSequenced(room, sequencedEvent) {
    return publish(room, sequencedEvent);
  }

  function setAuctionCrossInstance(bridge) {
    auctionCrossInstance = bridge;
  }

  /**
   * Assign one seq on request:{id} stream, fan-out identical sequenced event.
   * Guarantees Offer → Counter → Accept → Reject → Withdraw → Expire order.
   */
  /**
   * Phase 3 — sequenced auction room stream (transport only; REST/Postgres truth).
   */
  function publishAuction(event) {
    const auctionId = event.auctionId;
    if (!auctionId) return event;
    if (auctionCrossInstance && typeof auctionCrossInstance.append === 'function') {
      void auctionCrossInstance.append(event).catch((err) => {
        console.error('[ws_hub] auction cross-instance append failed:', err.message);
      });
      return event;
    }
    const room = `auction:${auctionId}`;
    const sequenced = sequencer.assignAndStore(room, {
      ...event,
      serverTimestamp: event.serverTimestamp || new Date().toISOString(),
    });
    publish(room, sequenced);
    return sequenced;
  }

  async function publishAuctionAsync(event) {
    const auctionId = event.auctionId;
    if (!auctionId) return event;
    if (auctionCrossInstance && typeof auctionCrossInstance.append === 'function') {
      return await auctionCrossInstance.append(event);
    }
    return publishAuction(event);
  }

  function publishHarajRoom(event) {
    const roomSessionId = event.roomSessionId;
    if (!roomSessionId) return event;
    const room = `haraj-room:${roomSessionId}`;
    const sequenced = sequencer.assignAndStore(room, {
      ...event,
      room,
      serverTimestamp: event.serverTimestamp || new Date().toISOString(),
    });
    publish(room, sequenced);
    return sequenced;
  }

  function handleSequencedSubscribe(client, room, data, { resume = false } = {}) {
    if (!isSequencedRoom(room)) return;
    const run = async () => {
      if (canSubscribeRoom) {
        let allowed = false;
        try {
          allowed = await canSubscribeRoom(client, room);
        } catch (_) {
          allowed = false;
        }
        if (!allowed) {
          safeSend(client, {
            type: 'subscribe.denied',
            room,
            code: 'SUBSCRIBE_FORBIDDEN',
          });
          return;
        }
      }
      joinRoom(client, room);
      const last =
        data.lastReceivedSequence != null
          ? Number(data.lastReceivedSequence)
          : data.lastSeq != null
            ? Number(data.lastSeq)
            : 0;
      const floor = Number.isFinite(last) ? last : 0;
      client.lastReceivedSequenceByRoom.set(room, floor);
      let curSeq = sequencer.currentSeq(room);
      if (
        auctionCrossInstance &&
        typeof auctionCrossInstance.currentSeq === 'function' &&
        String(room).startsWith('auction:')
      ) {
        const auctionId = String(room).slice('auction:'.length);
        curSeq = await auctionCrossInstance.currentSeq(auctionId);
      }
      if (resume) {
        safeSend(client, {
          type: 'resume.ack',
          room,
          connectionId: client.connectionId,
          lastReceivedSequence: floor,
          currentSeq: curSeq,
        });
      } else {
        safeSend(client, {
          type: 'subscribed',
          room,
          connectionId: client.connectionId,
          currentSeq: curSeq,
        });
      }
      if (Number.isFinite(floor) && floor >= 0) {
        replayToClient(client, room, floor);
      }
      // Presence after join — reconnect does not create a qualified view.
      if (String(room).startsWith('auction:')) {
        const auctionId = String(room).slice('auction:'.length);
        publishAuctionPresence(auctionId);
      }
    };
    void run();
  }

  function publishNegotiation(event) {
    const requestId = event.requestId;
    if (!requestId) {
      publish(`customer:${event.customerId}`, event);
      publish(`provider:${event.providerId}`, event);
      return event;
    }
    const room = `request:${requestId}`;
    const sequenced = sequencer.assignAndStore(room, {
      ...event,
      at: event.at || new Date().toISOString(),
    });
    publish(room, sequenced);
    if (event.customerId) {
      publish(`customer:${event.customerId}`, sequenced);
    }
    if (event.providerId) {
      publish(`provider:${event.providerId}`, sequenced);
    }
    return sequenced;
  }

  function replayToClient(client, room, lastReceivedSequence) {
    if (
      auctionCrossInstance &&
      typeof auctionCrossInstance.replayToClient === 'function' &&
      String(room).startsWith('auction:')
    ) {
      void auctionCrossInstance.replayToClient(client, room, lastReceivedSequence);
      return 0;
    }
    const missed = sequencer.replayAfter(room, lastReceivedSequence);
    if (missed.length === 0) {
      safeSend(client, {
        type: 'replay.complete',
        room,
        lastReceivedSequence: Number(lastReceivedSequence) || 0,
        currentSeq: sequencer.currentSeq(room),
        replayed: 0,
      });
      return 0;
    }
    safeSend(client, {
      type: 'replay.begin',
      room,
      fromSeq: missed[0].seq,
      toSeq: missed[missed.length - 1].seq,
      count: missed.length,
    });
    for (const ev of missed) {
      safeSend(client, { ...ev, replay: true });
    }
    safeSend(client, {
      type: 'replay.complete',
      room,
      lastReceivedSequence: missed[missed.length - 1].seq,
      currentSeq: sequencer.currentSeq(room),
      replayed: missed.length,
    });
    return missed.length;
  }

  function startHeartbeat(client, socket) {
    client.lastPongAt = Date.now();
    client._heartbeatTimer = setInterval(() => {
      if (!clients.has(client)) return;
      const idle = Date.now() - (client.lastPongAt || 0);
      if (idle > heartbeatTimeoutMs) {
        leaveAll(client);
        try {
          socket.end();
        } catch (_) {
          /* ignore */
        }
        return;
      }
      try {
        socket.write(encodeControlFrame(0x9, Buffer.from('hb')));
        safeSend(client, {
          type: 'ping',
          at: new Date().toISOString(),
          connectionId: client.connectionId,
        });
      } catch (_) {
        leaveAll(client);
      }
    }, heartbeatMs);
    if (typeof client._heartbeatTimer.unref === 'function') {
      client._heartbeatTimer.unref();
    }
  }

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws' && url.pathname !== '/ws/') {
      socket.destroy();
      return;
    }
    const token =
      url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = resolveUserFromToken(token);
    if (!user || !user.id) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const secKey = req.headers['sec-websocket-key'];
    if (!secKey) {
      socket.destroy();
      return;
    }

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(secKey)}`,
      '',
      '',
    ].join('\r\n');
    socket.write(headers);
    if (head && head.length) socket.unshift(head);

    const connectionId = crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');

    const client = {
      connectionId,
      userId: String(user.id),
      rooms: new Set(),
      lastPongAt: Date.now(),
      lastReceivedSequenceByRoom: new Map(),
      send(text) {
        socket.write(encodeTextFrame(text));
      },
    };
    clients.add(client);
    joinRoom(client, `customer:${client.userId}`);
    joinRoom(client, `provider:${client.userId}`);
    startHeartbeat(client, socket);

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest } = decodeFrames(buf);
      buf = rest;
      for (const msg of messages) {
        if (msg.type === 'close') {
          leaveAll(client);
          socket.end();
          return;
        }
        if (msg.type === 'ping') {
          socket.write(encodeControlFrame(0xa, msg.payload || Buffer.alloc(0)));
          client.lastPongAt = Date.now();
          continue;
        }
        if (msg.type === 'pong') {
          client.lastPongAt = Date.now();
          continue;
        }
        if (msg.type !== 'text') continue;
        let data;
        try {
          data = JSON.parse(msg.data);
        } catch (_) {
          continue;
        }
        if (data.type === 'pong') {
          client.lastPongAt = Date.now();
          continue;
        }
        if (data.type === 'ping') {
          safeSend(client, {
            type: 'pong',
            at: new Date().toISOString(),
            connectionId: client.connectionId,
          });
          continue;
        }
        if (data.type === 'subscribe' && data.room) {
          handleSequencedSubscribe(client, String(data.room), data, { resume: false });
        }
        if (data.type === 'resume' && data.room) {
          handleSequencedSubscribe(client, String(data.room), data, { resume: true });
        }
      }
    });
    socket.on('close', () => leaveAll(client));
    socket.on('error', () => leaveAll(client));

    safeSend(client, {
      type: 'connected',
      connectionId: client.connectionId,
      userId: client.userId,
      at: new Date().toISOString(),
      heartbeatMs,
      resumeSupported: true,
    });
  }

  return {
    handleUpgrade,
    publish,
    publishSequenced,
    publishNegotiation,
    publishAuction,
    publishAuctionAsync,
    publishHarajRoom,
    publishAuctionPresence,
    setAuctionCrossInstance,
    replayAfter: sequencer.replayAfter,
    currentSeq: sequencer.currentSeq,
    safeSend,
    clientCount: () => clients.size,
    roomUniqueUserCount,
    auctionLiveViewers,
    _sequencer: sequencer,
    _rooms: rooms,
    _joinRoom: joinRoom,
  };
}

module.exports = { createWsHub, createRoomSequencer, isSequencedRoom };
