export class FakeQueue<T = unknown> {
  readonly messages: T[] = [];
  async send(message: T): Promise<void> {
    this.messages.push(message);
  }
  async sendBatch(messages: { body: T }[]): Promise<void> {
    for (const m of messages) this.messages.push(m.body);
  }
}
