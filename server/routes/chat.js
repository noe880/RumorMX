const express = require("express");
const router = express.Router();
const redis = require("redis");

// Redis client setup
let redisClient;
let isRedisConnected = false;

try {
  const redisUrl = process.env.REDIS_URL;
  
  if (!redisUrl) {
    console.warn('[Chat] REDIS_URL not set, chat functionality will use fallback');
    redisClient = null;
  } else {
    redisClient = redis.createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) return new Error("Redis max retry attempts reached");
          return Math.min(retries * 100, 3000);
        },
      },
    });

    redisClient.on('error', (err) => {
      console.error('[Chat] Redis Client Error:', err);
      isRedisConnected = false;
    });

    redisClient.on('connect', () => {
      console.log('[Chat] Connected to Redis');
      isRedisConnected = true;
    });

    (async () => {
      try {
        await redisClient.connect();
        isRedisConnected = true;
        console.log('[Chat] Redis client connected');
      } catch (error) {
        console.error('[Chat] Failed to connect to Redis:', error);
        isRedisConnected = false;
      }
    })();
  }
} catch (error) {
  console.error('[Chat] Failed to create Redis client:', error);
  redisClient = null;
}

// Chat zone management
const CHAT_ZONE_PREFIX = 'chat_zone:';
const CHAT_MESSAGE_PREFIX = 'chat_messages:';
const USER_SESSION_PREFIX = 'user_session:';

// Private chat management
const PRIVATE_CHAT_ROOM_PREFIX = 'private_chat_room:';
const PRIVATE_CHAT_SESSION_PREFIX = 'private_chat_session:';
const PRIVATE_CHAT_MESSAGE_PREFIX = 'private_chat_messages:';

// Helper to check Redis availability
function checkRedisAvailable(res) {
  if (!redisClient || !isRedisConnected) {
    res.status(503).json({ error: 'Redis service unavailable' });
    return false;
  }
  return true;
}

// Middleware to ensure Redis is available for all routes
router.use((req, res, next) => {
  if (!redisClient || !isRedisConnected) {
    return res.status(503).json({ error: 'Redis service unavailable' });
  }
  next();
});

// Join chat zone
router.post('/join', async (req, res) => {
  try {
    const { username, gender, zoneId, userId } = req.body;

    if (!username || !gender || !zoneId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Generate or use provided userId
    const finalUserId = userId || generateUserId();

    // Store user session
    const sessionKey = `${USER_SESSION_PREFIX}${finalUserId}`;
    await redisClient.setEx(sessionKey, 86400, JSON.stringify({
      username,
      gender,
      zoneId,
      joinedAt: new Date().toISOString()
    }));

    // Add user to zone
    const zoneKey = `${CHAT_ZONE_PREFIX}${zoneId}`;
    await redisClient.sAdd(zoneKey, finalUserId);

    // Set zone expiration (24 hours)
    await redisClient.expire(zoneKey, 86400);

    // Get current users in zone
    const usersInZone = await redisClient.sMembers(zoneKey);
    const userInfos = [];

    for (const uid of usersInZone) {
      const userSession = await redisClient.get(`${USER_SESSION_PREFIX}${uid}`);
      if (userSession) {
        userInfos.push(JSON.parse(userSession));
      }
    }

    res.json({
      userId: finalUserId,
      usersInZone: userInfos,
      message: `Joined chat zone ${zoneId}`
    });

  } catch (error) {
    console.error('Error joining chat zone:', error);
    res.status(500).json({ error: 'Failed to join chat zone' });
  }
});

// Leave chat zone
router.post('/leave', async (req, res) => {
  try {
    const { userId, zoneId } = req.body;

    if (!userId || !zoneId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Remove user from zone
    const zoneKey = `${CHAT_ZONE_PREFIX}${zoneId}`;
    await redisClient.sRem(zoneKey, userId);

    // Remove user session
    const sessionKey = `${USER_SESSION_PREFIX}${userId}`;
    await redisClient.del(sessionKey);

    res.json({ message: `Left chat zone ${zoneId}` });

  } catch (error) {
    console.error('Error leaving chat zone:', error);
    res.status(500).json({ error: 'Failed to leave chat zone' });
  }
});

// Send message
router.post('/message', async (req, res) => {
  try {
    const { userId, zoneId, message } = req.body;

    if (!userId || !zoneId || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify user is in zone
    const zoneKey = `${CHAT_ZONE_PREFIX}${zoneId}`;
    const isInZone = await redisClient.sIsMember(zoneKey, userId);

    if (!isInZone) {
      return res.status(403).json({ error: 'User not in zone' });
    }

    // Get user info
    const sessionKey = `${USER_SESSION_PREFIX}${userId}`;
    const userSession = await redisClient.get(sessionKey);

    if (!userSession) {
      return res.status(403).json({ error: 'User session expired' });
    }

    const userInfo = JSON.parse(userSession);

    // Create message object
    const messageObj = {
      id: generateMessageId(),
      userId,
      username: userInfo.username,
      gender: userInfo.gender,
      message: message.substring(0, 200), // Limit message length
      timestamp: new Date().toISOString(),
      zoneId
    };

    // Store message in Redis (keep last 100 messages per zone)
    const messagesKey = `${CHAT_MESSAGE_PREFIX}${zoneId}`;
    await redisClient.lPush(messagesKey, JSON.stringify(messageObj));
    await redisClient.lTrim(messagesKey, 0, 99); // Keep only last 100 messages
    await redisClient.expire(messagesKey, 86400); // Expire after 24 hours

    res.json({
      message: 'Message sent',
      messageId: messageObj.id
    });

  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get messages for zone
router.get('/messages/:zoneId', async (req, res) => {
  try {
    const { zoneId } = req.params;
    const { userId, limit = 100 } = req.query;
    const maxLimit = parseInt(limit);

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    // Verify user is in zone
    const zoneKey = `${CHAT_ZONE_PREFIX}${zoneId}`;
    const isInZone = await redisClient.sIsMember(zoneKey, userId);

    if (!isInZone) {
      return res.status(403).json({ error: 'User not in zone' });
    }

    // Get messages
    const messagesKey = `${CHAT_MESSAGE_PREFIX}${zoneId}`;
    const messages = await redisClient.lRange(messagesKey, 0, maxLimit - 1);
    const parsedMessages = messages.map(msg => JSON.parse(msg)).reverse();

    // Get total count for pagination info
    const totalMessages = await redisClient.lLen(messagesKey);

    res.json({
      messages: parsedMessages,
      total: totalMessages,
      hasMore: totalMessages > maxLimit,
      zoneId
    });

  } catch (error) {
    console.error('Error getting messages:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Get users in zone
router.get('/users/:zoneId', async (req, res) => {
  try {
    const { zoneId } = req.params;

    const zoneKey = `${CHAT_ZONE_PREFIX}${zoneId}`;
    const userIds = await redisClient.sMembers(zoneKey);

    const users = [];
    for (const userId of userIds) {
      const sessionKey = `${USER_SESSION_PREFIX}${userId}`;
      const userSession = await redisClient.get(sessionKey);
      if (userSession) {
        const userInfo = JSON.parse(userSession);
        users.push({
          userId,
          username: userInfo.username,
          gender: userInfo.gender,
          joinedAt: userInfo.joinedAt
        });
      }
    }

    res.json({
      users,
      count: users.length,
      zoneId
    });

  } catch (error) {
    console.error('Error getting users:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Get all active chat zones
router.get('/zones', async (req, res) => {
  try {
    const zones = [];

    // 1) Include traditional chat zones that use lat_lng as the zoneId
    const zoneKeys = await redisClient.keys(`${CHAT_ZONE_PREFIX}*`);
    for (const key of zoneKeys) {
      const zoneId = key.replace(CHAT_ZONE_PREFIX, '');
      const userIds = await redisClient.sMembers(key);

      if (userIds.length > 0) {
        // Parse zone coordinates from zoneId (format: lat_lng)
        const [lat, lng] = zoneId.split('_').map(coord => parseFloat(coord));
        if (!isNaN(lat) && !isNaN(lng)) {
          zones.push({
            zoneId,
            lat,
            lng,
            userCount: userIds.length
          });
        }
      }
    }

    // 2) Include waiting private chat rooms so others can see and join them
    const roomKeys = await redisClient.keys(`${PRIVATE_CHAT_ROOM_PREFIX}*`);
    for (const key of roomKeys) {
      const data = await redisClient.get(key);
      if (!data) continue;
      try {
        const room = JSON.parse(data);
        // Only show private rooms that are waiting for a second user
        if (room && room.status === 'waiting' && typeof room.lat === 'number' && typeof room.lng === 'number') {
          zones.push({
            zoneId: room.id,        // e.g. room_...
            lat: room.lat,
            lng: room.lng,
            userCount: room.userCount || 1
          });
        }
      } catch (_) {
        // ignore malformed room data
      }
    }

    res.json({
      zones,
      totalZones: zones.length
    });

  } catch (error) {
    console.error('Error getting chat zones:', error);
    res.status(500).json({ error: 'Failed to get chat zones' });
  }
});

// Private chat endpoints

// Create private chat room
router.post('/private/create', async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing coordinates' });
    }

    const chatRoomId = generateChatRoomId();
    const chatRoom = {
      id: chatRoomId,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      createdAt: new Date().toISOString(),
      userCount: 1,
      status: 'waiting' // waiting for second user
    };

    // Store chat room
    const roomKey = `${PRIVATE_CHAT_ROOM_PREFIX}${chatRoomId}`;
    await redisClient.setEx(roomKey, 3600, JSON.stringify(chatRoom)); // Expire in 1 hour

    res.json({
      chatRoom,
      message: 'Private chat room created'
    });

  } catch (error) {
    console.error('Error creating private chat room:', error);
    res.status(500).json({ error: 'Failed to create private chat room' });
  }
});

// Create and join private chat room (for creator)
router.post('/private/create-and-join', async (req, res) => {
  try {
    const { lat, lng, username, gender } = req.body;

    if (!lat || !lng || !username || !gender) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const chatRoomId = generateChatRoomId();
    const sessionId = generateSessionId();

    // Create chat room
    const chatRoom = {
      id: chatRoomId,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      createdAt: new Date().toISOString(),
      userCount: 1,
      status: 'waiting'
    };

    // Create chat session with creator
    const chatSession = {
      id: sessionId,
      chatRoomId,
      users: [{
        username,
        gender,
        joinedAt: new Date().toISOString()
      }],
      createdAt: new Date().toISOString(),
      status: 'waiting' // waiting for second user
    };

    // Store chat room
    const roomKey = `${PRIVATE_CHAT_ROOM_PREFIX}${chatRoomId}`;
    await redisClient.setEx(roomKey, 3600, JSON.stringify(chatRoom));

    // Store session
    const sessionKey = `${PRIVATE_CHAT_SESSION_PREFIX}${sessionId}`;
    await redisClient.setEx(sessionKey, 3600, JSON.stringify(chatSession));

    // Also store in regular chat zones so it appears on map immediately
    const zoneKey = `${CHAT_ZONE_PREFIX}${chatRoomId}`;
    await redisClient.sAdd(zoneKey, 'creator_placeholder'); // Placeholder user
    await redisClient.expire(zoneKey, 3600);

    res.json({
      chatRoom,
      chatSession,
      message: 'Private chat room created and joined'
    });

  } catch (error) {
    console.error('Error creating and joining private chat:', error);
    res.status(500).json({ error: 'Failed to create and join private chat' });
  }
});

// Join private chat room
router.post('/private/join', async (req, res) => {
  try {
    const { chatRoomId, username, gender } = req.body;

    if (!chatRoomId || !username || !gender) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const roomKey = `${PRIVATE_CHAT_ROOM_PREFIX}${chatRoomId}`;
    const roomData = await redisClient.get(roomKey);

    if (!roomData) {
      return res.status(404).json({ error: 'Chat room not found or expired' });
    }

    const chatRoom = JSON.parse(roomData);

    if (chatRoom.status !== 'waiting') {
      return res.status(400).json({ error: 'Chat room is not available' });
    }

    // Find existing session for this room
    const sessionKeys = await redisClient.keys(`${PRIVATE_CHAT_SESSION_PREFIX}*`);
    let existingSession = null;
    let sessionId = null;

    for (const key of sessionKeys) {
      const sessionData = await redisClient.get(key);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        if (session.chatRoomId === chatRoomId && session.status === 'waiting') {
          existingSession = session;
          sessionId = session.id;
          break;
        }
      }
    }

    if (!existingSession) {
      return res.status(404).json({ error: 'Chat session not found' });
    }

    // Add second user to session
    existingSession.users.push({
      username,
      gender,
      joinedAt: new Date().toISOString()
    });
    existingSession.status = 'active';

    // Update room status
    chatRoom.userCount = 2;
    chatRoom.status = 'active';

    // Save updated data
    await redisClient.setEx(roomKey, 3600, JSON.stringify(chatRoom));
    const sessionKey = `${PRIVATE_CHAT_SESSION_PREFIX}${sessionId}`;
    await redisClient.setEx(sessionKey, 3600, JSON.stringify(existingSession));

    // Remove from regular chat zones (marker should disappear)
    const zoneKey = `${CHAT_ZONE_PREFIX}${chatRoomId}`;
    await redisClient.del(zoneKey);

    res.json({
      chatSession: existingSession,
      userCount: 2,
      message: 'Joined private chat'
    });

  } catch (error) {
    console.error('Error joining private chat:', error);
    res.status(500).json({ error: 'Failed to join private chat' });
  }
});

// Send private chat message
router.post('/private/message', async (req, res) => {
  try {
    const { sessionId, username, gender, message } = req.body;

    if (!sessionId || !username || !gender || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const sessionKey = `${PRIVATE_CHAT_SESSION_PREFIX}${sessionId}`;
    const sessionData = await redisClient.get(sessionKey);

    if (!sessionData) {
      return res.status(404).json({ error: 'Chat session not found or has ended' });
    }

    const chatSession = JSON.parse(sessionData);

    if (chatSession.status !== 'active') {
      return res.status(404).json({ error: 'Chat session has ended' });
    }

    // Create message
    const messageObj = {
      id: generateMessageId(),
      username,
      gender,
      message: message.substring(0, 200),
      timestamp: new Date().toISOString(),
      sessionId
    };

    // Store message
    const messagesKey = `${PRIVATE_CHAT_MESSAGE_PREFIX}${sessionId}`;
    await redisClient.lPush(messagesKey, JSON.stringify(messageObj));
    await redisClient.lTrim(messagesKey, 0, 99); // Keep last 100 messages
    await redisClient.expire(messagesKey, 3600);

    res.json({
      message: 'Message sent',
      messageId: messageObj.id
    });

  } catch (error) {
    console.error('Error sending private message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get private chat messages
router.get('/private/messages/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const sessionKey = `${PRIVATE_CHAT_SESSION_PREFIX}${sessionId}`;
    const sessionData = await redisClient.get(sessionKey);

    if (!sessionData) {
      return res.status(404).json({
        error: 'Chat session not found or has ended',
        ended: true
      });
    }

    const chatSession = JSON.parse(sessionData);

    if (chatSession.status === 'ended') {
      return res.status(404).json({
        error: 'Chat session has ended',
        ended: true
      });
    }

    const messagesKey = `${PRIVATE_CHAT_MESSAGE_PREFIX}${sessionId}`;
    const messages = await redisClient.lRange(messagesKey, 0, 99);
    const parsedMessages = messages.map(msg => JSON.parse(msg)).reverse();

    res.json({
      messages: parsedMessages,
      sessionId,
      active: true
    });

  } catch (error) {
    console.error('Error getting private messages:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Leave private chat
router.post('/private/leave', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing session ID' });
    }

    const sessionKey = `${PRIVATE_CHAT_SESSION_PREFIX}${sessionId}`;
    const sessionData = await redisClient.get(sessionKey);

    if (!sessionData) {
      return res.status(404).json({ error: 'Chat session not found' });
    }

    const chatSession = JSON.parse(sessionData);

    // Mark session as ended
    chatSession.status = 'ended';
    chatSession.endedAt = new Date().toISOString();

    // Delete the session immediately since both users should be disconnected
    await redisClient.del(sessionKey);

    // Delete associated messages immediately
    const messagesKey = `${PRIVATE_CHAT_MESSAGE_PREFIX}${sessionId}`;
    await redisClient.del(messagesKey);

    // Delete the chat room
    const roomKey = `${PRIVATE_CHAT_ROOM_PREFIX}${chatSession.chatRoomId}`;
    await redisClient.del(roomKey);

    // Remove from regular chat zones if still there
    const zoneKey = `${CHAT_ZONE_PREFIX}${chatSession.chatRoomId}`;
    await redisClient.del(zoneKey);

    res.json({
      message: 'Left private chat - session ended for both users',
      ended: true
    });

  } catch (error) {
    console.error('Error leaving private chat:', error);
    res.status(500).json({ error: 'Failed to leave private chat' });
  }
});

// Helper functions
function generateUserId() {
  return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateMessageId() {
  return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateChatRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateSessionId() {
  return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

module.exports = router;