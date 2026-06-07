import { randomUUID } from 'node:crypto';

export class SessionStore {
  constructor({ sessions = [], maxEventsPerSession = 500 } = {}) {
    this.sessions = new Map();
    this.events = [];
    this.maxEventsPerSession = maxEventsPerSession;
    for (const session of sessions) {
      const normalized = normalizePersistedSession(session);
      if (normalized) {
        this.sessions.set(normalized.id, normalized);
      }
    }
  }

  createSession({ thread, request, config }) {
    const now = new Date().toISOString();
    const threadId = thread.id;
    const session = {
      id: threadId,
      threadId,
      appId: request.appId ?? null,
      codexSessionId: thread.sessionId ?? threadId,
      name: request.name || previewName(request.initialPrompt) || config.ui.defaultSessionName,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      cwd: request.cwd || config.codex.cwd,
      model: request.model ?? config.codex.model,
      effort: request.effort ?? config.codex.effort,
      speed: request.speed ?? config.codex.speed,
      approvalPolicy: request.approvalPolicy ?? config.codex.approvalPolicy,
      sandbox: request.sandbox ?? config.codex.sandbox,
      ephemeral: request.ephemeral ?? config.codex.ephemeral,
      thread,
      messages: [],
      turns: [],
      events: [],
      activeTurnId: null,
      lastError: null,
    };
    this.sessions.set(threadId, session);
    return session;
  }

  upsertResumedSession({ thread, request, config }) {
    const existing = this.sessions.get(thread.id);
    if (existing) {
      existing.thread = thread;
      existing.status = 'ready';
      existing.updatedAt = new Date().toISOString();
      return existing;
    }
    return this.createSession({ thread, request, config });
  }

  get(id) {
    return this.sessions.get(id);
  }

  require(id) {
    const session = this.get(id);
    if (!session) {
      const error = new Error(`未知 session：${id}`);
      error.statusCode = 404;
      throw error;
    }
    return session;
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  toJSON() {
    return this.list().map((session) => ({
      id: session.id,
      threadId: session.threadId,
      appId: session.appId,
      codexSessionId: session.codexSessionId,
      name: session.name,
      status: session.status,
      runtimeStatus: session.runtimeStatus,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
      speed: session.speed,
      approvalPolicy: session.approvalPolicy,
      sandbox: session.sandbox,
      ephemeral: session.ephemeral,
      thread: session.thread,
      messages: session.messages,
      turns: session.turns,
      events: session.events.slice(-80),
      activeTurnId: session.activeTurnId,
      lastError: session.lastError,
      tokenUsage: session.tokenUsage,
    }));
  }

  addUserMessage(session, { text, input, turnId = null }) {
    const now = new Date().toISOString();
    const message = {
      id: randomUUID(),
      role: 'user',
      turnId,
      text: text ?? textFromInput(input),
      input: input ?? null,
      createdAt: now,
    };
    session.messages.push(message);
    session.updatedAt = now;
    return message;
  }

  beginTurn(session, { turn, input }) {
    const now = new Date().toISOString();
    const turnRecord = {
      id: turn.id,
      status: turn.status ?? 'running',
      input,
      startedAt: now,
      completedAt: null,
      assistantMessageId: randomUUID(),
    };
    session.turns.push(turnRecord);
    session.activeTurnId = turn.id;
    session.status = 'running';
    session.updatedAt = now;
    session.messages.push({
      id: turnRecord.assistantMessageId,
      role: 'assistant',
      turnId: turn.id,
      text: '',
      status: 'streaming',
      createdAt: now,
      updatedAt: now,
    });
    return turnRecord;
  }

  appendAssistantDelta({ threadId, turnId, delta }) {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    const message = session.messages.find((item) => item.role === 'assistant' && item.turnId === turnId);
    if (!message) {
      return;
    }
    const now = new Date().toISOString();
    message.text += delta ?? '';
    message.updatedAt = now;
    session.updatedAt = now;
  }

  completeTurn({ threadId, turn }) {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    const now = new Date().toISOString();
    const turnRecord = session.turns.find((item) => item.id === turn.id);
    if (turnRecord) {
      turnRecord.status = turn.status ?? 'completed';
      turnRecord.completedAt = now;
      turnRecord.turn = turn;
    }
    const message = session.messages.find((item) => item.role === 'assistant' && item.turnId === turn.id);
    if (message) {
      message.status = turn.status === 'interrupted' ? 'interrupted' : 'done';
      message.updatedAt = now;
    }
    session.activeTurnId = session.activeTurnId === turn.id ? null : session.activeTurnId;
    session.status = turn.status === 'interrupted' ? 'interrupted' : 'ready';
    session.updatedAt = now;
  }

  addEvent(event) {
    const normalized = {
      id: randomUUID(),
      ...event,
      receivedAt: event.receivedAt || new Date().toISOString(),
    };
    this.events.push(normalized);
    if (this.events.length > 1000) {
      this.events.shift();
    }

    const threadId = event.params?.threadId || event.params?.thread?.id;
    const session = threadId ? this.sessions.get(threadId) : null;
    if (session) {
      session.events.push(normalized);
      if (session.events.length > this.maxEventsPerSession) {
        session.events.shift();
      }
      session.updatedAt = normalized.receivedAt;
    }
    return normalized;
  }

  applyNotification(event) {
    this.addEvent(event);
    const params = event.params || {};

    if (event.method === 'turn/started' && params.threadId && params.turn) {
      const session = this.sessions.get(params.threadId);
      if (session && !session.turns.some((turn) => turn.id === params.turn.id)) {
        this.beginTurn(session, { turn: params.turn, input: null });
      }
    }

    if (event.method === 'item/agentMessage/delta') {
      this.appendAssistantDelta(params);
    }

    if (event.method === 'turn/completed') {
      this.completeTurn(params);
    }

    if (event.method === 'thread/status/changed') {
      const session = this.sessions.get(params.threadId);
      if (session) {
        session.runtimeStatus = params.status;
        session.updatedAt = event.receivedAt;
      }
    }

    if (event.method === 'thread/tokenUsage/updated') {
      const session = this.sessions.get(params.threadId);
      if (session) {
        session.tokenUsage = params.tokenUsage ?? params.usage ?? params;
      }
    }
  }
}

function normalizePersistedSession(session) {
  if (!session?.id && !session?.threadId) {
    return null;
  }
  const id = session.id || session.threadId;
  const now = new Date().toISOString();
  const normalized = {
    id,
    threadId: session.threadId || id,
    appId: session.appId ?? null,
    codexSessionId: session.codexSessionId || session.thread?.sessionId || id,
    name: session.name || id,
    status: session.status || 'ready',
    runtimeStatus: session.runtimeStatus,
    createdAt: session.createdAt || now,
    updatedAt: session.updatedAt || session.createdAt || now,
    cwd: session.cwd || process.cwd(),
    model: session.model ?? null,
    effort: session.effort || 'low',
    speed: session.speed || 'balanced',
    approvalPolicy: session.approvalPolicy || 'never',
    sandbox: session.sandbox || 'workspace-write',
    ephemeral: Boolean(session.ephemeral),
    thread: session.thread || { id },
    messages: Array.isArray(session.messages) ? session.messages.map(normalizePersistedMessage) : [],
    turns: Array.isArray(session.turns) ? session.turns.map(normalizePersistedTurn) : [],
    events: Array.isArray(session.events) ? session.events.slice(-500) : [],
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    tokenUsage: session.tokenUsage,
  };

  if (normalized.status === 'running' || normalized.activeTurnId) {
    normalized.status = 'ready';
    normalized.activeTurnId = null;
    normalized.messages = normalized.messages.map((message) =>
      message.status === 'streaming' ? { ...message, status: 'interrupted' } : message,
    );
    normalized.turns = normalized.turns.map((turn) =>
      turn.status === 'running' ? { ...turn, status: 'interrupted' } : turn,
    );
  }
  return normalized;
}

function normalizePersistedMessage(message) {
  return {
    id: message.id || randomUUID(),
    role: message.role || 'assistant',
    turnId: message.turnId ?? null,
    text: message.text || '',
    status: message.status,
    input: message.input ?? null,
    createdAt: message.createdAt || new Date().toISOString(),
    updatedAt: message.updatedAt,
  };
}

function normalizePersistedTurn(turn) {
  return {
    id: turn.id || randomUUID(),
    status: turn.status || 'completed',
    input: turn.input ?? null,
    startedAt: turn.startedAt || new Date().toISOString(),
    completedAt: turn.completedAt ?? null,
    assistantMessageId: turn.assistantMessageId,
    turn: turn.turn,
  };
}

function previewName(text) {
  const clean = String(text ?? '').trim();
  if (!clean) {
    return null;
  }
  return clean.length > 34 ? `${clean.slice(0, 34)}...` : clean;
}

function textFromInput(input = []) {
  return input
    .map((item) => (item.type === 'text' ? item.text : `[${item.type}]`))
    .filter(Boolean)
    .join('\n');
}
