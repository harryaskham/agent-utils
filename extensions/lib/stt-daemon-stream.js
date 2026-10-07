// Tools STT stream protocol adapted to the existing transcription event loop.
// HTTP only; no shadow microphone, upstream credential or second speech state.
import { EventEmitter } from "node:events";
import { daemonCommand } from "./speech-daemon.js";

export function daemonSttEvent(event) {
  const item_id = event.item;
  switch (event.type) {
    case "speech_started": return { type: "input_audio_buffer.speech_started", item_id, audio_start_ms: event.audio_ms };
    case "speech_stopped": return { type: "input_audio_buffer.speech_stopped", item_id, audio_end_ms: event.audio_ms };
    case "committed": return { type: "input_audio_buffer.committed", item_id, previous_item_id: event.previous };
    case "delta": return { type: "conversation.item.input_audio_transcription.delta", item_id, delta: event.text };
    case "partial": return { type: "conversation.item.input_audio_transcription.partial", item_id, transcript: event.text };
    case "completed": return { type: "conversation.item.input_audio_transcription.completed", item_id, transcript: event.text };
    case "failed": return { type: "conversation.item.input_audio_transcription.failed", item_id, error: { message: "Daemon transcription failed" } };
    case "error": return { type: "error", error: { message: "Daemon transcription error", code: "daemon_stt_error" } };
    default: return null;
  }
}

export class DaemonSttSocket extends EventEmitter {
  static OPEN = 1;
  constructor(options = {}) {
    super();
    this.options = options;
    this.readyState = 0;
    this.session = null;
    this.cursor = 0;
    this.pending = new Map();
    this.transcripts = new Map();
    this.commitOrder = [];
    this.completed = new Map();
    this.queueBytes = 0;
    this.chain = Promise.resolve();
    this.abortController = new AbortController();
    this.pollController = null;
    this.polling = null;
  }
  async command(operation, input, extra = {}) {
    return daemonCommand("stt", operation, input, { ...this.options, signal: this.abortController.signal, ...extra });
  }
  accept(reply) {
    if (reply?.status !== "stream" || reply.session !== this.session || !Array.isArray(reply.events)) throw new Error("speech daemon: invalid STT stream receipt");
    for (const entry of reply.events) {
      if (!Number.isSafeInteger(entry.seq) || entry.seq < 1 || !entry.event || typeof entry.event.type !== "string") throw new Error("speech daemon: invalid event cursor");
      if (entry.seq > this.cursor) this.pending.set(entry.seq, entry.event);
    }
    if (this.pending.size > 4096) throw new Error("speech daemon: event buffer exceeded");
    while (this.pending.has(this.cursor + 1)) {
      const event = this.pending.get(++this.cursor);
      this.pending.delete(this.cursor);
      this.deliver(event);
    }
    return reply.closed;
  }
  deliver(event) {
    const mapped = daemonSttEvent(event);
    if (!mapped) return;
    const id = event.item || "current";
    if (event.type === "delta") {
      const text = (this.transcripts.get(id) || "") + String(event.text || "");
      if (text.length > 65536 || this.transcripts.size > 64) throw new Error("speech daemon: transcript buffer exceeded");
      this.transcripts.set(id, text);
    }
    if (event.type === "partial") mapped.transcript = (this.transcripts.get(id) || "") + String(event.text || "");
    if (event.type === "committed") {
      if (this.commitOrder.length >= 1024) throw new Error("speech daemon: pending transcript limit");
      if (!this.commitOrder.includes(id)) this.commitOrder.push(id);
    }
    if (["completed", "failed"].includes(event.type)) {
      this.transcripts.delete(id);
      if (this.commitOrder.includes(id)) {
        this.completed.set(id, mapped);
        while (this.completed.has(this.commitOrder[0])) {
          const first = this.commitOrder.shift();
          this.emit("message", JSON.stringify(this.completed.get(first)));
          this.completed.delete(first);
        }
        return;
      }
    }
    this.emit("message", JSON.stringify(mapped));
  }
  async openStream() {
    if (this.abortController.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const input = { rate: 24000, vad: this.options.vad ?? { mode: "none" } };
    for (const [key, value] of Object.entries({ provider: this.options.daemonProvider, model: this.options.model, language: this.options.language, prompt: this.options.prompt })) {
      if (value != null && value !== "") input[key] = value;
    }
    const reply = await this.command("stt.stream.open", input);
    if (reply?.status !== "stream" || !/^[A-Za-z0-9_-]{1,128}$/.test(reply.session)) throw new Error("speech daemon: invalid STT session");
    this.session = reply.session;
    this.provider = reply.provider;
    this.model = reply.model;
    if (this.abortController.signal.aborted) { await this.abortRemote(); throw new DOMException("Aborted", "AbortError"); }
    if (reply.rate !== 24000) { await this.abortRemote(); throw new Error("speech daemon: stream must accept 24 kHz PCM"); }
    this.cursor = 0;
    this.pending.clear();
    this.transcripts.clear(); this.commitOrder = []; this.completed.clear();
    this.accept(reply);
    const wasOpen = this.readyState === 1;
    this.readyState = 1;
    if (wasOpen) this.startPoll();
    return this;
  }
  startPoll() {
    const session = this.session;
    const controller = new AbortController();
    this.pollController = controller;
    this.polling = (async () => {
      while (!controller.signal.aborted && this.readyState === 1 && this.session === session) {
        const reply = await this.command("stt.stream.events", { session, after: this.cursor, wait_ms: 1000 }, { signal: AbortSignal.any([controller.signal, this.abortController.signal]), timeoutMs: 10000 });
        if (controller.signal.aborted) break;
        if (this.accept(reply)) throw new Error("speech daemon: STT stream closed");
      }
    })().catch((error) => { if (!controller.signal.aborted && !this.abortController.signal.aborted) this.fail(error); });
  }
  async stopPoll() {
    this.pollController?.abort();
    await this.polling;
    this.polling = null;
  }
  send(data) {
    if (this.readyState !== 1) throw new Error("speech daemon: STT socket closed");
    const event = JSON.parse(data);
    // The existing loop sends realtime-only settings too. This adapter owns only
    // transcription; it never forwards tools, prompts or output-audio settings.
    if (event.type === "session.update") return;
    if (!["input_audio_buffer.append", "input_audio_buffer.commit", "input_audio_buffer.clear"].includes(event.type)) throw new Error("speech daemon: unsupported STT action");
    const bytes = event.audio ? Buffer.byteLength(event.audio) : 0;
    if (bytes > 1400000 || this.queueBytes + bytes > 6 * 1024 * 1024) { this.fail(new Error("speech daemon: STT append backpressure limit")); return; }
    this.queueBytes += bytes;
    this.chain = this.chain.then(async () => {
      if (this.abortController.signal.aborted) return;
      if (event.type === "input_audio_buffer.append") {
        if (!this.session) await this.openStream();
        this.accept(await this.command("stt.stream.append", { session: this.session, after: this.cursor, audio_base64: event.audio }));
      } else {
        await this.stopPoll();
        if (!this.session) return;
        if (event.type === "input_audio_buffer.commit") {
          const reply = await this.command("stt.stream.close", { session: this.session, after: this.cursor });
          if (!this.accept(reply) || this.pending.size || this.commitOrder.length) throw new Error("speech daemon: stream closed with incomplete transcription");
          this.session = null; // next PTT append opens a fresh stream; never replay
        } else await this.abortRemote();
      }
    }).catch((error) => this.fail(error)).finally(() => { this.queueBytes -= bytes; });
  }
  async abortRemote() {
    const session = this.session;
    this.session = null;
    if (session) await daemonCommand("stt", "stt.stream.abort", { session, after: this.cursor }, { ...this.options, signal: undefined, timeoutMs: 2000 }).catch(() => {});
  }
  fail(error) {
    if (this.readyState === 3) return;
    // EventEmitter's unhandled error is fatal; a failed initial open has no
    // receive-loop listener yet. The caller still sees the rejected open.
    if (this.listenerCount("error")) this.emit("error", error);
    void this.close();
  }
  async close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.abortController.abort();
    await this.stopPoll();
    await this.abortRemote();
    this.pending.clear();
    this.transcripts.clear(); this.commitOrder = []; this.completed.clear();
    this.emit("close", 1000);
  }
}
