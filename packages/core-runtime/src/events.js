export class EventBus {
  constructor({ logger = null } = {}) {
    this.listeners = new Map();
    this.logger = logger;
  }

  on(event, handler) {
    const list = this.listeners.get(event) || [];
    list.push(handler);
    this.listeners.set(event, list);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const list = this.listeners.get(event) || [];
    this.listeners.set(event, list.filter((item) => item !== handler));
  }

  emit(event, payload) {
    const list = this.listeners.get(event) || [];
    for (const handler of list) {
      // Per-listener isolation: a throwing handler must not abort the loop or
      // propagate into the emitter (e.g. the stdout data callback).
      try {
        handler(payload);
      } catch (error) {
        const log = this.logger && typeof this.logger.error === "function" ? this.logger : console;
        log.error(`EventBus listener for "${event}" threw:`, error);
      }
    }
  }
}
