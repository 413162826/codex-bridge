import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const defaultRequestTimeoutMs = 5 * 60 * 1000;

export function getCodexSpawnSpec(args = []) {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/c', 'call', 'codex.cmd', ...args],
      shell: false,
    };
  }

  return {
    command: 'codex',
    args,
    shell: false,
  };
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ cwd, timeoutMs = defaultRequestTimeoutMs } = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.stdoutBuffer = '';
    this.stderr = '';
    this.nextRequestId = 1;
    this.pendingResponses = new Map();
    this.pendingServerRequests = new Map();
    this.started = false;
    this.startPromise = null;
  }

  async ensureStarted() {
    if (this.started && this.child && !this.child.killed) {
      return;
    }

    this.startPromise ??= this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async start() {
    const spec = getCodexSpawnSpec(['app-server', '--listen', 'stdio://']);
    this.child = spawn(spec.command, spec.args, {
      cwd: this.cwd,
      shell: spec.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    this.stderr = '';
    this.stdoutBuffer = '';
    this.started = false;

    this.child.stdout?.on('data', (chunk) => {
      this.stdoutBuffer += chunk.toString('utf8');
      this.drainStdout();
    });

    this.child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.stderr += text;
      this.emit('stderr', text);
    });

    this.child.on('error', (error) => {
      this.rejectAll(error);
      this.emit('error', error);
    });

    this.child.on('close', (code) => {
      this.started = false;
      const error = new Error(`codex app-server exited with code ${code}`);
      this.rejectAll(error);
      this.emit('close', { code });
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'codex_bridge',
        title: 'Codex Bridge',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify('initialized', {});
    this.started = true;
    this.emit('ready');
  }

  stop() {
    if (!this.child || this.child.killed) {
      return;
    }
    this.child.kill();
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error('codex app-server 尚未启动'));
    }

    const id = this.nextRequestId++;
    this.write({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error(`codex app-server 请求超时：${method}`));
      }, timeoutMs);

      this.pendingResponses.set(id, {
        method,
        resolve: (message) => {
          clearTimeout(timer);
          if (message.error) {
            const error = new Error(message.error.message || `${method} failed`);
            error.details = message.error;
            reject(error);
            return;
          }
          resolve(message.result ?? {});
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  respondToServerRequest(id, { result, error } = {}) {
    if (!this.pendingServerRequests.has(String(id))) {
      const missing = new Error(`未找到待响应的 server request：${id}`);
      missing.statusCode = 404;
      throw missing;
    }

    if (error) {
      this.write({ id, error });
    } else {
      this.write({ id, result: result ?? {} });
    }
    const request = this.pendingServerRequests.get(String(id));
    this.pendingServerRequests.delete(String(id));
    this.emit('serverRequest/resolvedLocally', request);
  }

  write(message) {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  drainStdout() {
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!rawLine) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(rawLine);
      } catch (error) {
        this.emit('parseError', { rawLine, error: error.message });
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (Object.hasOwn(message, 'id') && message.method) {
      const key = String(message.id);
      this.pendingServerRequests.set(key, {
        id: message.id,
        method: message.method,
        params: message.params ?? {},
        createdAt: new Date().toISOString(),
      });
      this.emit('serverRequest', this.pendingServerRequests.get(key));
      return;
    }

    if (Object.hasOwn(message, 'id')) {
      const waiter = this.pendingResponses.get(message.id);
      if (!waiter) {
        this.emit('orphanResponse', message);
        return;
      }
      this.pendingResponses.delete(message.id);
      waiter.resolve(message);
      return;
    }

    if (message.method) {
      this.emit('notification', {
        method: message.method,
        params: message.params ?? {},
        receivedAt: new Date().toISOString(),
      });
    }
  }

  rejectAll(error) {
    for (const [id, waiter] of this.pendingResponses) {
      this.pendingResponses.delete(id);
      waiter.reject(error);
    }
  }

  getStatus() {
    return {
      started: this.started,
      pid: this.child?.pid ?? null,
      cwd: this.cwd,
      pendingResponses: this.pendingResponses.size,
      pendingServerRequests: this.pendingServerRequests.size,
      stderrTail: this.stderr.slice(-4000),
    };
  }

  listServerRequests() {
    return [...this.pendingServerRequests.values()];
  }
}
