import { randomUUID } from 'node:crypto';

export class SessionStore {
  constructor({ maxEventsPerSession = 500 } = {}) {
    this.sessions = new Map();
    this.events = [];
    this.maxEventsPerSession = maxEventsPerSession;
  }

  createSession({ thread, request, config }) {
    const now = new Date().toISOString();
    const threadId = thread.id;
    const session = {
      id: threadId,
      threadId,
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
