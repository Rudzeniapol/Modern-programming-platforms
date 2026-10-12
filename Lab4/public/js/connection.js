// WebSocket-соединение, которое само восстанавливается.
//
//  — переподключение с экспоненциальной задержкой и случайным разбросом (jitter):
//    0.5 с, 1 с, 2 с, 4 с … до 10 с; разброс нужен, чтобы после перезапуска сервера
//    сотни клиентов не ломились в него в одну и ту же миллисекунду;
//  — прикладной ping каждые 5 с: браузер не видит ping/pong-фреймы протокола,
//    а «зависшее» соединение (уснул ноутбук, сменилась сеть) иначе можно не заметить
//    минутами. Нет ни одного сообщения 12 с — соединение считается мёртвым;
//  — события браузера online/offline и возвращение на вкладку ускоряют переподключение.

const PING_INTERVAL_MS = 5000;
const DEAD_AFTER_MS = 12000;
const MAX_DELAY_MS = 10000;

export class Connection extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.status = 'idle'; // connecting | open | closed
    this.attempt = 0;
    this.retryAt = null;
    this.retryTimer = null;
    this.pingTimer = null;
    this.lastMessageAt = 0;
    this.latency = null;

    window.addEventListener('online', () => this.reconnectNow());
    window.addEventListener('offline', () => this.drop());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.status === 'closed') this.reconnectNow();
    });
  }

  connect() {
    clearTimeout(this.retryTimer);
    this.retryAt = null;
    this.setStatus('connecting');

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (ws !== this.ws) return;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.setStatus('open');
      this.startPing();
    });

    ws.addEventListener('message', (event) => {
      if (ws !== this.ws) return;
      this.lastMessageAt = Date.now();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'pong' && typeof message.t === 'number') this.latency = Date.now() - message.t;
      this.dispatchEvent(new CustomEvent('message', { detail: message }));
    });

    ws.addEventListener('close', (event) => {
      if (ws !== this.ws) return;
      this.stopPing();
      this.ws = null;
      this.scheduleReconnect(event.code);
    });
  }

  scheduleReconnect(code) {
    const base = Math.min(MAX_DELAY_MS, 500 * 2 ** this.attempt);
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    this.attempt += 1;
    this.retryAt = Date.now() + delay;
    this.setStatus('closed', { code });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * Немедленно считать соединение потерянным. Ждать события close нельзя:
   * без сети закрывающее рукопожатие может тянуться десятки секунд.
   */
  drop() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    this.stopPing();
    ws.close();
    this.scheduleReconnect();
  }

  reconnectNow() {
    if (this.status === 'open' || this.status === 'connecting') return;
    this.attempt = 0;
    this.connect();
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > DEAD_AFTER_MS) {
        // Сервер молчит — соединение «полуоткрытое». Закрываем и переподключаемся.
        this.drop();
        return;
      }
      this.send({ type: 'ping', t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  stopPing() {
    clearInterval(this.pingTimer);
  }

  get isOpen() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  send(message) {
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  setStatus(status, detail = {}) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, ...detail } }));
  }
}
